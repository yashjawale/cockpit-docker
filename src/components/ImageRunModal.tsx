/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Dialog to create and run a container from an image, configuring ports,
 * volumes, resource limits and a health check.
 */

import React, { useEffect, useRef, useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { Form, FormGroup, FormSection } from "@patternfly/react-core/dist/esm/components/Form";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect";
import { InputGroup, InputGroupText } from "@patternfly/react-core/dist/esm/components/InputGroup";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { NumberInput } from "@patternfly/react-core/dist/esm/components/NumberInput";
import { Popover } from "@patternfly/react-core/dist/esm/components/Popover";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Tab, TabTitleText, Tabs } from "@patternfly/react-core/dist/esm/components/Tabs";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { ToggleGroup, ToggleGroupItem } from "@patternfly/react-core/dist/esm/components/ToggleGroup";
import { Bullseye } from "@patternfly/react-core/dist/esm/layouts/Bullseye/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { Grid, GridItem } from "@patternfly/react-core/dist/esm/layouts/Grid";
import { OutlinedQuestionCircleIcon } from '@patternfly/react-icons';
import { DynamicListForm } from 'cockpit-components-dynamic-list.jsx';
import { FormHelper } from "cockpit-components-form-helper.jsx";
import { TypeaheadSelect } from 'cockpit-components-typeahead-select';
import { debounce } from 'throttle-debounce';

import cockpit from 'cockpit';
import * as dockerNames from 'docker-names';

import { EnvVar, validateEnvVar } from './Env.tsx';
import { ErrorNotification } from './Notification.tsx';
import { PublishPort, validatePublishPort } from './PublishPort.tsx';
import { validateVolume, Volume } from './Volume.tsx';
import * as client from '../lib/client.ts';
import { type DockerInfo } from '../lib/context.tsx';
import type { DockerError, DockerImage, DynamicListItem, Notification, User } from '../lib/types.ts';
import type { Connection } from '../lib/rest.ts';
import { image_name, makeKey, quote_cmdline, unquote_cmdline, validationClear, validationDebounce } from '../lib/util.ts';

import type { JsonObject } from 'cockpit';
import type { Dialogs } from 'dialogs.jsx';
import type { TypeaheadSelectOption } from 'cockpit-components-typeahead-select';

import './ImageRunModal.scss';

const _ = cockpit.gettext;

/** Supported memory limit units and their base-1000 exponent for the API */
const units = {
    KB: {
        name: "KB",
        baseExponent: 1,
    },
    MB: {
        name: "MB",
        baseExponent: 2,
    },
    GB: {
        name: "GB",
        baseExponent: 3,
    },
} as const;

/** Validation errors of a single dynamic-list row, keyed by field name */
type RowValidation = Record<string, string>;

/** Validation errors of the whole run-image dialog */
type ImageRunValidation = {
    /** Validation errors of the port mapping rows */
    publish?: (RowValidation | undefined)[];
    /** Validation errors of the volume rows */
    volumes?: (RowValidation | undefined)[];
    /** Validation errors of the environment variable rows */
    env?: (RowValidation | undefined)[];
    /** Validation error of the container name field */
    containerName?: string;
};

/** State keys edited through the NumberInput widgets */
type NumberStateKey = "memory" | "cpuShares" | "restartTries" | "healthcheck_interval" |
                      "healthcheck_timeout" | "healthcheck_start_period" | "healthcheck_retries";

// The image typeahead is fed with the raw DockerImage objects as option values,
// which does not match the string|number value type of the patternfly select
/** An option of the image typeahead, either a selectable image or a header */
type ImageRunSelectOption = {
    key?: number;
    value: string | DockerImage;
    content: React.ReactNode;
    description?: React.ReactNode;
    isDisabled?: boolean;
    decorator?: undefined;
} | {
    key?: number;
    decorator: "header";
    content: React.ReactNode;
};

/** Props for the create-and-run container dialog */
interface ImageRunModalProps {
    /** Users that own a Docker daemon, to pick the container's owner */
    users: User[];
    /** The image to create a container from; omitted to let the user pick one */
    image?: DockerImage;
    /** Images available locally, offered in the typeahead */
    localImages: DockerImage[] | null;
    /** Callback reporting errors as toast notifications */
    onAddNotification: (notification: Notification) => void;
    /** Shared Docker daemon information, e.g. SELinux availability */
    dockerInfo: DockerInfo;
    /** Dialog host used to open and close this modal */
    dialogs: Dialogs;
}

/** All editable state of the create-and-run container dialog */
interface ImageRunModalState {
    command: string;
    containerName: string;
    entrypoint: string;
    env: (DynamicListItem | undefined)[];
    hasTTY: boolean;
    publish: (DynamicListItem | undefined)[];
    image: DockerImage | null;
    memory: number;
    cpuShares: number;
    memoryConfigure: boolean;
    cpuSharesConfigure: boolean;
    memoryUnit: 'KB' | 'MB' | 'GB';
    inProgress: boolean;
    validationFailed: ImageRunValidation;
    volumes: (DynamicListItem | undefined)[];
    restartPolicy: 'no' | 'on-failure' | 'always';
    restartTries: number;
    pullLatestImage: boolean;
    activeTabKey: number;
    owner: User;
    selectedImage: string | DockerImage;
    searchFinished: boolean;
    searchInProgress: boolean;
    searchText: string;
    imageResults: DockerImage[];
    isImageSelectOpen: boolean;
    searchByRegistry: 'all' | 'local';
    healthcheck_command: string;
    healthcheck_interval: number;
    healthcheck_timeout: number;
    healthcheck_start_period: number;
    healthcheck_retries: number;
    dialogError: string;
    dialogErrorDetail: string;
}

/**
 * Dialog to create a container from an image, and optionally run it.
 *
 * The form is split into three tabs: Details (name, owner, image typeahead,
 * command, resource limits and restart policy), Integration (port mappings,
 * volumes and environment variables) and Health check. When no image is
 * passed the user can search the registry from the typeahead.
 *
 * The initial command, entrypoint, owner and selected image are derived from
 * the passed image before any hooks run, so the state is initialized once.
 */
