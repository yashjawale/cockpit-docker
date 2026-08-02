/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Actions and summary details of a docker-compose stack: aggregated ports,
 * CPU and memory, a status badge, plus a kebab menu to start, stop, restart,
 * edit or remove the whole stack.
 */

import React, { useEffect, useState } from 'react';

import { Badge } from "@patternfly/react-core/dist/esm/components/Badge";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider";
import { DropdownItem } from '@patternfly/react-core/dist/esm/components/Dropdown/index.js';
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { List, ListItem } from "@patternfly/react-core/dist/esm/components/List";
import { Popover } from "@patternfly/react-core/dist/esm/components/Popover";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack";
import { MemoryIcon, MicrochipIcon, PortIcon } from '@patternfly/react-icons';
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';

import { renderContainerPublishedPorts } from './ContainerIntegration.tsx';
import CreateStackModal from './CreateStackModal.tsx';
import * as client from '../lib/client.ts';
import { dockerStatsToView } from '../lib/util.ts';

import type { Connection } from '../lib/rest.ts';
import type { ContainerStats, DockerContainer, DockerPortBinding, Notification } from '../lib/types.ts';

const _ = cockpit.gettext;

/** Directory holding the files of stacks created by this plugin */
const STACKS_DIR = "/var/lib/cockpit-docker/stacks";

/**
 * Aggregate the published ports of all stack containers into a single mapping.
 *
 * The result maps container ports (e.g. "80/tcp") to the host bindings of
 * every stack container, so the ports popover can show them all at once.
 *
 * @param containers The containers of the stack
 * @returns A combined port mapping, or undefined when no container publishes ports
 */
export const stackPublishedPorts = (containers: DockerContainer[]) => {
    const ports: Record<string, DockerPortBinding[] | null> = {};
    for (const container of containers) {
        const containerPorts = container.NetworkSettings?.Ports;
        if (!containerPorts)
            continue;
        for (const [containerPort, bindings] of Object.entries(containerPorts)) {
            if (!bindings || bindings.length === 0)
                continue;
            ports[containerPort] = (ports[containerPort] ?? []).concat(bindings);
        }
    }
    return Object.keys(ports).length > 0 ? ports : undefined;
};

/**
 * Compute a single status string for the whole stack from the states of its
 * containers, mirroring how cockpit-podman shows a pod status.
 *
 * @param containers The containers of the stack
 * @returns A localized status like Running, Degraded or Stopped
 */
const stackStatus = (containers: DockerContainer[]) => {
    if (containers.length === 0)
        return "";
    const statuses = containers.map(container => container.State?.Status ?? "unknown");
    const running = statuses.filter(status => status === "running" || status === "restarting").length;
    const paused = statuses.filter(status => status === "paused").length;
    if (running === statuses.length)
        return _("Running");
    if (paused === statuses.length)
        return _("Paused");
    if (running === 0)
        return _("Stopped");
    return _("Degraded");
};

/**
 * Confirmation dialog removing a whole stack.
 */
