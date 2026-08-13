/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The top-level Docker application: connects to the daemons, tracks state and renders the page.
 */

import React, { useEffect, useRef, useState } from 'react';

import { Alert, AlertActionCloseButton, AlertGroup } from "@patternfly/react-core/dist/esm/components/Alert";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { EmptyState, EmptyStateBody, EmptyStateFooter, EmptyStateActions, EmptyStateVariant } from "@patternfly/react-core/dist/esm/components/EmptyState";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack";
import { ExclamationCircleIcon } from '@patternfly/react-icons';
import { WithDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';
import type { EventSource, JsonObject } from 'cockpit';
import { superuser } from "superuser";

import ContainerHeader from './components/ContainerHeader.tsx';
import Containers from './components/Containers.tsx';
import Images from './components/Images.tsx';
import * as client from './lib/client.ts';
import rest, { UID_DOCKER_DESKTOP } from './lib/rest.ts';
import { debug, makeKey } from './lib/util.ts';
import { WithDockerInfo } from './lib/context.tsx';

import type { Connection } from './lib/rest.ts';
import type { ContainerStats, DockerContainer, DockerError, DockerEvent, DockerImage, ImageUse, Notification, User } from './lib/types.ts';

const _ = cockpit.gettext;

/** Monotonically increasing index for toast notifications, so that dismissing
 * one toast never collides with another one's index (which would happen when
 * the index is derived from the current list length). */
let notificationIndex = 0;

/**
 * Sort users for the dialogs and dropdowns: the system daemon first, then the
 * session user, then all remaining users by ascending name.
 *
 * @param a First user to compare
 * @param b Second user to compare
 * @returns A negative, zero or positive number ordering a before b
 */
function compareUser(a: User, b: User): number {
    if (a.uid === 0)
        return -1;
    if (b.uid === 0)
        return 1;
    if (a.uid === null)
        return -1;
    if (b.uid === null)
        return 1;
    if (a.uid === UID_DOCKER_DESKTOP)
        return -1;
    if (b.uid === UID_DOCKER_DESKTOP)
        return 1;
    return a.name.localeCompare(b.name);
}

/** The complete application state, kept in a single useState object */
interface ApplicationState {
    /**
     * Currently connected Docker daemons, one entry per user.
     *
     * Starts with dummy entries { con: null } for the system and session user
     * so that the UI waits for initialization instead of failing early; each
     * entry is replaced by a real connection once its daemon answers.
     */
    users: User[];
    /** All images across owners, keyed by their globally unique key; null while loading */
    images: Record<string, DockerImage> | null;
    /** All containers across owners, keyed by their globally unique key; null while loading */
    containers: Record<string, DockerContainer> | null;
    /** The "Show" filter of the containers card, mirrored to the URL ?container= option */
    containersFilter: "all" | "running";
    /** Streamed usage snapshots of the containers, keyed by their state key */
    containersStats: Record<string, ContainerStats>;
    /** Active text search filter, mirrored to the URL ?name= option */
    textFilter: string;
    /** Active owner filter, mirrored to the URL ?owner= option */
    ownerFilter: number | null | "all" | "user";
    /** Toast notifications shown in the top-right corner */
    notifications: Notification[];
    /** Docker daemon version reported by the last connected daemon */
    version: string;
    /** Whether SELinux is available on the host */
    selinuxAvailable: boolean;
    /** Whether the docker CLI is installed, to tell "not installed" apart from
     * "service failed" in the failure empty state; null while unknown */
    dockerInstalled: boolean | null;
}

/**
 * The top-level Docker application.
 *
 * Connects to the system and per-user Docker daemons, subscribes to their
 * event streams, keeps the images/containers state in sync and renders the
 * whole page. A single useState object holds the application state; the
 * one-shot listeners registered in the initialization effect always read
 * state through stateRef to avoid stale closures.
 */
const Application = () => {
    const [state, setState] = useState<ApplicationState>({
        users: [{ con: null, uid: 0, name: _("system") }, { con: null, uid: null, name: _("user") }, { con: null, uid: UID_DOCKER_DESKTOP, name: _("Docker desktop") }],
        images: null,
        containers: null,
        containersFilter: "all",
        containersStats: {},
        textFilter: "",
        ownerFilter: "all",
        notifications: [],
        version: '',
        selinuxAvailable: false,
        dockerInstalled: null,
    });
    // always-current snapshot of the state, so that the event handlers below
    // (which are registered once) never see a stale closure
    const stateRef = useRef(state);
    stateRef.current = state;
    // uids whose daemon connection is currently being established
    const initInFlight = useRef(new Set<number | null>());

    /**
     * Navigate to the root path with the given URL options.
     *
     * The filter values are mirrored into the URL so that they survive page
     * reloads and can be shared.
     *
     * @param options The location options to persist in the URL
     */
    const updateUrl = (options: Record<string, string>) => {
        cockpit.location.go([], options);
    };

    /**
     * Append a toast notification, assigning it the next index.
     *
     * The index is taken from a monotonically increasing counter instead of the
     * current list length, so that dismissing one notification can never
     * collide with another toast's index and remove it as well.
     *
     * @param notification The notification to show
     */
    const handleAddNotification = (notification: Notification) => {
        notification.index = notificationIndex++;
        setState(prevState => ({
            ...prevState,
            notifications: [
                ...prevState.notifications,
                notification
            ]
        }));
    };

    /**
     * Remove a toast notification with the given index from the state.
     *
     * @param notificationIndex The index of the notification to dismiss
     */
    const onDismissNotification = (notificationIndex: number | undefined) => {
        setState(prevState => ({
            ...prevState,
            notifications: prevState.notifications.filter(current => current.index !== notificationIndex)
        }));
    };

    /**
     * Update the text filter and mirror it to the URL ?name= option.
     *
     * @param value The new search term, empty to clear the filter
     */
    const onFilterChanged = (value: string) => {
        setState(prevState => ({
            ...prevState,
            textFilter: value
        }));

        const options = { ...(cockpit.location.options as Record<string, string>) };
        if (value === "")
            delete options.name;
        else
            options.name = value;
        updateUrl(options);
    };

    /**
     * Update the owner filter and mirror it to the URL ?owner= option.
     *
     * @param value The raw select value: "all", "user" or a numeric uid string
     */
    const onOwnerChanged = (value: string) => {
        const ownerFilter = value === "all" || value === "user" ? value : Number(value);
        setState(prevState => ({
            ...prevState,
            ownerFilter
        }));

        const options = { ...(cockpit.location.options as Record<string, string>) };
        if (value === "all")
            delete options.owner;
        else
            options.owner = value;
        updateUrl(options);
    };

    /**
     * Update the containers card "Show" filter and mirror it to the URL ?container= option.
     *
     * @param value The new filter: "all" or "running"
     */
    const onContainerFilterChanged = (value: "all" | "running") => {
        setState(prevState => ({
            ...prevState,
            containersFilter: value
        }));

        const options = { ...(cockpit.location.options as Record<string, string>) };
        if (value === "all")
            delete options.container;
        else
            options.container = value;
        updateUrl(options);
    };

    /**
     * Load the containers of one daemon and inspect each one in detail.
     *
     * The containers of other users are kept and only this user's containers
     * are replaced. The container list also drives which images are "used".
     *
     * @param con Connection of the daemon to load containers from
     */
    const initContainers = (con: Connection) => {
        return client.getContainers(con)
                .then(containerList => Promise.allSettled(
                    containerList.map(container => client.inspectContainer(con, container.Id))
                ))
                .then(results => {
                    // A container may be deleted between the list and the inspect
                    // calls, so skip the ones that failed instead of losing the
                    // containers of the whole user to a single error.
                    const containerDetails = results
                            .filter((result): result is PromiseFulfilledResult<DockerContainer> => result.status === "fulfilled")
                            .map(result => result.value);
                    setState(prevState => {
                        // keep/copy the containers of other users
                        const copyContainers: Record<string, DockerContainer> = {};
                        Object.entries(prevState.containers || {}).forEach(([id, container]) => {
                            if (container.uid !== con.uid)
                                copyContainers[id] = container;
                        });
                        for (const detail of containerDetails) {
                            detail.uid = con.uid;
                            detail.key = makeKey(con.uid, detail.Id);
                            detail.Name = detail.Name.replace(/^\//, "");
                            copyContainers[detail.key] = detail;
                        }

                        const users = prevState.users.map(u => u.uid === con.uid ? { ...u, containersLoaded: true } : u);
                        return { ...prevState, containers: copyContainers, users };
                    });
                    updateContainerStats(con, containerDetails);
                })
                .catch(e => console.warn("initContainers uid", con.uid, "getContainers failed:", e.toString()));
    };

    // One stats stream connection per running container, keyed by its state
    // key, so that individual streams can be started and closed. Docker only
    // exposes the stats endpoint per container, so each running container gets
    // its own connection (which can be closed independently from the daemon's
    // main connection).
    const statsStreamsRef = useRef<Record<string, Connection>>({});

    /**
     * Close the stats stream of a single container, if one is open, and drop
     * its last usage snapshot so that stopped containers do not keep showing
     * stale CPU/memory values.
     *
     * @param key State key of the container to stop streaming stats for
     */
    const closeStatsStream = (key: string) => {
        const statsCon = statsStreamsRef.current[key];
        if (statsCon) {
            statsCon.close();
            delete statsStreamsRef.current[key];
        }
        setState(prevState => {
            if (prevState.containersStats[key] === undefined)
                return prevState;
            const containersStats = { ...prevState.containersStats };
            delete containersStats[key];
            return { ...prevState, containersStats };
        });
    };

    /**
     * Open the usage statistics stream of a running container.
     *
     * Docker sends one usage snapshot per second; each snapshot is stored under
     * the container's state key so the Containers card can compute the CPU and
     * memory columns from it. Streams of containers that stopped are closed.
     *
     * @param con Connection of the daemon owning the container
     * @param id  Id of the container to stream stats of
     */
    const startStatsStream = (con: Connection, id: string) => {
        const key = makeKey(con.uid, id);
        if (statsStreamsRef.current[key])
            return;
        const statsCon = rest.connect(con.uid);
        statsStreamsRef.current[key] = statsCon;
        client.streamContainerStats(statsCon, id, (reply: JsonObject) => {
            const stat = reply as ContainerStats;
            const stat_id = stat.id;
            if (stat_id) {
                setState(prevState => ({
                    ...prevState,
                    containersStats: {
                        ...prevState.containersStats,
                        [makeKey(con.uid, stat_id)]: stat,
                    },
                }));
            }
        }).catch(ex => {
            console.warn("Stats stream of uid", con.uid, "container", id, "failed:", JSON.stringify(ex));
        })
                .finally(() => {
                    // the stream ended (daemon/container removed or socket closed);
                    // drop the tracking entry so a later start event can reopen it
                    closeStatsStream(key);
                });
    };

    /**
     * Keep the stats streams of one daemon in sync with its running containers.
     *
     * Streams are opened for every running container and closed for containers
     * that stopped, paused or were removed. The containers may be passed in
     * directly (e.g. freshly inspected) or are read from the current state.
     *
     * @param con         Connection of the daemon to manage the streams of
     * @param containers  Containers of that daemon, defaults to the current state
     */
    const updateContainerStats = (con: Connection, containers?: DockerContainer[]) => {
        const list = containers ?? Object.values(stateRef.current.containers || {}).filter(c => c.uid === con.uid);
        // the key prefix identifies the owner (see makeKey)
        const ownerPrefix = `${con.uid ?? "user"}-`;
        const runningKeys = new Set(
            list.filter(c => c.State?.Status === "running").map(c => makeKey(con.uid, c.Id))
        );
        Object.keys(statsStreamsRef.current).forEach(key => {
            if (key.startsWith(ownerPrefix) && !runningKeys.has(key))
                closeStatsStream(key);
        });
        list.forEach(c => {
            if (c.State?.Status === "running")
                startStatsStream(con, c.Id);
        });
    };

    /**
     * Reload all images of one daemon, keeping the images of other users.
     *
     * @param con Connection of the daemon to reload images from
     */
    const updateImages = (con: Connection) => {
        client.getImages(con)
                .then(reply => {
                    setState(prevState => {
                        // Copy only images that could not be deleted with this event
                        // So when event from one uid comes, only copy the other images
                        const copyImages: Record<string, DockerImage> = {};
                        Object.entries(prevState.images || {}).forEach(([Id, image]) => {
                            if (image.uid !== con.uid)
                                copyImages[Id] = image;
                        });
                        Object.entries(reply).forEach(([Id, image]) => {
                            const dockerImage = image as DockerImage;
                            dockerImage.uid = con.uid;
                            dockerImage.key = makeKey(con.uid, Id);
                            copyImages[dockerImage.key] = dockerImage;
                        });

                        const users = prevState.users.map(u => u.uid === con.uid ? { ...u, imagesLoaded: true } : u);
                        return { ...prevState, images: copyImages, users };
                    });
                })
                .catch(ex => {
                    console.warn("Failed to do updateImages for uid", con.uid, ":", JSON.stringify(ex));
                });
    };

    /**
     * Re-inspect and update a single container after a state-changing event.
     *
     * @param con Connection of the daemon owning the container
     * @param id  Id of the container to refresh
     */
    const updateContainer = (con: Connection, id: string) => {
        client.inspectContainer(con, id)
                .then(details => {
                    details.uid = con.uid;
                    details.key = makeKey(con.uid, id);
                    details.Name = details.Name.replace(/^\//, "");
                    setState(prevState => {
                        const containers = { ...prevState.containers };
                        containers[details.key] = details;
                        return { ...prevState, containers };
                    });
                })
                .catch(e => console.warn("updateContainer uid", con.uid, "inspectContainer failed:", e.toString()));
    };

    /**
     * Reload and update a single image after a state-changing event.
     *
     * @param con Connection of the daemon owning the image
     * @param id  Id of the image to refresh
     */
    const updateImage = (con: Connection, id: string) => {
        client.getImages(con, id)
                .then(reply => {
                    const image = reply[id] as DockerImage;
                    image.uid = con.uid;
                    image.key = makeKey(con.uid, id);
                    setState(prevState => {
                        const images = { ...prevState.images };
                        images[image.key] = image;
                        return { ...prevState, images };
                    });
                })
                .catch(ex => {
                    console.warn("Failed to do updateImage for uid", con.uid, ":", JSON.stringify(ex));
                });
    };

    // see https://docs.docker.com/reference/api/engine/version/v1.41/#tag/System/operation/SystemEvents

    /**
     * Handle a Docker image event, refreshing the affected images.
     *
     * Events that touch a single image (save, tag) only update that image,
     * while events that can affect many images reload the whole list.
     *
     * @param event The event stream message
     * @param con   Connection of the daemon that emitted the event
     */
    const handleImageEvent = (event: DockerEvent, con: Connection) => {
        switch (event.Action) {
        case 'save':
        case 'tag':
            updateImage(con, event.Actor.ID);
            break;
        case 'pull':
        case 'push':
        case 'untag':
        case 'delete':
        case 'import':
        case 'load':
        case 'prune':
            updateImages(con);
            break;
        default:
            console.warn('Unhandled event type ', event.Type, event.Action);
        }
    };

    /**
     * Handle a Docker container event, updating the container state.
     *
     * Events are grouped: some need no update at all, most refresh a single
     * container, destroy/remove delete the container, and prune/commit refresh
     * larger parts of the state.
     *
     * @param event The event stream message
     * @param con   Connection of the daemon that emitted the event
     */
    const handleContainerEvent = (event: DockerEvent, con: Connection) => {
        const id = event.Actor.ID;

        switch (event.Action) {
        /* The following events do not need to trigger any state updates */
        case 'attach':
        case 'copy':
        case 'detach':
        case 'exec_create':
        case 'exec_detach':
        case 'exec_start':
        case 'export':
        case 'resize':
        case 'top':
        case 'update':
            break;
        /* The following events need only to update the Container list,
         * which is also used to determine which images are in use.
         */
        case 'create':
        case 'health_status':
        case 'oom':
        case 'rename':
        case 'restart':
            updateContainer(con, id);
            break;
        /* Containers that stopped are no longer displayed with CPU/memory
         * usage, so close their stats stream.
         */
        case 'die':
        case 'kill':
        case 'stop':
        case 'pause':
            updateContainer(con, id);
            closeStatsStream(makeKey(con.uid, id));
            break;
        /* Containers that (re)started need a fresh stats stream. */
        case 'start':
        case 'unpause':
            updateContainer(con, id);
            startStatsStream(con, id);
            break;
        case 'destroy':
        case 'remove':
            closeStatsStream(makeKey(con.uid, id));
            setState(prevState => {
                const containers = { ...prevState.containers };
                delete containers[makeKey(con.uid, id)];
                return { ...prevState, containers };
            });
            break;
        case 'prune':
            initContainers(con);
            break;
        // only needs to update the Image list, this ought to be an image event
        case 'commit':
            updateImages(con);
            break;
        default:
            console.warn('Unhandled event type ', event.Type, event.Action);
        }
    };

    /**
     * Dispatch an event stream message to the container or image handler.
     *
     * @param event The event stream message
     * @param con   Connection of the daemon that emitted the event
     */
    const handleEvent = (event: DockerEvent, con: Connection) => {
        switch (event.Type) {
        case 'container':
            handleContainerEvent(event, con);
            break;
        case 'image':
            handleImageEvent(event, con);
            break;
        case 'network':
            // network connect/disconnect/create events do not change any
            // containers or images we display, so no state update is needed
            break;
        default:
            console.warn('Unhandled event type ', event.Type);
        }
    };

    /**
     * Clean up state after a daemon connection is closed.
     *
     * Removes the images, containers and user entry of the closed connection,
     * keeps the dummy null connections of other users, and resets the owner
     * filter when it pointed at the closed connection.
     *
     * @param con The connection that was closed
     */
    const cleanupAfterService = (con: Connection) => {
        debug("cleanupAfterService", con.uid, "current owner filter:", stateRef.current.ownerFilter);
        if (stateRef.current.images) {
            setState(prevState => {
                const images: Record<string, DockerImage> = {};
                Object.entries(prevState.images || {}).forEach(([id, v]) => {
                    if (v.uid !== con.uid)
                        images[id] = v;
                });
                return { ...prevState, images };
            });
        }

        if (stateRef.current.containers) {
            setState(prevState => {
                const containers: Record<string, DockerContainer> = {};
                Object.entries(prevState.containers || {}).forEach(([id, v]) => {
                    if (v.uid !== con.uid)
                        containers[id] = v;
                });
                return { ...prevState, containers };
            });
        }

        // close the stats streams of the closed connection; the key prefix
        // identifies the owner (see makeKey)
        const ownerPrefix = `${con.uid ?? "user"}-`;
        Object.keys(statsStreamsRef.current).forEach(key => {
            if (key.startsWith(ownerPrefix))
                closeStatsStream(key);
        });

        // drop the usage snapshots of the closed connection; the key prefix
        // identifies the owner (see makeKey)
        setState(prevState => {
            const containersStats: Record<string, ContainerStats> = {};
            Object.entries(prevState.containersStats || {}).forEach(([id, v]) => {
                if (!id.startsWith(ownerPrefix))
                    containersStats[id] = v;
            });
            return { ...prevState, containersStats };
        });

        // keep dummy (null) connections from other users, only remove valid ones
        setState(prevState => ({ ...prevState, users: prevState.users.filter(u => u.con === null || u.uid !== con.uid) }));

        // reset owner filter if the current filter is the closed connection
        if (con.uid === stateRef.current.ownerFilter)
            onOwnerChanged("all");
    };

    /**
     * Establish a connection to the daemon of the given user and load its data.
     *
     * Connects to the resolved docker socket (system or per-user rootless),
     * verifies it with getInfo, loads images and containers, and subscribes
     * to the event stream. The stream's finally callback runs cleanup after
     * the daemon connection closes. A failing daemon removes the user again.
     *
     * @param uid      The uid to connect as, or null for the session user
     * @param username Display name of the user for the UI
     */
    const init = async (uid: number | null, username: string) => {
        // Guard against concurrent inits of the same user (e.g. the initial
        // mount and a ?owner= navigation racing), which would open two
        // sockets and event streams that can never be cleaned up.
        if (initInFlight.current.has(uid))
            return;
        initInFlight.current.add(uid);

        debug("init uid", uid, "name", username);
        const system = uid === 0;

        let con: Connection | null = null;

        try {
            con = rest.connect(uid);
            const reply = await client.getInfo(con);
            setState(prevState => {
                const users = prevState.users.filter(u => u.uid !== uid);
                users.push({ con, uid, name: username, containersLoaded: false, imagesLoaded: false });
                // keep a nice sort order for dialogs
                users.sort(compareUser);
                debug("init uid", uid, "username", username, "new users:", users);
                return {
                    ...prevState,
                    users,
                    version: reply.Version as string,
                };
            });
        } catch (err) {
            if (!system || (err as DockerError).problem !== 'access-denied')
                console.warn("init uid", uid, "getInfo failed:", (err as Error).toString());

            setState(prevState => ({ ...prevState, users: prevState.users.filter(u => u.uid !== uid) }));
            return;
        } finally {
            initInFlight.current.delete(uid);
        }

        updateImages(con);
        initContainers(con);

        client.streamEvents(con, (message: JsonObject) => handleEvent(message as unknown as DockerEvent, con))
                .catch(e => console.error("uid", uid, "streamEvents failed:", JSON.stringify(e)))
                .finally(() => {
                    console.log("uid", uid, "docker service closed");
                    cleanupAfterService(con);
                });
    };

    /**
     * Handle navigation changes, e.g. a ?owner= option in the URL.
     *
     * Restores the text and owner filters from the location options, opens the
     * connection of the requested owner and closes connections of other users
     * so that sockets do not pile up.
     */
    const onNavigate = () => {
        const { options, path } = cockpit.location;
        // only use the root path
        if (path.length === 0) {
            if (options.name) {
                onFilterChanged(options.name as string);
            }
            if (options.container) {
                onContainerFilterChanged(options.container as "all" | "running");
            }
            if (["all", undefined].includes(options.owner as string | undefined)) {
                // disconnect all non-standard users
                setState(prevState => ({
                    ...prevState,
                    users: prevState.users.map(u => {
                        if (u.uid !== 0 && u.uid !== null && u.uid !== UID_DOCKER_DESKTOP && u.con) {
                            debug("onNavigate All: closing unused connection to", u.name);
                            u.con.close();
                            return { uid: u.uid, name: u.name, con: null };
                        } else
                            return u;
                    }),
                    ownerFilter: "all",
                }));
            } else {
                const uid = options.owner === "user" ? null : parseInt(options.owner as string);
                const user = stateRef.current.users.find(u => u.uid === uid);
                if (user) {
                    // disconnect other non-standard users, to avoid piling up connections
                    setState(prevState => ({
                        ...prevState,
                        users: prevState.users.map(u => {
                            if (u.uid !== uid && u.uid !== 0 && u.uid !== null && u.uid !== UID_DOCKER_DESKTOP && u.con) {
                                debug("onNavigate", user.name, ": closing unused connection to", u.name);
                                u.con.close();
                                return { uid: u.uid, name: u.name, con: null };
                            } else
                                return u;
                        }),
                        ownerFilter: uid === null ? "user" : uid,
                    }));
                    if (user.con === null) {
                        debug("onNavigate", user.name, ": initializing connection");
                        init(user.uid, user.name);
                    } else {
                        debug("onNavigate", user.name, ": connection already initialized");
                    }
                } else {
                    console.warn("Unknown user", options.owner, "in URL, ignoring");
                    debug("known users:", JSON.stringify(stateRef.current.users.map(u => [u.name, u.uid])));
                    // reset URL to current value
                    updateUrl({ ...(options as Record<string, string>), owner: String(stateRef.current.ownerFilter) });
                }
            }
        }
    };

    const initRef = useRef(init);
    initRef.current = init;
    const onNavigateRef = useRef(onNavigate);
    onNavigateRef.current = onNavigate;

    useEffect(() => {
        const superuserChanged = () => initRef.current(0, _("system"));
        (superuser as EventSource<{ changed: () => void }>).addEventListener("changed", superuserChanged);

        cockpit.user().then(user => {
            // Docker Desktop exposes its daemon on a socket inside the user's home,
            // so remember the home directory before we can connect to it.
            sessionStorage.setItem('DOCKER_DESKTOP_HOME', user.home);
            initRef.current(UID_DOCKER_DESKTOP, _("Docker desktop"));

            // there is no "user service" for root, ignore that
            if (user.id === 0) {
                // clear the dummy init users, otherwise UI waits forever for initialization
                setState(prevState => ({ ...prevState, users: prevState.users.filter(u => u.uid !== null) }));
                return;
            }

            cockpit.spawn(["printenv", "XDG_RUNTIME_DIR"])
                    .then(xrd => {
                        sessionStorage.setItem('XDG_RUNTIME_DIR', xrd.trim());
                        initRef.current(null, user.name || _("User"));
                    })
                    .catch(e => console.log("Could not read $XDG_RUNTIME_DIR:", e.message));
        });

        cockpit.spawn(["selinuxenabled"], { error: "ignore" })
                .then(() => setState(prevState => ({ ...prevState, selinuxAvailable: true })))
                .catch(() => setState(prevState => ({ ...prevState, selinuxAvailable: false })));

        // Check for the docker CLI so the failure empty state can tell "docker
        // is not installed" apart from "the docker service failed to connect".
        cockpit.spawn(["docker", "--version"], { err: "ignore" })
                .then(() => setState(prevState => ({ ...prevState, dockerInstalled: true })))
                .catch(() => setState(prevState => ({ ...prevState, dockerInstalled: false })));

        const locationChanged = () => onNavigateRef.current();
        cockpit.addEventListener("locationchanged", locationChanged);
        onNavigateRef.current();

        return () => {
            (superuser as EventSource<{ changed: () => void }>).removeEventListener("changed", superuserChanged);
            cockpit.removeEventListener("locationchanged", locationChanged);
        };
    }, []);

    /**
     * Jump to the docker systemd service page from the failure empty state.
     *
     * @param e The click event; only the left button is handled
     */
    const handleGoToServicePage = (e: React.MouseEvent) => {
        if (!e || e.button !== 0)
            return;
        cockpit.jump("/system/services#/docker.service");
    };

    // Show a failure empty state when no users are available, i.e. every docker
    // service failed to connect. If the docker CLI is not even installed, point
    // the user to the installation instructions instead of the service page.
    if (state.users.length === 0) {
        if (state.dockerInstalled === false) {
            return (
                <Page className="pf-m-no-sidebar">
                    <PageSection hasBodyWrapper={false}>
                        <EmptyState headingLevel="h2" icon={ExclamationCircleIcon} titleText={_("Docker is not installed")} variant={EmptyStateVariant.full}>
                            <EmptyStateBody>
                                {_("Docker is not installed on this system. Install the docker service to manage your containers here.")}{" "}
                                <Button variant="link" isInline component="a" href="https://docs.docker.com/engine/install/" target="_blank" rel="noopener noreferrer">
                                    {_("See Docker installation instructions")}
                                </Button>
                            </EmptyStateBody>
                        </EmptyState>
                    </PageSection>
                </Page>
            );
        }

        return (
            <Page className="pf-m-no-sidebar">
                <PageSection hasBodyWrapper={false}>
                    <EmptyState headingLevel="h2" icon={ExclamationCircleIcon} titleText={_("Docker service failed")} variant={EmptyStateVariant.full}>
                        <EmptyStateFooter>
                            <EmptyStateActions>
                                <Button variant="primary" onClick={handleGoToServicePage}>
                                    {_("Troubleshoot")}
                                </Button>
                            </EmptyStateActions>
                        </EmptyStateFooter>
                    </EmptyState>
                </PageSection>
            </Page>
        );
    }

    // Wait for the initial system/user connections before rendering content.
    if (state.users.find(u => u.con === null && (u.uid === 0 || u.uid === null)))
        return null;

    // Group the containers by the image key they were created from, so that
    // the Images card can show which images are still in use.
    let imageContainerList: Record<string, ImageUse[]> | null = null;
    if (state.containers !== null) {
        imageContainerList = Object.values(state.containers).reduce((acc, container) => {
            const imageKey = makeKey(container.uid, container.Image);
            if (!acc[imageKey])
                acc[imageKey] = [];
            acc[imageKey].push({
                container,
            });
            return acc;
        }, {} as Record<string, ImageUse[]>);
    }

    // While any user is still loading, the whole card shows "Loading..." instead
    // of a partial, potentially inconsistent image or container list.
    const loadingImages = state.users.find(u => u.con && !u.imagesLoaded);
    const loadingContainers = state.users.find(u => u.con && !u.containersLoaded);

    const imageList = (
        <Images
            key="imageList"
            images={loadingImages ? null : state.images}
            imageContainerList={loadingContainers ? null : imageContainerList}
            onAddNotification={handleAddNotification}
            textFilter={state.textFilter}
            ownerFilter={state.ownerFilter}
            showAll={() => {}}
            users={state.users}
        />
    );

    const containerList = (
        <Containers
            key="containerList"
            containers={loadingContainers ? null : state.containers}
            containersStats={state.containersStats}
            images={loadingImages ? null : state.images}
            filter={state.containersFilter}
            handleFilterChange={onContainerFilterChanged}
            textFilter={state.textFilter}
            ownerFilter={state.ownerFilter}
            users={state.users}
            onAddNotification={handleAddNotification}
        />
    );

    const notificationList = (
        <AlertGroup isToast>
            {state.notifications.map((notification, index) => {
                return (
                    <Alert
                        key={index}
                        title={notification.error}
                        variant={notification.type === "default" ? "info" : notification.type}
                        isLiveRegion
                        actionClose={<AlertActionCloseButton onClose={() => onDismissNotification(notification.index)} />}
                    >
                        {notification.errorDetail}
                    </Alert>
                );
            })}
        </AlertGroup>
    );

    const contextInfo = {
        selinuxAvailable: state.selinuxAvailable,
        version: state.version,
    };

    return (
        <WithDockerInfo value={contextInfo}>
            <WithDialogs>
                <Page id="overview" key="overview" className="pf-m-no-sidebar" isContentFilled>
                    {notificationList}
                    <PageSection hasBodyWrapper={false} className="content-filter">
                        <ContainerHeader
                          handleFilterChanged={onFilterChanged}
                          handleOwnerChanged={onOwnerChanged}
                          ownerFilter={state.ownerFilter}
                          textFilter={state.textFilter}
                          users={state.users}
                        />
                    </PageSection>
                    <PageSection hasBodyWrapper={false} className='ct-pagesection-mobile'>
                        <Stack hasGutter>
                            {imageList}
                            {containerList}
                        </Stack>
                    </PageSection>
                </Page>
            </WithDialogs>
        </WithDockerInfo>
    );
};

export { Application };