export const ImageRunModal = ({ users, image, localImages, dockerInfo, dialogs }: ImageRunModalProps) => {
    let command = "";
    if (image?.Command) {
        command = quote_cmdline(image.Command);
    }

    const entrypoint = quote_cmdline(image?.Entrypoint);

    const initialSelectedImage: string | DockerImage = image ? image_name(image) : "";

    const default_owner = image
        ? users.find(u => u.uid === image.uid)
        : users[0];
    cockpit.assert(default_owner, "No user available to run the container");

    const [state, _setState] = useState<ImageRunModalState>({
        command,
        containerName: dockerNames.getRandomName(),
        entrypoint,
        env: [],
        hasTTY: true,
        publish: [],
        image: image ?? null,
        memory: 512,
        cpuShares: 1024,
        memoryConfigure: false,
        cpuSharesConfigure: false,
        memoryUnit: 'MB',
        inProgress: false,
        validationFailed: {},
        volumes: [],
        restartPolicy: "no",
        restartTries: 5,
        pullLatestImage: false,
        activeTabKey: 0,
        owner: default_owner,
        /* image select */
        selectedImage: initialSelectedImage,
        searchFinished: false,
        searchInProgress: false,
        searchText: "",
        imageResults: [],
        isImageSelectOpen: false,
        searchByRegistry: 'all',
        /* health check */
        healthcheck_command: "",
        healthcheck_interval: 30,
        healthcheck_timeout: 30,
        healthcheck_start_period: 0,
        healthcheck_retries: 3,
        dialogError: "",
        dialogErrorDetail: "",
    });
    const setState = (update: Partial<ImageRunModalState> | ((prevState: ImageRunModalState) => Partial<ImageRunModalState>)) => {
        _setState(prevState => ({
            ...prevState,
            ...(typeof update === 'function' ? update(prevState) : update),
        }));
    };
    // always-current snapshot of the state, so that the async handlers
    // (search, validation, debounced input) never see a stale closure
    const stateRef = useRef(state);
    stateRef.current = state;
    const mountedRef = useRef(false);
    const onSearchTriggeredRef = useRef<(value: string) => void>(() => {});

    useEffect(() => {
        mountedRef.current = true;
        onSearchTriggeredRef.current("");
        return () => {
            mountedRef.current = false;
        };
    }, []);

    /**
     * Build the container create configuration from the current state.
     *
     * Reads the always-current state via stateRef so it can be called from
     * async handlers without seeing stale values. The returned object mirrors
     * the Docker Engine API "containers/create" body.
     *
     * @returns The create config including HostConfig
     */
    const getCreateConfig = (): JsonObject => {
        const createConfig: JsonObject = {};
        const hostConfig: JsonObject = {};

        if (stateRef.current.image) {
            createConfig.Image = stateRef.current.image.RepoTags ? stateRef.current.image.RepoTags[0] : "";
        } else {
            const selected = stateRef.current.selectedImage;
            let img = typeof selected === "string" ? selected : (selected.toString?.() ?? "");
            // Make implicit :latest
            if (!img.includes(":")) {
                img += ":latest";
            }
            createConfig.Image = img;
        }

        if (stateRef.current.command) {
            createConfig.Cmd = unquote_cmdline(stateRef.current.command);
        }

        if (stateRef.current.hasTTY) {
            createConfig.Tty = true;
            createConfig.OpenStdin = true;
        }

        if (stateRef.current.memoryConfigure && stateRef.current.memory) {
            const memorySize = Number.parseInt(String(stateRef.current.memory * (1000 ** units[stateRef.current.memoryUnit].baseExponent)));
            hostConfig.Memory = memorySize;
        }

        if (stateRef.current.cpuSharesConfigure && stateRef.current.cpuShares !== 0) {
            hostConfig.CpuShares = stateRef.current.cpuShares;
        }

        if (stateRef.current.publish.some(port => port !== undefined)) {
            const portBindings: JsonObject = {};
            stateRef.current.publish
                    .filter(port => port?.containerPort)
                    .forEach(port => {
                        const binding: JsonObject = {};
                        if (port?.hostPort !== null)
                            binding.HostPort = String(parseInt(String(port?.hostPort)));
                        if (port?.IP !== null)
                            binding.HostIp = port?.IP as string;
                        portBindings[`${parseInt(String(port?.containerPort))}/${port?.protocol}`] = [binding];
                    });
            hostConfig.PortBindings = portBindings;
        }

        if (stateRef.current.env.some(item => item !== undefined)) {
            const envs: string[] = [];
            stateRef.current.env.forEach(item => {
                if (item !== undefined && item.envKey)
                    envs.push(`${item.envKey}=${item.envValue ?? ""}`);
            });
            createConfig.Env = envs;
        }

        if (stateRef.current.volumes.some(volume => volume !== undefined)) {
            hostConfig.Binds = stateRef.current.volumes
                    .filter(volume => volume?.hostPath && volume?.containerPath)
                    .map(volume => {
                        let bind = `${volume?.hostPath}:${volume?.containerPath}:${volume?.mode}`;
                        if (volume?.selinux)
                            bind += `,${volume?.selinux}`;
                        return bind;
                    });
        }

        if (stateRef.current.restartPolicy !== "no") {
            const restartPolicy: JsonObject = { Name: stateRef.current.restartPolicy };
            if (stateRef.current.restartPolicy === "on-failure") {
                restartPolicy.MaximumRetryCount = stateRef.current.restartTries;
            }
            hostConfig.RestartPolicy = restartPolicy;
        }

        if (stateRef.current.healthcheck_command !== "") {
            createConfig.Healthcheck = {
                Test: unquote_cmdline(stateRef.current.healthcheck_command),
                Interval: stateRef.current.healthcheck_interval * 1000000000,
                Timeout: stateRef.current.healthcheck_timeout * 1000000000,
                StartPeriod: stateRef.current.healthcheck_start_period * 1000000000,
                Retries: stateRef.current.healthcheck_retries,
            };
        }

        createConfig.HostConfig = hostConfig;

        return createConfig;
    };

    /**
     * Create the container and, when runImage is set, start it.
     *
     * A container that fails to start is force-removed again so that the user
     * can fix the settings and retry without hitting a name collision.
     *
     * @param con          Connection of the chosen owner daemon
     * @param createConfig Container create configuration
     * @param runImage     Whether to start the container after creating it
     */
    const createContainer = (con: Connection, createConfig: JsonObject, runImage: boolean) => {
        const Dialogs = dialogs;
        client.createContainer(con, createConfig, stateRef.current.containerName)
                .then(reply => {
                    const containerId = (reply as JsonObject).Id as string;
                    if (runImage) {
                        client.postContainer(con, "start", containerId, {})
                                .then(() => Dialogs.close())
                                .catch(ex => {
                                    // If container failed to start remove it, so a user can fix the settings and retry and
                                    // won't get another error that the container name is already taken.
                                    client.delContainer(con, containerId, true)
                                            .then(() => {
                                                setState({
                                                    inProgress: false,
                                                    dialogError: _("Container failed to be started"),
                                                    dialogErrorDetail: cockpit.format("$0: $1", (ex as DockerError).reason, (ex as DockerError).message)
                                                });
                                            })
                                            .catch(ex => {
                                                setState({
                                                    inProgress: false,
                                                    dialogError: _("Failed to clean up container"),
                                                    dialogErrorDetail: cockpit.format("$0: $1", (ex as DockerError).reason, (ex as DockerError).message)
                                                });
                                            });
                                });
                    } else {
                        Dialogs.close();
                    }
                })
                .catch(ex => {
                    setState({
                        inProgress: false,
                        dialogError: _("Container failed to be created"),
                        dialogErrorDetail: cockpit.format("$0: $1", (ex as DockerError).reason, (ex as DockerError).message)
                    });
                });
    };

    /**
     * Validate the form, pull the image if necessary, and create the container.
     *
     * When the image does not exist locally or "pull latest image" is
     * checked, the image is pulled first while keeping the dialog open.
     *
     * @param runImage Whether to start the container after creating it
     */
    const onCreateClicked = async (runImage = false): Promise<void> => {
        if (!await validateForm())
            return;

        setState({ inProgress: true });

        const createConfig = getCreateConfig();
        const { pullLatestImage } = stateRef.current;
        const con = stateRef.current.owner.con as Connection;
        const image = createConfig.Image as string;
        let imageExists = true;

        try {
            await client.imageExists(con, image);
        } catch {
            imageExists = false;
        }

        if (imageExists && !pullLatestImage) {
            createContainer(con, createConfig, runImage);
        } else {
            // Keep the dialog open and pull the image before creating the container
            try {
                await client.pullImage(con, image);
            } catch (ex) {
                const err = ex as DockerError;
                setState({
                    inProgress: false,
                    dialogError: cockpit.format(_("Failed to pull image $0"), image),
                    dialogErrorDetail: err.reason ? cockpit.format("$0: $1", err.reason, err.message) : err.message ?? ""
                });
                return;
            }
            createContainer(con, createConfig, runImage);
        }
    };

    const onValueChanged = <K extends keyof ImageRunModalState>(key: K, value: ImageRunModalState[K]) => {
        setState({ [key]: value } as Pick<ImageRunModalState, K>);
    };

    const onPlusOne = (key: NumberStateKey) => {
        setState(state => ({ [key]: state[key] + 1 } as Pick<ImageRunModalState, NumberStateKey>));
    };

    const onMinusOne = (key: NumberStateKey) => {
        setState(state => ({ [key]: state[key] - 1 } as Pick<ImageRunModalState, NumberStateKey>));
    };

    const onNumberValue = (key: NumberStateKey, value: string, minimum = 0, is_float = false) => {
        const parseFunc = is_float ? Number.parseFloat : Number.parseInt;
        const parsed = parseFunc(value);
        onValueChanged(key, isNaN(parsed) || parsed < minimum ? minimum : parsed);
    };

    const handleTabClick = (event: React.MouseEvent<HTMLElement, MouseEvent>, tabIndex: number | string) => {
        // Prevent the form from being submitted.
        event.preventDefault();
        setState({
            activeTabKey: tabIndex as number,
        });
    };

    /**
     * Build a case-insensitive regex used to filter the image typeahead.
     *
     * Non-allowed container-name characters are stripped, and the registry
     * prefix is dropped when includeRegistry is false so that names can be
     * filtered without typing the full registry path.
     *
     * @param searchText       The text to filter by
     * @param includeRegistry  Whether the registry prefix is kept in the regex
     * @returns The compiled filter regex
     */
    const buildFilterRegex = (searchText: string, includeRegistry: boolean): RegExp => {
        // Strip out all non-allowed container image characters when filtering.
        let regexString = searchText.replace(/[^/\w_.:-]/g, "");
        // drop registry from regex to allow filtering only by container names
        if (!includeRegistry && regexString.includes('/')) {
            regexString = '/' + searchText.split('/')
                    .slice(1)
                    .join('/');
        }

        return new RegExp(regexString, 'i');
    };

    /**
     * Search the registry for images matching the given term.
     *
     * Ignores terms shorter than two characters and converts the registry
     * results into the same DockerImage format as local images. Guarded by
     * mountedRef so that late results do not update an unmounted dialog.
     *
     * @param value The search term
     */
    const onSearchTriggered = (value: string) => {
        // Do not call the SearchImage API if the input string is not at least 2 chars,
        // The comparison was done considering the fact that we miss always one letter due to delayed setState
        if (value.length < 2)
            return;

        setState({ searchFinished: false, searchInProgress: true });

        // The Docker daemon searches its default registry (Docker Hub) on our behalf
        client.searchImages(stateRef.current.owner.con as Connection, value)
                .then(reply => {
                    if (reply && mountedRef.current) {
                        // Convert the search results to the same format as local images
                        const imageResults = reply.map(image => {
                            const result: DockerImage = {
                                ...image,
                                Id: "",
                                RepoTags: [image.name],
                                RepoDigests: null,
                                Size: 0,
                                uid: stateRef.current.owner.uid,
                                key: makeKey(stateRef.current.owner.uid, image.name),
                                Name: image.name,
                                ...(image.description ? { Description: image.description } : {}),
                            };
                            result.toString = () => result.Name ?? "";
                            return result;
                        });

                        setState({
                            imageResults: imageResults || [],
                            searchFinished: true,
                            searchInProgress: false,
                            dialogError: "",
                            dialogErrorDetail: "",
                        });
                    }
                })
                .catch(reason => {
                    setState({
                        imageResults: [],
                        searchFinished: true,
                        searchInProgress: false,
                        dialogError: _("Failed to search for new images"),
                        dialogErrorDetail: reason ? cockpit.format(_("Failed to search for images: $0"), reason.message) : _("Failed to search for images."),
                    });
                });
    };
    onSearchTriggeredRef.current = onSearchTriggered;

    /**
     * Clear the selected image and reset the derived command/entrypoint fields.
     */
    const handleClearImageSelection = () => {
        // Reset command if it was prefilled
        let command = stateRef.current.command;
        if (stateRef.current.command === quote_cmdline((stateRef.current.selectedImage as DockerImage | undefined)?.Command))
            command = "";

        setState({
            selectedImage: "",
            image: null,
            isImageSelectOpen: false,
            imageResults: [],
            searchText: "",
            searchFinished: false,
            command,
            entrypoint: "",
        });
    };

    const onImageSelectToggle = (isOpen: boolean) => {
        setState({
            isImageSelectOpen: isOpen,
        });
    };

    /**
     * Handle selecting an image in the typeahead.
     *
     * Prefills the command and entrypoint fields from the selected image
     * unless a command was already entered by the user.
     *
     * @param event The originating click or keyboard event, undefined on clear
     * @param value The selected option value, a DockerImage
     */
    const handleImageSelect = (event: React.MouseEvent<Element, MouseEvent> | React.KeyboardEvent<HTMLInputElement> | undefined, value: string | number) => {
        if (event === undefined)
            return;

        const selected = value as unknown as DockerImage;
        let command = stateRef.current.command;
        if (selected.Command && !command)
            command = quote_cmdline(selected.Command);

        const entrypoint = quote_cmdline(selected?.Entrypoint);

        setState({
            selectedImage: selected,
            isImageSelectOpen: false,
            command,
            entrypoint,
            dialogError: "",
            dialogErrorDetail: "",
        });
    };

    /**
     * Handle typing in the image typeahead input and trigger a registry search.
     *
     * @param value The current input text
     */
    const handleImageSelectInput = (value: string) => {
        const trimmedValue = value.trim();
        setState({
            searchText: trimmedValue,
            // Reset searchFinished status when text input changes
            searchFinished: false,
            selectedImage: "",
        });
        onSearchTriggered(trimmedValue);
    };

    const handleImageSelectInputRef = useRef(handleImageSelectInput);
    handleImageSelectInputRef.current = handleImageSelectInput;
    const debouncedInputChanged = useRef(debounce(300, (value: string) => handleImageSelectInputRef.current(value))).current;

    /**
     * Handle selecting the container's owner radio button.
     *
     * @param event The change event of the selected radio button
     */
    const handleOwnerSelect = (event: React.FormEvent<HTMLInputElement>) => {
        const owner = users.find(u => u.name === event.currentTarget.value);
        cockpit.assert(owner, `Unknown owner "${event.currentTarget.value}"`);
        setState({
            owner,
        });
    };

    /**
     * Build the option list of the image typeahead.
     *
     * Combines locally available images with registry search results, honoring
     * the "all"/"local" search scope and hiding images of the other owner
     * (system vs session user) based on the currently selected owner.
     *
     * @returns The list of selectable options plus any search-results header
     */
    const filterImages = (): ImageRunSelectOption[] => {
        const { imageResults, searchText, searchByRegistry } = stateRef.current;
        const systemUser = isSystem();
        const input = buildFilterRegex(searchText, false);
        const results: ImageRunSelectOption[] = [];

        const matches = (image: DockerImage) => {
            if (image.uid !== undefined && image.uid === 0 && !systemUser) {
                return false;
            }
            if (image.uid !== undefined && image.uid !== 0 && systemUser) {
                return false;
            }
            return (image.Name ?? "").search(input) !== -1;
        };

        if (searchByRegistry === 'local' || searchByRegistry === 'all') {
            (localImages || [])
                    .filter(matches)
                    .forEach(image => {
                        results.push({ key: results.length, value: image, content: image.toString?.() ?? "" });
                    });
        }

        if (searchByRegistry === 'all' && imageResults.length > 0) {
            results.push({ key: results.length, decorator: "header", content: _("Search results") });
            imageResults
                    .filter(matches)
                    .forEach(image => {
                        results.push({
                            key: results.length,
                            value: image,
                            content: image.toString?.() ?? "",
                            description: image.Description,
                        });
                    });
        }

        return results;
    };

    /** Whether the currently selected owner is the system (root) daemon */
    const isSystem = () => stateRef.current.owner.uid === 0;

    /**
     * Decide whether the whole dialog form is currently invalid.
     *
     * A group is invalid when any of its rows has an error; errors of empty
     * slots are ignored because they may linger after a row was removed while
     * a debounced validation was pending.
     *
     * @param validationFailed The current validation state
     * @returns True when any field group or the container name is invalid
     */
    const isFormInvalid = (validationFailed: ImageRunValidation) => {
        function checkGroup(validation: (RowValidation | undefined)[] | undefined, values: (DynamicListItem | undefined)[]) {
            function rowHasError(row: RowValidation | undefined, idx: number) {
                // We always ignore errors for empty slots in
                // "values". Errors for these slots might show up when
                // the debounced validation runs after a row has been
                // removed.
                if (!row || !values[idx])
                    return false;

                return Object.values(row)
                        .filter(val => val) // Filter out empty/undefined properties
                        .length > 0; // If one field has error, the whole group (dynamicList) is invalid
            }
            return validation?.some(rowHasError);
        }
        // If at least one group is invalid, then the whole form is invalid
        return checkGroup(validationFailed.publish, stateRef.current.publish) ||
            checkGroup(validationFailed.volumes, stateRef.current.volumes) ||
            checkGroup(validationFailed.env, stateRef.current.env) ||
            !!validationFailed.containerName;
    };

    /**
     * Check whether the container name is already taken by an existing container.
     *
     * @param containerName The name to check
     * @returns An error message, or undefined when the name is free
     */
    const validateContainerName = async (containerName: string): Promise<string | undefined> => {
        try {
            await client.containerExists(stateRef.current.owner.con as Connection, containerName);
        } catch {
            return undefined;
        }
        return _("Name already in use");
    };

    /**
     * Validate every field group and the container name of the dialog.
     *
     * @returns True when the form is valid and creation may proceed
     */
    const validateForm = async (): Promise<boolean> => {
        const { publish, volumes, env, containerName } = stateRef.current;
        const validationFailed: ImageRunValidation = {};

        const publishValidation = publish.map(a => {
            if (a === undefined)
                return undefined;

            return {
                IP: validatePublishPort(a.IP, "IP"),
                hostPort: validatePublishPort(a.hostPort, "hostPort"),
                containerPort: validatePublishPort(a.containerPort, "containerPort"),
            };
        });
        if (publishValidation.some(entry => entry && Object.keys(entry).length > 0))
            validationFailed.publish = publishValidation;

        const volumesValidation = volumes.map(a => {
            if (a === undefined)
                return undefined;

            return {
                hostPath: validateVolume(a.hostPath, "hostPath"),
                containerPath: validateVolume(a.containerPath, "containerPath"),
            };
        });
        if (volumesValidation.some(entry => entry && Object.keys(entry).length > 0))
            validationFailed.volumes = volumesValidation;

        const envValidation = env.map(a => {
            if (a === undefined)
                return undefined;

            return {
                envKey: validateEnvVar(String(a.envKey ?? ""), "envKey"),
                envValue: validateEnvVar(String(a.envValue ?? ""), "envValue"),
            };
        });
        if (envValidation.some(entry => entry && Object.keys(entry).length > 0))
            validationFailed.env = envValidation;

        const containerNameValidation = await validateContainerName(containerName);

        if (containerNameValidation)
            validationFailed.containerName = containerNameValidation;

        setState({ validationFailed });

        return !isFormInvalid(validationFailed);
    };

    /**
     * Update the validation state of one dynamic-list form (ports, volumes or env).
     *
     * @param key   Which dynamic form of the dialog is being updated
     * @param value An array of per-row validation errors; the index of each
     *              entry correlates with the row number of the dynamic list
     */
    const dynamicListOnValidationChange = (key: "publish" | "volumes" | "env", value: (RowValidation | undefined)[]) => {
        const validationFailedDelta = { ...stateRef.current.validationFailed };

        validationFailedDelta[key] = value;

        if (validationFailedDelta[key]?.every(a => a === undefined))
            delete validationFailedDelta[key];

        onValueChanged('validationFailed', validationFailedDelta);
    };

    const Dialogs = dialogs;
    const { selinuxAvailable } = dockerInfo;
    const dialogValues = state;
    const { activeTabKey, owner, selectedImage } = state;

    let imageListOptions: ImageRunSelectOption[] = [];
    if (!image) {
        imageListOptions = filterImages();
    }

    const localImage = state.image || (selectedImage !== "" && typeof selectedImage !== "string" &&
        localImages?.some(img => img.Id === selectedImage.Id)
        ? selectedImage
        : null) || null;

    // Add the search component
    const footer = (
        <ToggleGroup className='image-search-footer' aria-label={_("Search in")}>
            <ToggleGroupItem
 text={_("All")} key='all' isSelected={state.searchByRegistry === 'all'} onChange={(ev) => {
     ev.stopPropagation();
     setState({ searchByRegistry: 'all' });
 }}
                // Ignore SelectToggle's touchstart's default behaviour
                onTouchStart={ev => ev.stopPropagation()}
            />
            <ToggleGroupItem
 text={_("Local")} key='local' isSelected={state.searchByRegistry === 'local'} onChange={(ev) => {
     ev.stopPropagation();
     setState({ searchByRegistry: 'local' });
 }}
                onTouchStart={ev => ev.stopPropagation()}
            />
        </ToggleGroup>
    );

    const spinnerOptions: ImageRunSelectOption[] = (
        state.searchInProgress
            ? [{ value: "_searching", content: <Bullseye><Spinner size="lg" /></Bullseye>, isDisabled: true }]
            : []
    );

    /* ignore Enter key, it otherwise opens the first popover help; this clears
         * the search input and is still irritating from other elements like check boxes */
    const defaultBody = (
        <Form onKeyDown={e => e.key === 'Enter' && e.preventDefault()}>
            {state.dialogError && <ErrorNotification errorMessage={state.dialogError} errorDetail={state.dialogErrorDetail} />}
            <FormGroup id="image-name-group" fieldId='run-image-dialog-name' label={_("Name")} className="ct-m-horizontal">
                <TextInput
 id='run-image-dialog-name'
                        className="image-name"
                        placeholder={_("Container name")}
                        validated={dialogValues.validationFailed.containerName ? "error" : "default"}
                        value={dialogValues.containerName}
                        onChange={(_event, value) => {
                            validationClear(dialogValues.validationFailed as unknown as Record<string, string>, "containerName", (value) => onValueChanged("validationFailed", value as unknown as ImageRunValidation));
                            validationDebounce(async () => {
                                const delta = await validateContainerName(value);
                                if (delta)
                                    onValueChanged("validationFailed", { ...dialogValues.validationFailed, containerName: delta });
                            });
                            onValueChanged('containerName', value);
                        }}
                />
                <FormHelper helperTextInvalid={dialogValues.validationFailed.containerName} />
            </FormGroup>
            <Tabs activeKey={activeTabKey} onSelect={handleTabClick}>
                <Tab eventKey={0} title={<TabTitleText>{_("Details")}</TabTitleText>}>
                    <FormSection className="pf-m-horizontal">
                        {users.length > 1 &&
                        <FormGroup
isInline hasNoPaddingTop fieldId='run-image-dialog-owner' label={_("Owner")}
                                    labelHelp={
                                        <Popover
aria-label={_("Owner help")}
                                            enableFlip
                                            bodyContent={
                                                <>
                                                    <Content>
                                                        <Content component={ContentVariants.h4}>{_("System")}</Content>
                                                        <Content component="ul">
                                                            <Content component="li">
                                                                {_("Ideal for running services")}
                                                            </Content>
                                                            <Content component="li">
                                                                {_("Resource limits can be set")}
                                                            </Content>
                                                            <Content component="li">
                                                                {_("Ports under 1024 can be mapped")}
                                                            </Content>
                                                        </Content>
                                                    </Content>
                                                    <Content>
                                                        <Content component={ContentVariants.h4}>{_("User")}</Content>
                                                        <Content component="ul">
                                                            <Content component="li">
                                                                {_("Ideal for development")}
                                                            </Content>
                                                            <Content component="li">
                                                                {_("Restricted by user account permissions")}
                                                            </Content>
                                                        </Content>
                                                    </Content>
                                                </>
                                            }
                                        >
                                            <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
                                        </Popover>
                                    }
                        >
                            {users.map(user => (
                                <Radio
                                            key={user.name}
                                            name="run-image-dialog-owner"
                                            value={user.name}
                                            label={user.uid === 0 ? _("System") : cockpit.format("$0 $1", _("User:"), user.name)}
                                            id={`run-image-dialog-owner-${user.name}`}
                                            isChecked={owner === user}
                                            onChange={handleOwnerSelect}
                                />))}
                        </FormGroup>}
                        <FormGroup
 fieldId="create-image-image-select-typeahead" label={_("Image")}
 {...(!image
     ? {
         labelHelp: (
             <Popover
aria-label={_("Image selection help")}
                                            enableFlip
                                            bodyContent={
                                                <Flex direction={{ default: 'column' }}>
                                                    <FlexItem>{_("host[:port]/[user]/container[:tag]")}</FlexItem>
                                                    <FlexItem>{cockpit.format(_("Example: $0"), "docker.io/library/busybox")}</FlexItem>
                                                    <FlexItem>{cockpit.format(_("Searching: $0"), "docker.io/busybox")}</FlexItem>
                                                </Flex>
                                            }
             >
                 <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
             </Popover>
         )
     }
     : {})}
                        >
                            <TypeaheadSelect
                                    toggleProps={{ id: 'create-image-image' }}
                                    isScrollable
                                    isCreatable
                                    createOptionMessage={value => cockpit.format(_("Use image $0"), value)}
                                    noOptionsFoundMessage={_("No images found")}
                                    noOptionsAvailableMessage={_("No images found")}
                                    selected={selectedImage}
                                    selectedIsTrusted
                                    placeholder={_("Search string or container location")}
                                    onSelect={handleImageSelect}
                                    onClearSelection={handleClearImageSelection}
                                    onInputChange={value => debouncedInputChanged(value)}
                                    isDisabled={!!image}
                                    // We do our own filtering when producing imageListOptions
                                    filterFunction={(_filterValue, options) => options}
                                    selectOptions={[...imageListOptions, ...spinnerOptions] as unknown as TypeaheadSelectOption[]}
                                    footer={footer}
                            />
                        </FormGroup>

                        {(image || localImage) &&
                        <FormGroup fieldId="run-image-dialog-pull-latest-image">
                            <Checkbox
 isChecked={state.pullLatestImage} id="run-image-dialog-pull-latest-image"
                                        onChange={(_event, value) => onValueChanged('pullLatestImage', value)} label={_("Pull latest image")}
                            />
                        </FormGroup>}

                        {dialogValues.entrypoint &&
                        <FormGroup fieldId='run-image-dialog-entrypoint' hasNoPaddingTop label={_("Entrypoint")}>
                            <Content component="p" id="run-image-dialog-entrypoint">{dialogValues.entrypoint}</Content>
                        </FormGroup>}

                        <FormGroup fieldId='run-image-dialog-command' label={_("Command")}>
                            <TextInput
id='run-image-dialog-command'
                                    value={dialogValues.command || ''}
                                    onChange={(_event, value) => onValueChanged('command', value)}
                            />
                        </FormGroup>

                        <FormGroup fieldId="run=image-dialog-tty">
                            <Checkbox
 id="run-image-dialog-tty"
                                    isChecked={state.hasTTY}
                                    label={_("With terminal")}
                                    onChange={(_event, checked) => onValueChanged('hasTTY', checked)}
                            />
                        </FormGroup>

                        <FormGroup fieldId='run-image-dialog-memory' label={_("Memory limit")}>
                            <Flex alignItems={{ default: 'alignItemsCenter' }} className="ct-input-group-spacer-sm modal-run-limiter" id="run-image-dialog-memory-limit">
                                <Checkbox
 id="run-image-dialog-memory-limit-checkbox"
                                        isChecked={state.memoryConfigure}
                                        onChange={(_event, checked) => onValueChanged('memoryConfigure', checked)}
                                />
                                <NumberInput
                                        value={dialogValues.memory}
                                        id="run-image-dialog-memory"
                                        min={0}
                                        isDisabled={!state.memoryConfigure}
                                        onClick={() => !state.memoryConfigure && onValueChanged('memoryConfigure', true)}
                                        onPlus={() => onPlusOne('memory')}
                                        onMinus={() => onMinusOne('memory')}
                                        minusBtnAriaLabel={_("Decrease memory")}
                                        plusBtnAriaLabel={_("Increase memory")}
                                        onChange={ev => onNumberValue('memory', ev.currentTarget.value, 0, true)}
                                />
                                <FormSelect
 id='memory-unit-select'
                                        aria-label={_("Memory unit")}
                                        value={state.memoryUnit}
                                        isDisabled={!state.memoryConfigure}
                                        className="dialog-run-form-select"
                                        onChange={(_event, value) => onValueChanged('memoryUnit', value as ImageRunModalState['memoryUnit'])}
                                >
                                    <FormSelectOption value={units.KB.name} key={units.KB.name} label={_("KB")} />
                                    <FormSelectOption value={units.MB.name} key={units.MB.name} label={_("MB")} />
                                    <FormSelectOption value={units.GB.name} key={units.GB.name} label={_("GB")} />
                                </FormSelect>
                            </Flex>
                        </FormGroup>

                        {isSystem() &&
                        <FormGroup
                                    fieldId='run-image-cpu-priority'
                                    label={_("CPU shares")}
                                    labelHelp={
                                        <Popover
aria-label={_("CPU Shares help")}
                                            enableFlip
                                            bodyContent={_("CPU shares determine the priority of running containers. Default priority is 1024. A higher number prioritizes this container. A lower number decreases priority.")}
                                        >
                                            <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
                                        </Popover>
                                    }
                        >
                            <Flex alignItems={{ default: 'alignItemsCenter' }} className="ct-input-group-spacer-sm modal-run-limiter" id="run-image-dialog-cpu-priority">
                                <Checkbox
 id="run-image-dialog-cpu-priority-checkbox"
                                            isChecked={state.cpuSharesConfigure}
                                            onChange={(_event, checked) => onValueChanged('cpuSharesConfigure', checked)}
                                />
                                <NumberInput
                                            id="run-image-cpu-priority"
                                            value={dialogValues.cpuShares}
                                            onClick={() => !state.cpuSharesConfigure && onValueChanged('cpuSharesConfigure', true)}
                                            min={2}
                                            max={262144}
                                            isDisabled={!state.cpuSharesConfigure}
                                            onPlus={() => onPlusOne('cpuShares')}
                                            onMinus={() => onMinusOne('cpuShares')}
                                            minusBtnAriaLabel={_("Decrease CPU shares")}
                                            plusBtnAriaLabel={_("Increase CPU shares")}
                                            onChange={ev => onNumberValue('cpuShares', ev.currentTarget.value, 2)}
                                />
                            </Flex>
                        </FormGroup>}
                        <Grid hasGutter md={6} sm={3}>
                            <GridItem>
                                <FormGroup
fieldId='run-image-dialog-restart-policy' label={_("Restart policy")}
                                        labelHelp={
                                            <Popover
aria-label={_("Restart policy help")}
                                                enableFlip
                                                bodyContent={_("Restart policy to follow when containers exit.")}
                                            >
                                                <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
                                            </Popover>
                                        }
                                >
                                    <FormSelect
id="run-image-dialog-restart-policy"
                                            aria-label={_("Restart policy help")}
                                            value={dialogValues.restartPolicy}
                                            onChange={(_event, value) => onValueChanged('restartPolicy', value as ImageRunModalState['restartPolicy'])}
                                    >
                                        <FormSelectOption value='no' key='no' label={_("No")} />
                                        <FormSelectOption value='on-failure' key='on-failure' label={_("On failure")} />
                                        <FormSelectOption value='always' key='always' label={_("Always")} />
                                    </FormSelect>
                                </FormGroup>
                            </GridItem>
                            {dialogValues.restartPolicy === "on-failure" &&
                            <GridItem>
                                <FormGroup
fieldId='run-image-dialog-restart-retries'
                                            label={_("Maximum retries")}
                                >
                                    <NumberInput
                                                id="run-image-dialog-restart-retries"
                                                value={dialogValues.restartTries}
                                                min={1}
                                                max={65535}
                                                widthChars={5}
                                                minusBtnAriaLabel={_("Decrease maximum retries")}
                                                plusBtnAriaLabel={_("Increase maximum retries")}
                                                onMinus={() => onMinusOne('restartTries')}
                                                onPlus={() => onPlusOne('restartTries')}
                                                onChange={ev => onNumberValue('restartTries', ev.currentTarget.value, 1)}
                                    />
                                </FormGroup>
                            </GridItem>}
                        </Grid>
                    </FormSection>
                </Tab>
                <Tab eventKey={1} title={<TabTitleText>{_("Integration")}</TabTitleText>} id="create-image-dialog-tab-integration">
                    <FormSection>
                        <DynamicListForm
                                id='run-image-dialog-publish'
                                emptyStateString={_("No ports exposed")}
                                formclass='publish-port-form'
                                label={_("Port mapping")}
                                actionLabel={_("Add port mapping")}
                                {...(dialogValues.validationFailed.publish ? { validationFailed: dialogValues.validationFailed.publish } : {})}
                                onValidationChange={value => dynamicListOnValidationChange('publish', value)}
                                onChange={value => onValueChanged('publish', value)}
                                default={{ IP: null, containerPort: null, hostPort: null, protocol: 'tcp' }}
                                itemcomponent={PublishPort}
                        />
                        <DynamicListForm
                                id='run-image-dialog-volume'
                                emptyStateString={_("No volumes specified")}
                                formclass='volume-form'
                                label={_("Volumes")}
                                actionLabel={_("Add volume")}
                                {...(dialogValues.validationFailed.volumes ? { validationFailed: dialogValues.validationFailed.volumes } : {})}
                                onValidationChange={value => dynamicListOnValidationChange('volumes', value)}
                                onChange={value => onValueChanged('volumes', value)}
                                default={{ containerPath: null, hostPath: null, mode: 'rw' }}
                                options={{ selinuxAvailable }}
                                itemcomponent={Volume}
                        />

                        <DynamicListForm
                                id='run-image-dialog-env'
                                emptyStateString={_("No environment variables specified")}
                                formclass='env-form'
                                label={_("Environment variables")}
                                actionLabel={_("Add variable")}
                                {...(dialogValues.validationFailed.env ? { validationFailed: dialogValues.validationFailed.env } : {})}
                                onValidationChange={value => dynamicListOnValidationChange('env', value)}
                                onChange={value => onValueChanged('env', value)}
                                default={{ envKey: null, envValue: null }}
                                helperText={_("Paste one or more lines of key=value pairs into any field for bulk import")}
                                itemcomponent={EnvVar}
                        />
                    </FormSection>
                </Tab>
                <Tab eventKey={2} title={<TabTitleText>{_("Health check")}</TabTitleText>} id="create-image-dialog-tab-healthcheck">
                    <FormSection className="pf-m-horizontal">
                        <FormGroup fieldId='run-image-dialog-healthcheck-command' label={_("Command")}>
                            <TextInput
id='run-image-dialog-healthcheck-command'
                                    value={dialogValues.healthcheck_command || ''}
                                    onChange={(_event, value) => onValueChanged('healthcheck_command', value)}
                            />
                        </FormGroup>

                        <FormGroup
fieldId='run-image-healthcheck-interval' label={_("Interval")}
                                labelHelp={
                                    <Popover
aria-label={_("Health check interval help")}
                                        enableFlip
                                        bodyContent={_("Interval how often health check is run.")}
                                    >
                                        <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
                                    </Popover>
                                }
                        >
                            <InputGroup>
                                <NumberInput
                                        id="run-image-healthcheck-interval"
                                        value={dialogValues.healthcheck_interval}
                                        min={0}
                                        max={262144}
                                        widthChars={6}
                                        minusBtnAriaLabel={_("Decrease interval")}
                                        plusBtnAriaLabel={_("Increase interval")}
                                        onMinus={() => onMinusOne('healthcheck_interval')}
                                        onPlus={() => onPlusOne('healthcheck_interval')}
                                        onChange={ev => onNumberValue('healthcheck_interval', ev.currentTarget.value)}
                                />
                                <InputGroupText isPlain>{_("seconds")}</InputGroupText>
                            </InputGroup>
                        </FormGroup>
                        <FormGroup
fieldId='run-image-healthcheck-timeout' label={_("Timeout")}
                                labelHelp={
                                    <Popover
aria-label={_("Health check timeout help")}
                                        enableFlip
                                        bodyContent={_("The maximum time allowed to complete the health check before an interval is considered failed.")}
                                    >
                                        <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
                                    </Popover>
                                }
                        >
                            <InputGroup>
                                <NumberInput
                                        id="run-image-healthcheck-timeout"
                                        value={dialogValues.healthcheck_timeout}
                                        min={0}
                                        max={262144}
                                        widthChars={6}
                                        minusBtnAriaLabel={_("Decrease timeout")}
                                        plusBtnAriaLabel={_("Increase timeout")}
                                        onMinus={() => onMinusOne('healthcheck_timeout')}
                                        onPlus={() => onPlusOne('healthcheck_timeout')}
                                        onChange={ev => onNumberValue('healthcheck_timeout', ev.currentTarget.value)}
                                />
                                <InputGroupText isPlain>{_("seconds")}</InputGroupText>
                            </InputGroup>
                        </FormGroup>
                        <FormGroup
fieldId='run-image-healthcheck-start-period' label={_("Start period")}
                                labelHelp={
                                    <Popover
aria-label={_("Health check start period help")}
                                        enableFlip
                                        bodyContent={_("The initialization time needed for a container to bootstrap.")}
                                    >
                                        <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
                                    </Popover>
                                }
                        >
                            <InputGroup>
                                <NumberInput
                                        id="run-image-healthcheck-start-period"
                                        value={dialogValues.healthcheck_start_period}
                                        min={0}
                                        max={262144}
                                        widthChars={6}
                                        minusBtnAriaLabel={_("Decrease start period")}
                                        plusBtnAriaLabel={_("Increase start period")}
                                        onMinus={() => onMinusOne('healthcheck_start_period')}
                                        onPlus={() => onPlusOne('healthcheck_start_period')}
                                        onChange={ev => onNumberValue('healthcheck_start_period', ev.currentTarget.value)}
                                />
                                <InputGroupText isPlain>{_("seconds")}</InputGroupText>
                            </InputGroup>
                        </FormGroup>
                        <FormGroup
fieldId='run-image-healthcheck-retries' label={_("Retries")}
                                labelHelp={
                                    <Popover
aria-label={_("Health check retries help")}
                                        enableFlip
                                        bodyContent={_("The number of retries allowed before a healthcheck is considered to be unhealthy.")}
                                    >
                                        <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
                                    </Popover>
                                }
                        >
                            <NumberInput
                                    id="run-image-healthcheck-retries"
                                    value={dialogValues.healthcheck_retries}
                                    min={0}
                                    max={999}
                                    widthChars={3}
                                    minusBtnAriaLabel={_("Decrease retries")}
                                    plusBtnAriaLabel={_("Increase retries")}
                                    onMinus={() => onMinusOne('healthcheck_retries')}
                                    onPlus={() => onPlusOne('healthcheck_retries')}
                                    onChange={ev => onNumberValue('healthcheck_retries', ev.currentTarget.value)}
                            />
                        </FormGroup>
                    </FormSection>
                </Tab>
            </Tabs>
        </Form>
    );

    const isDisabled = (!image && selectedImage === "") || isFormInvalid(dialogValues.validationFailed) || state.inProgress;

    return (
        <Modal
 isOpen
                position="top" variant="medium"
                onClose={() => Dialogs.close()}
                // TODO: still not ideal on chromium https://github.com/patternfly/patternfly-react/issues/6471
                onEscapePress={() => {
                    if (state.isImageSelectOpen) {
                        onImageSelectToggle(false);
                    } else {
                        Dialogs.close();
                    }
                }}
        >
            <ModalHeader title={_("Create container")} />
            <ModalBody>
                {defaultBody}
            </ModalBody>
            <ModalFooter>
                <Button
 variant='primary' id="create-image-create-run-btn" onClick={() => onCreateClicked(true)}
                        isDisabled={isDisabled} isLoading={state.inProgress}
                >
                    {_("Create and run")}
                </Button>
                <Button
 variant='secondary' id="create-image-create-btn" onClick={() => onCreateClicked(false)}
                        isDisabled={isDisabled} isLoading={state.inProgress}
                >
                    {_("Create")}
                </Button>
                <Button variant='link' className='btn-cancel' onClick={() => Dialogs.close()} isDisabled={state.inProgress}>
                    {_("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