const StackRemoveModal = ({ containers, onRemove }: {
    containers: DockerContainer[],
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
            <ModalHeader title={_("Remove stack?")} titleIconVariant="warning" />
            <ModalBody>
                <Stack hasGutter>
                    <p>{_("Removing this stack will permanently delete the following containers. Its compose files are kept, so the stack can be started again.")}</p>
                    <List>
                        {containers.map(container => <ListItem key={container.Id}>{container.Name}</ListItem>)}
                    </List>
                </Stack>
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
 * Props of the StackActions component.
 */
type StackActionsProps = {
    /** Connection of the daemon owning the stack */
    con: Connection,
    /** The containers making up the stack */
    containers: DockerContainer[],
    /** Streamed usage snapshots, keyed by the container's state key */
    containersStats: Record<string, ContainerStats>,
    /** Callback reporting errors to the application as toast notifications */
    onAddNotification: (notification: Notification) => void,
};

/**
 * Summary and actions of a docker-compose stack.
 *
 * Shows the stack status, aggregated published ports, CPU and memory of all
 * stack containers and offers start, stop, restart, edit and remove actions
 * for the whole stack. The edit action is only offered when the stack's files
 * live in the plugin's own directory.
 */
export const StackActions = ({ con, containers, containersStats, onAddNotification }: StackActionsProps) => {
    const Dialogs = useDialogs();
    const project = containers[0]?.Config?.Labels?.['com.docker.compose.project'];
    const ports = stackPublishedPorts(containers);
    const numPorts = Object.keys(ports ?? {}).length;
    const [editAvailable, setEditAvailable] = useState(false);
    // The edit dialog reads the stack files; only offer it when they exist in
    // our own stacks directory (some stacks come from elsewhere, e.g. Docker
    // Desktop, and have no files there). read() resolves with null when the
    // file does not exist rather than rejecting.
    useEffect(() => {
        if (!project) {
            setEditAvailable(false);
            return;
        }
        cockpit.file(`${STACKS_DIR}/${project}/docker-compose.yml`, { superuser: "try" })
                .read()
                .then(content => setEditAvailable(content !== null))
                .catch(() => setEditAvailable(false));
    }, [project]);

    const running = containers.filter(container => container.State?.Status === "running");
    const stopped = containers.filter(container => container.State?.Status !== "running");
    const anyPaused = containers.some(container => container.State?.Status === "paused");
    const anyRunning = containers.length > 0 && (running.length > 0 || anyPaused);

    let cpu = 0;
    let mem = 0;
    let hasStats = false;
    for (const container of containers) {
        const containerStats = containersStats[container.key];
        if (!containerStats)
            continue;
        const stats = dockerStatsToView(containerStats);
        if (stats.CPU !== undefined) {
            cpu += stats.CPU;
            hasStats = true;
        }
        if (stats.MemUsage !== undefined)
            mem += stats.MemUsage;
    }

    /**
     * Apply a docker API action (start/stop/restart) to every stack container.
     *
     * @param action The container action to run
     * @param force  Stop/restart with a zero timeout
     */
    const stackAction = (action: "start" | "stop" | "restart", force = false) => {
        const args: Record<string, number> = {};
        if (force && (action === "stop" || action === "restart"))
            args.t = 0;
        const actionName = action === "start" ? _("start") : action === "stop" ? _("stop") : _("restart");
        Promise.all(containers.map(container =>
            client.postContainer(con, action, container.Id, args)
                    .catch(ex => {
                        const error = cockpit.format(_("Failed to $0 stack $1"), actionName, containers[0]?.Name ?? "");
                        onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                    })
        ));
    };

    /**
     * Remove the active stack: delete every container. The compose files are
     * kept, so the stack reappears in the inactive stacks section where it can
     * be started again or fully removed.
     */
    const removeStack = (): Promise<void> => {
        const errors: string[] = [];
        return Promise.all(containers.map(container =>
            client.delContainer(con, container.Id, true)
                    .catch(ex => errors.push(cockpit.format("$0: $1", container.Name, ex.message)))
        ))
                .then(() => {
                    if (errors.length > 0) {
                        onAddNotification({
                            type: 'danger',
                            error: cockpit.format(_("Failed to remove stack $0"), containers[0]?.Name ?? ""),
                            errorDetail: errors.join("\n"),
                        });
                    }
                })
                .finally(() => Dialogs.close());
    };

    /**
     * Open the edit dialog for the stack, loading the current compose and env
     * files from the stacks directory.
     */
    const editStack = () => {
        if (!project)
            return;
        const dir = `${STACKS_DIR}/${project}`;
        Promise.all([
            cockpit.file(`${dir}/docker-compose.yml`, { superuser: "try" })
                    .read()
                    .catch(() => ""),
            cockpit.file(`${dir}/.env`, { superuser: "try" })
                    .read()
                    .catch(() => ""),
        ]).then(([compose, env]) => {
            Dialogs.show(<CreateStackModal projectName={project} initialCompose={compose} initialEnv={env} />);
        });
    };

    const dropdownItems = [];
    if (anyRunning) {
        dropdownItems.push(
            <DropdownItem key="stack-stop" className="stack-action-stop" component="button" onClick={() => stackAction("stop")}>
                {_("Stop")}
            </DropdownItem>,
            <DropdownItem key="stack-force-stop" className="stack-action-force-stop" component="button" onClick={() => stackAction("stop", true)}>
                {_("Force stop")}
            </DropdownItem>,
            <DropdownItem key="stack-restart" className="stack-action-restart" component="button" onClick={() => stackAction("restart")}>
                {_("Restart")}
            </DropdownItem>,
            <DropdownItem key="stack-force-restart" className="stack-action-force-restart" component="button" onClick={() => stackAction("restart", true)}>
                {_("Force restart")}
            </DropdownItem>,
        );
    }
    if (stopped.length > 0) {
        dropdownItems.push(
            <DropdownItem key="stack-start" className="stack-action-start" component="button" onClick={() => stackAction("start")}>
                {_("Start")}
            </DropdownItem>,
        );
    }

    if (dropdownItems.length > 0)
        dropdownItems.push(<Divider key="stack-separator-1" />);
    if (editAvailable) {
        dropdownItems.push(
            <DropdownItem key="stack-edit" className="stack-action-edit" component="button" onClick={editStack}>
                {_("Edit")}
            </DropdownItem>,
            <Divider key="stack-separator-2" />,
        );
    }
    dropdownItems.push(
        <DropdownItem key="stack-remove" className="stack-action-remove pf-m-danger" component="button" onClick={() => Dialogs.show(<StackRemoveModal containers={containers} onRemove={removeStack} />)}>
            {_("Remove")}
        </DropdownItem>,
    );

    return (
        <>
            {containers.length > 0 && <Badge isRead className={`ct-badge-stack-${stackStatus(containers).toLowerCase()}`}>{stackStatus(containers)}</Badge>}
            {hasStats &&
                <>
                    <Flex className='pod-stat' spaceItems={{ default: 'spaceItemsSm' }}>
                        <Tooltip content={_("CPU")}>
                            <MicrochipIcon />
                        </Tooltip>
                        <Content component={ContentVariants.p} className="pf-v6-u-hidden-on-sm">{_("CPU")}</Content>
                        <Content component={ContentVariants.p} className="pod-cpu">{cpu.toFixed(2)}%</Content>
                    </Flex>
                    <Flex className='pod-stat' spaceItems={{ default: 'spaceItemsSm' }}>
                        <Tooltip content={_("Memory")}>
                            <MemoryIcon />
                        </Tooltip>
                        <Content component={ContentVariants.p} className="pf-v6-u-hidden-on-sm">{_("Memory")}</Content>
                        <Content component={ContentVariants.p} className="pod-memory">{cockpit.format_bytes(mem)}</Content>
                    </Flex>
                </>}
            {ports && numPorts > 0 &&
                <Tooltip content={_("Click to see published ports")}>
                    <Popover
                        enableFlip
                        bodyContent={renderContainerPublishedPorts(ports)}
                    >
                        <Button size="sm" variant="link" className="pod-details-button pod-details-ports-btn" icon={<PortIcon className="pod-details-button-color" />}>
                            {numPorts}
                            <Content component={ContentVariants.p} className="pf-v6-u-hidden-on-sm">{_("ports")}</Content>
                        </Button>
                    </Popover>
                </Tooltip>}
            <KebabDropdown toggleButtonId={`stack-actions-dropdown-${containers[0]?.Name}`} position="right" dropdownItems={dropdownItems} />
        </>
    );
};
