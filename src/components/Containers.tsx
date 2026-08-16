/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The Containers listing card, with run-state controls and per-row actions.
 */

import React, { useEffect, useRef, useState } from 'react';

import { Badge } from "@patternfly/react-core/dist/esm/components/Badge";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider";
import { DropdownItem } from '@patternfly/react-core/dist/esm/components/Dropdown/index.js';
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect";
import { LabelGroup } from "@patternfly/react-core/dist/esm/components/Label";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { cellWidth, SortByDirection } from '@patternfly/react-table';
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';
import { ListingPanel } from 'cockpit-components-listing-panel';
import { ListingTable } from "cockpit-components-table";

import ContainerDeleteModal from './ContainerDeleteModal.tsx';
import ContainerDetails from './ContainerDetails.tsx';
import ContainerHealthLogs from './ContainerHealthLogs.tsx';
import ContainerIntegration from './ContainerIntegration.tsx';
import ContainerLogs from './ContainerLogs.tsx';
import ContainerRenameModal from './ContainerRenameModal.tsx';
import ContainerTerminal from './ContainerTerminal.tsx';
import ContainerCommitModal from './ContainerCommitModal.tsx';
import CreateStackModal from './CreateStackModal.tsx';
import ForceRemoveModal from './ForceRemoveModal.tsx';
import { ImageRunModal } from './ImageRunModal.tsx';
import PortMapModal from './PortMapModal.tsx';
import PruneUnusedContainersModal from './PruneUnusedContainersModal.tsx';
import { StackActions } from './StackActions.tsx';
import * as client from '../lib/client.ts';
import { dockerStatsToView, image_name, quote_cmdline } from '../lib/util.ts';
import { useDockerInfo } from '../lib/context.tsx';

import type { ListingTableColumnProps, ListingTableRowProps } from "cockpit-components-table";
import type { Connection, Uid } from '../lib/rest.ts';
import type { ContainerStats, DockerContainer, DockerImage, Notification, UnusedContainer, User } from '../lib/types.ts';

import '../styles/Containers.scss';

const _ = cockpit.gettext;

// The canonical docker container states in the order of the docker state
// machine, used for sorting the state column. This is independent of the
// localized display names, so that sorting works in every language.
const stateOrder: Record<string, number> = {
    created: 0,
    restarting: 1,
    running: 2,
    paused: 3,
    exited: 4,
    removing: 5,
    dead: 6,
};

/**
 * Translate a docker health check state into a localized display string.
 *
 * @param state The raw health state, e.g. "healthy" or "starting"
 * @returns The localized state, or null when there is no active health check
 */
const localize_health = (state: string | undefined) => {
    if (state === "healthy")
        return _("Healthy");
    else if (state === "unhealthy")
        return _("Unhealthy");
    else if (state === "starting")
        return _("Checking health");
    else if (!state || state === "none")
        return null;
    else
        console.error("Unexpected health check status", state);
    return null;
};

/**
 * The kebab menu in the card header offering bulk start/stop actions for the
 * listed containers and the prune-unused-containers action.
 */
const ContainerOverActions = ({ handlePruneUnusedContainers, handleStartAllContainers, handleStopAllContainers, handleShowPortMap, unusedContainers, runningContainers, stoppedContainers }: {
    handlePruneUnusedContainers: () => void,
    handleStartAllContainers: () => void,
    handleStopAllContainers: () => void,
    handleShowPortMap: () => void,
    unusedContainers: UnusedContainer[],
    runningContainers: number,
    stoppedContainers: number,
}) => {
    const actions = [
        <DropdownItem
            key="start-all-containers"
            id="start-all-containers-button"
            component="button"
            onClick={() => handleStartAllContainers()}
            isDisabled={stoppedContainers === 0}
            isAriaDisabled={stoppedContainers === 0}
        >
            {_("Start all containers")}
        </DropdownItem>,
        <DropdownItem
            key="stop-all-containers"
            id="stop-all-containers-button"
            component="button"
            onClick={() => handleStopAllContainers()}
            isDisabled={runningContainers === 0}
            isAriaDisabled={runningContainers === 0}
        >
            {_("Stop all containers")}
        </DropdownItem>,
        <Divider key="separator" />,
        <DropdownItem
            key="port-map"
            id="port-map-button"
            component="button"
            onClick={() => handleShowPortMap()}
        >
            {_("View port map")}
        </DropdownItem>,
        <Divider key="separator-prune" />,
        <DropdownItem
            key="prune-unused-containers"
            id="prune-unused-containers-button"
            component="button"
            className="pf-m-danger btn-delete"
            onClick={() => handlePruneUnusedContainers()}
            isDisabled={unusedContainers.length === 0}
            isAriaDisabled={unusedContainers.length === 0}
        >
            {_("Prune unused containers")}
        </DropdownItem>,
    ];

    return <KebabDropdown toggleButtonId="containers-actions-dropdown" position="right" dropdownItems={actions} />;
};

/**
 * Confirmation dialog removing an inactive stack, i.e. permanently deleting
 * its compose files from disk.
 */
const InactiveStackRemoveModal = ({ project, onRemove }: {
    project: string,
    onRemove: () => Promise<void>,
}) => {
    const Dialogs = useDialogs();
    const [inProgress, setInProgress] = useState(false);
    return (
        <Modal
            isOpen
            position="top"
            variant="medium"
            onClose={() => Dialogs.close()}
        >
            <ModalHeader title={cockpit.format(_("Remove stack $0?"), project)} titleIconVariant="warning" />
            <ModalBody>
                <p>{_("Removing this stack will permanently delete its docker-compose.yml and .env files. The stack cannot be started again.")}</p>
            </ModalBody>
            <ModalFooter>
                <Button
                    variant="danger"
                    isDisabled={inProgress}
                    isLoading={inProgress}
                    onClick={() => {
                        setInProgress(true);
                        onRemove().catch(() => setInProgress(false));
                    }}
                >
                    {_("Remove")}
                </Button>
                <Button variant="link" isDisabled={inProgress} onClick={() => Dialogs.close()}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

/**
 * Actions of an inactive stack: start it through docker compose, edit its files
 * or remove its directory. Starting reloads the stack list so the stack moves
 * to the containers listing once its containers appear; removing reloads it so
 * the deleted stack disappears from the list immediately.
 */
const InactiveStackActions = ({ project, uid, onAddNotification, onStackRemoved }: {
    project: string,
    uid: Uid,
    onAddNotification: (notification: Notification) => void,
    onStackRemoved: () => void,
}) => {
    const [inProgress, setInProgress] = useState(false);
    const Dialogs = useDialogs();
    const dir = `${client.getStacksDir(uid)}/${project}`;
    const superuser = client.getStacksSuperuser(uid);

    const startStack = () => {
        setInProgress(true);
        client.composeAction(dir, "up", uid)
                .catch(ex => {
                    const error = cockpit.format(_("Failed to start stack $0"), project); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                })
                .finally(() => setInProgress(false));
    };

    /**
     * Open the edit dialog, loading the stack's compose and env files.
     */
    const editStack = () => {
        Promise.all([
            cockpit.file(`${dir}/docker-compose.yml`, { superuser })
                    .read()
                    .catch(() => ""),
            cockpit.file(`${dir}/.env`, { superuser })
                    .read()
                    .catch(() => ""),
        ]).then(([compose, env]) => {
            Dialogs.show(<CreateStackModal projectName={project} initialCompose={compose} initialEnv={env} uid={uid} />);
        });
    };

    /**
     * Remove the stack directory. Inactive stacks have no containers, so only
     * the files on disk are deleted; the list is refreshed so the deleted
     * stack does not linger in the inactive stacks section.
     */
    const removeStack = (): Promise<void> => {
        return cockpit.spawn(["rm", "-rf", dir], { superuser, err: "message" })
                .then(onStackRemoved)
                .catch(ex => {
                    const error = cockpit.format(_("Failed to remove stack $0"), project); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                })
                .finally(() => Dialogs.close());
    };

    return (
        <Flex spaceItems={{ default: 'spaceItemsSm' }} flexWrap={{ default: 'nowrap' }}>
            <Button
                variant="secondary"
                size="sm"
                className="inactive-stack-start-btn"
                id={`inactive-stack-start-${project}`}
                isLoading={inProgress}
                onClick={startStack}
            >
                {_("Start")}
            </Button>
            <KebabDropdown
                toggleButtonId={`inactive-stack-actions-${project}`}
                position="right"
                dropdownItems={[
                    <DropdownItem key="edit" component="button" onClick={editStack}>
                        {_("Edit")}
                    </DropdownItem>,
                    <DropdownItem key="remove" className="pf-m-danger btn-delete" component="button" onClick={() => Dialogs.show(<InactiveStackRemoveModal project={project} onRemove={removeStack} />)}>
                        {_("Remove")}
                    </DropdownItem>,
                ]}
            />
        </Flex>
    );
};

/** A single column of the containers table, compatible with the ListingTable rows */
interface ContainerRowColumn {
    title: React.ReactNode;
    sortKey?: string | number;
    props?: Record<string, unknown>;
}

/** A single row of the containers table, as consumed by the ListingTable */
interface ContainerRow {
    expandedContent: React.ReactNode;
    columns: ContainerRowColumn[];
    initiallyExpanded: boolean;
    props: {
        key: string;
        "data-row-id": string;
        "data-started-at"?: string;
        "data-row-name": string;
        className?: string;
    };
}

/** Props for the per-row action kebab */
type ContainerActionsProps = {
    /** Connection of the container's owner daemon */
    con: Connection,
    /** The container the actions operate on */
    container: DockerContainer,
    /** Callback reporting errors as toast notifications */
    onAddNotification: (notification: Notification) => void,
    /** Images available locally, for the commit dialog */
    localImages: DockerImage[],
};

/**
 * The per-row actions: start, stop, restart, pause, resume, rename, commit
 * and delete, depending on the container's current state.
 */
const ContainerActions = ({ con, container, onAddNotification, localImages }: ContainerActionsProps) => {
    const Dialogs = useDialogs();
    const isRunning = container.State?.Status === "running";
    const isPaused = container.State?.Status === "paused";
    // Containers of a docker-compose stack are managed as a unit; renaming or
    // deleting a single container would break the stack, so those actions are
    // only offered for loose containers.
    const isStackContainer = !!container.Config?.Labels?.['com.docker.compose.project'];

    /**
     * Delete the container, offering a force-remove confirmation when it is
     * running or paused (docker refuses to remove paused containers without
     * force).
     */
    const deleteContainer = () => {
        if (container.State?.Status === "running" || container.State?.Status === "paused") {
            const handleForceRemoveContainer = () => {
                const id = container ? container.Id : "";

                return client.delContainer(con, id, true)
                        .catch(ex => {
                            const error = cockpit.format(_("Failed to force remove container $0"), container.Name); // not-covered: OS error
                            onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                        })
                        .finally(() => {
                            Dialogs.close();
                        })
                        .then(() => undefined);
            };

            Dialogs.show(<ForceRemoveModal name={container.Name} handleForceRemove={handleForceRemoveContainer} reason={_("Deleting this container will erase all data in it.")} />);
        } else {
            Dialogs.show(<ContainerDeleteModal con={con} containerWillDelete={container} onAddNotification={onAddNotification} />);
        }
    };

    /**
     * Stop the container, optionally killing it immediately when force is set.
     *
     * @param force When true the container is stopped with a zero timeout
     */
    const stopContainer = (force: boolean) => {
        const args: Record<string, number> = {};

        if (force)
            args.t = 0;
        client.postContainer(con, "stop", container.Id, args)
                .catch(ex => {
                    const error = cockpit.format(_("Failed to stop container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    /**
     * Start a stopped container.
     */
    const startContainer = () => {
        client.postContainer(con, "start", container.Id, {})
                .catch(ex => {
                    const error = cockpit.format(_("Failed to start container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    /**
     * Resume a paused container.
     */
    const resumeContainer = () => {
        client.postContainer(con, "unpause", container.Id, {})
                .catch(ex => {
                    const error = cockpit.format(_("Failed to resume container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    /**
     * Pause a running container.
     */
    const pauseContainer = () => {
        client.postContainer(con, "pause", container.Id, {})
                .catch(ex => {
                    const error = cockpit.format(_("Failed to pause container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    /**
     * Open the commit dialog to save the container as a new image.
     */
    const commitContainer = () => {
        Dialogs.show(<ContainerCommitModal con={con} container={container} localImages={localImages} />);
    };

    /**
     * Restart the container, optionally killing it immediately when force is set.
     *
     * @param force When true the container is restarted with a zero timeout
     */
    const restartContainer = (force: boolean) => {
        const args: Record<string, number> = {};

        if (force)
            args.t = 0;
        client.postContainer(con, "restart", container.Id, args)
                .catch(ex => {
                    const error = cockpit.format(_("Failed to restart container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    /**
     * Open the rename dialog, only offered for stopped containers.
     */
    const renameContainer = () => {
        if (container.State?.Status !== "running" && container.State?.Status !== "paused") {
            Dialogs.show(<ContainerRenameModal con={con} container={container} />);
        }
    };

    /**
     * Add the rename action to the kebab menu. Docker refuses to rename
     * running or paused containers, so it is only offered for stopped ones.
     */
    const addRenameAction = () => {
        if (isStackContainer)
            return;
        actions.push(
            <DropdownItem key="rename" onClick={() => renameContainer()}>
                {_("Rename")}
            </DropdownItem>
        );
    };

    const actions = [];
    if (isRunning || isPaused) {
        actions.push(
            <DropdownItem key="stop" onClick={() => stopContainer(false)}>
                {_("Stop")}
            </DropdownItem>,
            <DropdownItem key="force-stop" onClick={() => stopContainer(true)}>
                {_("Force stop")}
            </DropdownItem>,
            <DropdownItem key="restart" onClick={() => restartContainer(false)}>
                {_("Restart")}
            </DropdownItem>,
            <DropdownItem key="force-restart" onClick={() => restartContainer(true)}>
                {_("Force restart")}
            </DropdownItem>
        );

        if (!isPaused) {
            actions.push(
                <DropdownItem key="pause" onClick={() => pauseContainer()}>
                    {_("Pause")}
                </DropdownItem>
            );
        } else {
            actions.push(
                <DropdownItem key="resume" onClick={() => resumeContainer()}>
                    {_("Resume")}
                </DropdownItem>
            );
        }
    }

    if (!isRunning && !isPaused) {
        actions.push(
            <DropdownItem key="start" onClick={() => startContainer()}>
                {_("Start")}
            </DropdownItem>
        );
        addRenameAction();
    }

    actions.push(<Divider key="separator-1" />);
    actions.push(
        <DropdownItem key="commit" onClick={() => commitContainer()}>
            {_("Commit")}
        </DropdownItem>
    );

    if (!isStackContainer) {
        actions.push(<Divider key="separator-2" />);
        actions.push(
            <DropdownItem
                key="delete"
                className="pf-m-danger btn-delete"
                onClick={deleteContainer}
            >
                {_("Delete")}
            </DropdownItem>
        );
    }

    return <KebabDropdown position="right" dropdownItems={actions} />;
};

/** Props for the Containers listing component */
interface ContainersProps {
    /** All containers across owners, keyed by their globally unique key; null while loading */
    containers: Record<string, DockerContainer> | null;
    /** Streamed usage snapshots, keyed by the container's state key */
    containersStats: Record<string, ContainerStats>;
    /** All images across owners, used for the create-container dialog; null while loading */
    images: Record<string, DockerImage> | null;
    /** The "Show" filter of the card: "all" or "running" */
    filter: "all" | "running";
    /** Callback changing the "Show" filter */
    handleFilterChange: (value: "all" | "running") => void;
    /** Active text search filter from the container header */
    textFilter: string;
    /** Active owner filter from the container header */
    ownerFilter: number | null | "all" | "user";
    /** Users that own a Docker daemon */
    users: User[];
    /** Callback reporting errors to the application as toast notifications */
    onAddNotification: (notification: Notification) => void;
}

/**
 * The Containers card listing all containers of the selected owners.
 *
 * Each row shows the name, owner, CPU and memory usage and the run state, and
 * expands into Details, Integration, Logs, Console and Health check tabs.
 * The header offers a state filter, a create-container dialog and a
 * prune-unused-containers action.
 */
const Containers = ({ containers, containersStats, images, filter, handleFilterChange, textFilter, ownerFilter, users, onAddNotification }: ContainersProps) => {
    const Dialogs = useDialogs();
    const dockerInfo = useDockerInfo();
    cockpit.assert(dockerInfo, "Docker info not available");

    const [width, setWidth] = useState(0);
    const [showPruneUnusedContainersModal, setShowPruneUnusedContainersModal] = useState(false);
    const [showPortMapModal, setShowPortMapModal] = useState(false);
    const [stacks, setStacks] = useState<string[]>([]);
    const [highlightedContainers, setHighlightedContainers] = useState<Record<string, boolean>>({});
    const cardRef = useRef<HTMLDivElement>(null);
    // The last observed state of each container, to detect status changes and
    // briefly highlight the changed row like a new row.
    const containerStatesRef = useRef<Record<string, string>>({});

    // Daemon owner that this session's stacks belong to: the system daemon as
    // long as it is reachable (root or an admin via escalation), otherwise the
    // session user's rootless daemon.
    const stacksOwner: Uid = users.some(u => u.uid === 0 && u.con) ? 0 : null;

    /**
     * Refresh the list of stacks on disk. Stacks whose containers are running
     * are shown in the containers listing; the remaining (inactive) ones are
     * listed separately with a start button.
     */
    const refreshStacks = () => {
        client.listStacks(stacksOwner)
                .then(setStacks)
                .catch(ex => console.warn("listStacks failed:", ex.toString()));
    };

    useEffect(() => {
        // refresh when the daemon connections change, so the stacks end up in
        // the right (system vs. rootless) directory once it is known
        refreshStacks();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [users]);

    useEffect(() => {
        const onWindowResize = () => setWidth(cardRef.current?.clientWidth ?? 0);
        onWindowResize();
        window.addEventListener('resize', onWindowResize);
        return () => window.removeEventListener('resize', onWindowResize);
    }, []);

    // Highlight a container row in yellow when its state changes while the
    // user is watching, mirroring how new rows are animated.
    useEffect(() => {
        if (!containers)
            return;
        const changed: Record<string, boolean> = {};
        for (const key of Object.keys(containers)) {
            const status = containers[key].State?.Status ?? "";
            if (containerStatesRef.current[key] !== undefined && containerStatesRef.current[key] !== status)
                changed[key] = true;
            containerStatesRef.current[key] = status;
        }
        const changedKeys = Object.keys(changed);
        if (changedKeys.length === 0)
            return;
        setHighlightedContainers(prev => ({ ...prev, ...changed }));
        const timer = setTimeout(() => {
            setHighlightedContainers(prev => {
                const next = { ...prev };
                for (const key of changedKeys)
                    delete next[key];
                return next;
            });
        }, 4000);
        return () => clearTimeout(timer);
    }, [containers]);

    /**
     * Build the row for a single container, computing the CPU and memory
     * columns from the streamed stats and collecting the expandable tabs.
     *
     * @param container  The container to render
     * @param localImages Images available locally, for the run and integration tabs
     */
    const renderRow = (container: DockerContainer, localImages: DockerImage[] | null): ContainerRow => {
        const containerStats = containersStats[container.key];
        const image = container.Config?.Image ?? container.Image;
        let localized_health: string | null = null;

        const healthcheck = container.State?.Health?.Status; // not-covered: only when a health check is configured
        const status = container.State?.Status ?? ""; // not-covered: race condition

        let proc: React.ReactNode = "";
        let mem: React.ReactNode = "";
        if (containerStats && status === "running") {
            const view = dockerStatsToView(containerStats);
            if (view.CPU !== undefined)
                proc = <div className="ct-numeric-column">{`${view.CPU.toFixed(2)}%`}</div>;
            if (view.MemUsage !== undefined && view.MemLimit && Number.isInteger(view.MemUsage)) {
                // the primary view is how much of the container's limit is used
                const mem_pct = Math.round(view.MemUsage / view.MemLimit * 100);
                const mem_items = [
                    <span key="pct">{cockpit.format("$0%", mem_pct)}</span>,
                    <small key="abs">{cockpit.format_bytes(view.MemUsage)}</small>
                ];

                // is there a configured limit?
                if (container.HostConfig?.Memory) {
                    const limit_pct = Math.round(view.MemUsage / container.HostConfig.Memory * 100);
                    mem_items.push(
                        <small key="limit">
                            { cockpit.format(
                                _("$0% of $1 limit"),
                                limit_pct,
                                cockpit.format_bytes(container.HostConfig.Memory)) }
                        </small>
                    );
                }

                mem = <div className="container-block ct-numeric-column">{mem_items}</div>;
            }
        }

        const info_block = (
            <div className="container-block">
                <Flex className="ignore-pixels" style={{ alignItems: 'center', columnGap: "var(--pf-t--global--spacer--sm)" }}>
                    <span className="container-name">{container.Name}</span>
                </Flex>
                <small>{image}</small>
                <small>{quote_cmdline(container.Config?.Cmd)}</small>
            </div>
        );

        const containerStateClass = `ct-badge-container-${status.toLowerCase()}`;
        const containerState = status.charAt(0).toUpperCase() + status.slice(1);

        const state = [<Badge key={containerState} isRead className={containerStateClass}>{_(containerState)}</Badge>];
        if (healthcheck) {
            localized_health = localize_health(healthcheck);
            if (localized_health)
                state.push(<Badge key={healthcheck} isRead className={`ct-badge-container-${healthcheck}`}>{localized_health}</Badge>);
        }

        const user = users.find(user => user.uid === container.uid);
        cockpit.assert(user, `User not found for container uid ${container.uid}`);

        const columns: ContainerRowColumn[] = [
            { title: info_block, sortKey: container.Name ?? container.Id },
            {
                title: (container.uid === 0) ? _("system") : <div><span className="ct-grey-text">{_("user:")} </span>{user.name}</div>,
                props: { modifier: "nowrap" },
                sortKey: container.key,
            },
            { title: proc, props: { modifier: "nowrap" }, sortKey: containerStats ? dockerStatsToView(containerStats).CPU ?? -1 : -1 },
            { title: mem, props: { modifier: "nowrap" }, sortKey: containerStats ? dockerStatsToView(containerStats).MemUsage ?? -1 : -1 },
            { title: <LabelGroup isVertical>{state}</LabelGroup>, sortKey: containerState },
        ];

        columns.push({
            title: <ContainerActions con={user.con as Connection} container={container} onAddNotification={onAddNotification} localImages={localImages ?? []} />,
            props: { className: "pf-v6-c-table__action" }
        });

        const tty = !!container.Config?.Tty;

        const tabs = [];
        if (container.State && user.con !== null) {
            tabs.push({
                name: _("Details"),
                renderer: ContainerDetails,
                data: { container }
            });

            tabs.push({
                name: _("Integration"),
                renderer: ContainerIntegration,
                data: { container, localImages }
            });
            tabs.push({
                name: _("Logs"),
                renderer: ContainerLogs,
                data: {
                    containerId: container.Id,
                    containerStatus: container.State.Status,
                    width,
                    uid: container.uid,
                }
            });
            tabs.push({
                name: _("Console"),
                renderer: ContainerTerminal,
                data: {
                    con: user.con,
                    containerId: container.Id,
                    containerStatus: container.State.Status,
                    width,
                    uid: container.uid,
                    tty,
                }
            });
        }

        if (localized_health) {
            tabs.push({
                name: _("Health check"),
                renderer: ContainerHealthLogs,
                data: { container, state: localized_health }
            });
        }

        return {
            expandedContent: <ListingPanel tabRenderers={tabs} />,
            columns,
            initiallyExpanded: document.location.hash.substring(2) === container.Id,
            props: {
                key: container.key,
                "data-row-id": container.key,
                "data-started-at": container.State?.StartedAt ?? "",
                "data-row-name": `${container.uid === null ? 'user' : container.uid}-${container.Name}`,
                ...(highlightedContainers[container.key] ? { className: "ct-status-changed" } : {}),
            },
        };
    };

    const onOpenPruneUnusedContainersDialog = () => {
        setShowPruneUnusedContainersModal(true);
    };

    const onShowPortMap = () => {
        setShowPortMapModal(true);
    };

    /**
     * Apply the state, owner and text filters and sort the container keys.
     *
     * @param containers The containers to filter
     * @returns The keys of the matching containers, sorted
     */
    const filterContainers = (containers: Record<string, DockerContainer>): string[] => {
        let filtered = Object.keys(containers).filter(id => !(filter === "running") || ["running", "restarting"].includes(containers[id]?.State?.Status ?? ""));

        const filter_by_text = (lcf: string, id: string) => {
            const container = containers[id];
            const name_match = container.Name.toLowerCase().indexOf(lcf) >= 0;
            const image_match = (container.Config?.Image ?? "").toLowerCase().indexOf(lcf) >= 0;
            return name_match || image_match;
        };

        if (ownerFilter !== "all") {
            filtered = filtered.filter(id => {
                if (ownerFilter === "user")
                    return containers[id].uid === null;
                return containers[id].uid === ownerFilter;
            });
        }

        if (textFilter.length > 0) {
            const lcf = textFilter.toLowerCase();
            filtered = filtered.filter(id => filter_by_text(lcf, id));
        }

        filtered.sort((a, b) => {
            // User containers are in front of system ones
            if (containers[a].uid !== containers[b].uid)
                return (containers[a].uid === 0) ? 1 : -1;
            return containers[a].Name.localeCompare(containers[b].Name);
        });

        return filtered;
    };

    const columnTitles: ListingTableColumnProps[] = [
        { title: _("Container"), transforms: [cellWidth(20)], sortable: true } as ListingTableColumnProps,
        { title: _("Owner"), sortable: true },
        { title: _("CPU"), sortable: true, props: { className: 'ct-numeric-column' } },
        { title: _("Memory"), sortable: true, props: { className: 'ct-numeric-column' } },
        { title: _("State"), sortable: true },
        { title: "", sortable: false, props: { screenReaderText: _("Actions") } },
    ];
    const isLoaded = containers !== null;
    const unusedContainers: UnusedContainer[] = [];

    let emptyCaption = _("No containers");
    if (!isLoaded)
        emptyCaption = _("Loading...");
    else if (textFilter.length > 0)
        emptyCaption = _("No containers that match the current filter");
    else if (filter === "running")
        emptyCaption = _("No running containers");

    if (isLoaded) {
        const filtered = filterContainers(containers);

        const prune_states = ["created", "exited", "dead"];
        for (const containerid of Object.keys(containers)) {
            const container = containers[containerid];
            // Ignore running containers
            if (!prune_states.includes(container?.State?.Status ?? ""))
                continue;

            unusedContainers.push({
                id: container.Id,
                name: container.Name,
                key: container.key,
                created: container.Created ?? "",
                uid: container.uid,
            });
        }

        // Convert to the search result output
        let localImages: DockerImage[] | null = null;
        if (images) {
            localImages = Object.keys(images).map(id => {
                const img = images[id];
                img.Index = img.RepoTags?.[0] ? img.RepoTags[0].split('/')[0] : "";
                img.Name = image_name(img);
                img.toString = function imgToString(this: DockerImage) { return this.Name ?? "" };
                return img;
            });
        }

        const createContainer = () => {
            if (localImages)
                Dialogs.show(
                    <ImageRunModal
                        users={users}
                        localImages={localImages}
                        onAddNotification={onAddNotification}
                        dockerInfo={dockerInfo}
                        dialogs={Dialogs}
                    />
                );
        };

        // Group the containers by their docker-compose project, mirroring how
        // cockpit-podman groups containers into pods. Each stack gets a header
        // card; containers without a compose project stay in the plain table.
        const partitionedContainers: Record<string, string[]> = { 'no-stack': [] };
        for (const id of filtered) {
            const project = containers[id].Config?.Labels?.['com.docker.compose.project'];
            const section = project || 'no-stack';
            if (!partitionedContainers[section])
                partitionedContainers[section] = [];
            partitionedContainers[section].push(id);
        }

        // When there are stacks and no remaining loose containers, drop the
        // empty plain table (same behavior as the podman pods listing).
        if (Object.keys(partitionedContainers).length > 1 && !partitionedContainers['no-stack'].length)
            delete partitionedContainers['no-stack'];

        // Stacks on disk are only listed as inactive when they have no
        // containers at all. A stack is considered active as soon as any of its
        // containers exists, regardless of their run state or the current
        // filter, so that a partially running stack is never shown twice.
        // Compare project names case-insensitively: docker compose lowercases
        // the project directory basename, so the label (e.g. "navidrome")
        // differs from the on-disk directory name (e.g. "Navidrome").
        const activeProjects = new Set<string>();
        for (const id of Object.keys(containers)) {
            const project = containers[id].Config?.Labels?.['com.docker.compose.project'];
            if (project)
                activeProjects.add(project.toLowerCase());
        }
        const inactiveStacks = stacks.filter(project => !activeProjects.has(project.toLowerCase()));

        // Build the rows of one stack section.
        const sectionRows = (section: string) =>
            partitionedContainers[section].map(id => renderRow(containers[id], localImages)) as unknown as ListingTableRowProps[];

        const sortRows = (sortedRows: ListingTableRowProps[], direction: SortByDirection, idx: number) => {
            // CPU / Memory / States
            const isNumeric = idx === 2 || idx === 3 || idx === 4;
            const result = sortedRows.sort((a, b) => {
                let aitem = (a.columns[idx] as ContainerRowColumn).sortKey ?? (a.columns[idx] as ContainerRowColumn).title;
                let bitem = (b.columns[idx] as ContainerRowColumn).sortKey ?? (b.columns[idx] as ContainerRowColumn).title;
                // Sort the states in the order defined by the docker state machine,
                // so Running first; the sort key is the (English) status, not a
                // localized label, so the mapping works in every language.
                if (idx === 4) {
                    aitem = stateOrder[String(aitem).toLowerCase()] ?? -1;
                    bitem = stateOrder[String(bitem).toLowerCase()] ?? -1;
                }
                if (isNumeric) {
                    return (aitem as number) - (bitem as number);
                } else {
                    return String(aitem).localeCompare(String(bitem));
                }
            });
            return direction === SortByDirection.asc ? result : result.reverse();
        };

        // The containers of the current listing that the bulk start/stop
        // actions will act on, used both to enable the actions and by the
        // handlers. Stacks keep their containers grouped, so the bulk actions
        // work on the listing as a whole.
        const runningContainers = filtered.filter(id => containers[id].State?.Status === "running");
        const stoppedContainers = filtered.filter(id => ["created", "exited", "dead"].includes(containers[id].State?.Status ?? ""));

        /**
         * Start every stopped container of the current listing, reporting each
         * failure individually like the per-row actions do.
         */
        const startAllContainers = () => {
            Promise.allSettled(stoppedContainers.map(id => {
                const con = users.find(u => u.uid === containers[id].uid)?.con as Connection;
                return client.postContainer(con, "start", containers[id].Id, {});
            })).then(results => {
                results.forEach((result, i) => {
                    if (result.status === "rejected") {
                        const error = cockpit.format(_("Failed to start container $0"), containers[stoppedContainers[i]].Name); // not-covered: OS error
                        onAddNotification({ type: 'danger', error, errorDetail: (result.reason as Error).message });
                    }
                });
            });
        };

        /**
         * Stop every running container of the current listing, reporting each
         * failure individually like the per-row actions do.
         */
        const stopAllContainers = () => {
            Promise.allSettled(runningContainers.map(id => {
                const con = users.find(u => u.uid === containers[id].uid)?.con as Connection;
                return client.postContainer(con, "stop", containers[id].Id, {});
            })).then(results => {
                results.forEach((result, i) => {
                    if (result.status === "rejected") {
                        const error = cockpit.format(_("Failed to stop container $0"), containers[runningContainers[i]].Name); // not-covered: OS error
                        onAddNotification({ type: 'danger', error, errorDetail: (result.reason as Error).message });
                    }
                });
            });
        };

        const filterRunning = (
            <Toolbar>
                <ToolbarContent className="containers-containers-toolbarcontent">
                    <ToolbarItem alignSelf="center" variant="label" htmlFor="containers-containers-filter">
                        {_("Show")}
                    </ToolbarItem>
                    <ToolbarItem>
                        <FormSelect id="containers-containers-filter" value={filter} onChange={(_, value) => handleFilterChange(value as "all" | "running")}>
                            <FormSelectOption value='all' label={_("All")} />
                            <FormSelectOption value='running' label={_("Only running")} />
                        </FormSelect>
                    </ToolbarItem>
                    <Divider orientation={{ default: "vertical" }} />
                    <ToolbarItem>
                        <Button variant="secondary" key="create-new-stack-action" id="containers-containers-create-stack-btn" onClick={() => Dialogs.show(<CreateStackModal onStackCreated={refreshStacks} uid={stacksOwner} />)}>
                            {_("Create stack")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem>
                        <Button
                            variant="primary"
                            key="get-new-image-action"
                            id="containers-containers-create-container-btn"
                            isDisabled={localImages === null}
                            onClick={() => createContainer()}
                        >
                            {_("Create container")}
                        </Button>
                    </ToolbarItem>
                    <ToolbarItem>
                        <ContainerOverActions
                            unusedContainers={unusedContainers}
                            handlePruneUnusedContainers={onOpenPruneUnusedContainersDialog}
                            handleStartAllContainers={startAllContainers}
                            handleStopAllContainers={stopAllContainers}
                            handleShowPortMap={onShowPortMap}
                            runningContainers={runningContainers.length}
                            stoppedContainers={stoppedContainers.length}
                        />
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>
        );

        return (
            <Card ref={cardRef} id="containers-containers" className="containers-containers">
                <CardHeader actions={{ actions: filterRunning }}>
                    <CardTitle><Content component={ContentVariants.h1}>{_("Containers")}</Content></CardTitle>
                </CardHeader>
                <CardBody>
                    <Flex direction={{ default: 'column' }}>
                        {Object.keys(partitionedContainers)
                                .sort((a, b) => {
                                    if (a === 'no-stack') return -1;
                                    else if (b === 'no-stack') return 1;
                                    return a.localeCompare(b);
                                })
                                .map(section => {
                                    if (section === 'no-stack') {
                                        return (
                                            <ListingTable
                                                key="no-stack"
                                                variant='compact'
                                                aria-label={_("Containers")}
                                                emptyCaption={emptyCaption}
                                                columns={columnTitles}
                                                sortMethod={sortRows}
                                                rows={sectionRows(section)}
                                                sortBy={{ index: 0, direction: SortByDirection.asc }}
                                            />
                                        );
                                    }
                                    const stackContainers = partitionedContainers[section].map(id => containers[id]);
                                    const stackUser = users.find(user => user.uid === stackContainers[0]?.uid);
                                    const stackCon = stackUser?.con as Connection;
                                    return (
                                        <Card key={`table-${section}`} id={`table-${section}`} className="container-stack" isPlain>
                                            <CardHeader {...(stackCon ? { actions: { actions: <StackActions con={stackCon} containers={stackContainers} containersStats={containersStats} onAddNotification={onAddNotification} />, className: "panel-actions" } } : {})}>
                                                <CardTitle>
                                                    <Flex justifyContent={{ default: 'justifyContentFlexStart' }}>
                                                        <h3 className='stack-name'>{section}</h3>
                                                        <span>{_("stack")}</span>
                                                    </Flex>
                                                </CardTitle>
                                            </CardHeader>
                                            <ListingTable
                                                variant='compact'
                                                aria-label={cockpit.format(_("Containers of stack $0"), section)}
                                                emptyCaption={cockpit.format(_("No containers in this stack"), section)}
                                                columns={columnTitles}
                                                sortMethod={sortRows}
                                                rows={sectionRows(section)}
                                                sortBy={{ index: 0, direction: SortByDirection.asc }}
                                            />
                                        </Card>
                                    );
                                })}
                        {inactiveStacks.length > 0 &&
                            <Card className="container-inactive-stacks" isPlain>
                                <CardHeader>
                                    <CardTitle>
                                        <Content component={ContentVariants.h2}>{_("Inactive stacks")}</Content>
                                    </CardTitle>
                                </CardHeader>
                                <ListingTable
                                    variant='compact'
                                    aria-label={_("Inactive stacks")}
                                    columns={[
                                        { title: _("Name") },
                                        { title: "", props: { screenReaderText: _("Actions") } },
                                    ]}
                                    rows={inactiveStacks.map(project => ({
                                        expandedContent: null,
                                        columns: [
                                            { title: project },
                                            {
                                                title: (
                                                    <InactiveStackActions project={project} uid={stacksOwner} onAddNotification={onAddNotification} onStackRemoved={refreshStacks} />
                                                ),
                                                props: { className: "pf-v6-c-table__action" },
                                            },
                                        ],
                                        initiallyExpanded: false,
                                        props: { key: `inactive-${project}`, "data-row-id": `inactive-${project}`, "data-row-name": project },
                                    }))}
                                />
                            </Card>}
                    </Flex>
                    {showPruneUnusedContainersModal &&
                    <PruneUnusedContainersModal
                        close={() => setShowPruneUnusedContainersModal(false)}
                        unusedContainers={unusedContainers}
                        onAddNotification={onAddNotification}
                        users={users}
                    />}
                    {showPortMapModal &&
                    <PortMapModal
                        close={() => setShowPortMapModal(false)}
                        containers={containers}
                        inactiveStacks={inactiveStacks}
                        stacksOwner={stacksOwner}
                    />}
                </CardBody>
            </Card>
        );
    }

    return (
        <Card ref={cardRef} id="containers-containers" className="containers-containers">
            <CardHeader>
                <CardTitle><Content component={ContentVariants.h1}>{_("Containers")}</Content></CardTitle>
            </CardHeader>
            <CardBody>
                <Flex direction={{ default: 'column' }}>
                    <ListingTable
                        variant='compact'
                        aria-label={_("Containers")}
                        emptyCaption={emptyCaption}
                        columns={columnTitles}
                        rows={[]}
                        sortBy={{ index: 0, direction: SortByDirection.asc }}
                    />
                </Flex>
            </CardBody>
        </Card>
    );
};

export default Containers;
