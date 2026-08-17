/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Dialog listing the host ports currently in use, so users can pick free
 * ports when writing a compose file. The published ports of all containers
 * are shown; ports reserved by inactive (not yet started) stacks can be
 * included via the display options menu in the dialog header.
 */

import React, { useMemo, useState } from 'react';

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { DropdownItem } from '@patternfly/react-core/dist/esm/components/Dropdown/index.js';
import {
    Modal, ModalBody, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { SortByDirection } from "@patternfly/react-table";
import { ExclamationTriangleIcon } from '@patternfly/react-icons';
import { EmptyStatePanel } from "cockpit-components-empty-state.tsx";

import cockpit from 'cockpit';
import { ListingTable } from "cockpit-components-table";
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import ipaddr from "ipaddr.js";

import * as client from '../lib/client.ts';

import type { ListingTableColumnProps, ListingTableRowProps } from "cockpit-components-table";
import type { JsonObject } from 'cockpit';
import type { DockerContainer, DockerPortBinding } from '../lib/types.ts';

const _ = cockpit.gettext;

/** Highest port number that can be published */
const MAX_PORT = 65535;

/** A single host/container port pair plus protocol, as used by a service or container */
interface ComposePort {
    hostPort: number;
    containerPort: number;
    protocol: string;
}

/** The host port bindings of one service of an inactive stack */
interface InactiveStackService {
    /** Name of the docker-compose project the service belongs to */
    project: string;
    /** Name of the service inside the stack */
    service: string;
    /** Image the service uses, empty when it is built locally */
    image: string;
    /** Host ports the service reserves */
    ports: ComposePort[];
}

/** A single row of the port map: one host port binding of one container or service */
interface PortEntry {
    /** Row-unique key */
    key: string;
    /** Host port that is occupied */
    hostPort: number;
    /** Network protocol, e.g. "tcp" */
    protocol: string;
    /** Name of the container, or the service name of an inactive stack */
    containerName: string;
    /** Image the container or service uses */
    imageName: string;
    /** Name of the docker-compose project, when part of a stack */
    stackName: string | null;
    /**
     * Where the entry comes from: a live (running) container, a stopped
     * container's configured ports, or an inactive stack's compose file.
     */
    source: "container" | "stopped-container" | "inactive-stack";
    /** Whether another container or service claims the same host port */
    conflict: boolean;
    /** The other containers/services claiming the same host port, for the notice */
    conflictWith: string[];
    /** Key identifying all entries of the same container or service */
    sourceKey: string;
}

/** A single column of the port map table, compatible with the ListingTable rows */
interface PortMapRowColumn {
    title: React.ReactNode;
    sortKey?: string | number;
    props?: Record<string, unknown>;
}

/**
 * Expand a (possibly ranged) port specification into a list of single ports.
 *
 * Compose port mappings can use ranges like "8080-8082:80-82". The host and
 * container range must have the same length; the entries are expanded
 * pairwise. An empty list is returned when the specification is not a fixed,
 * in-range port.
 *
 * @param host      The host port part, possibly a range
 * @param container The container port part, possibly a range
 * @param protocol  The network protocol of the mapping
 */
const expandPortRange = (host: string, container: string, protocol: string): ComposePort[] => {
    const hostRange = host.split("-");
    const containerRange = container.split("-");
    const hostStart = Number(hostRange[0]);
    const hostEnd = hostRange.length > 1 ? Number(hostRange[1]) : hostStart;
    const containerStart = Number(containerRange[0]);
    const containerEnd = containerRange.length > 1 ? Number(containerRange[1]) : containerStart;
    if (![hostStart, hostEnd, containerStart, containerEnd].every(Number.isInteger))
        return [];
    if (hostStart < 1 || hostEnd > MAX_PORT || containerStart < 1 || containerEnd > MAX_PORT)
        return [];
    const count = hostEnd - hostStart;
    if (count < 0 || count !== containerEnd - containerStart)
        return [];

    const ports: ComposePort[] = [];
    for (let i = 0; i <= count; i++)
        ports.push({ hostPort: hostStart + i, containerPort: containerStart + i, protocol });
    return ports;
};

/**
 * Parse a compose short-syntax port mapping into its host port bindings.
 *
 * Handles the forms "8080:80", "8080-8082:80-82/udp" and "127.0.0.1:8080:80".
 * Mappings without an explicit host port (docker then assigns a random one at
 * start time) do not reserve a specific host port and are ignored.
 *
 * @param spec The short-syntax port mapping
 */
const parseComposeShortPort = (spec: string): ComposePort[] => {
    const parts = spec.split("/");
    const protocol = parts.length > 1 ? parts.pop()! : "tcp";
    const fields = parts[0].split(":");
    if (fields.length === 1) {
        // "80": only the container port is given, the host port is random
        return [];
    }
    let host: string;
    let container: string;
    if (fields.length === 2) {
        if (ipaddr.isValid(fields[0])) {
            // "127.0.0.1:80": container port on a given IP, host port random
            return [];
        }
        host = fields[0];
        container = fields[1];
    } else if (fields.length === 3) {
        host = fields[1];
        container = fields[2];
    } else {
        return []; // malformed, e.g. a bracketed IPv6 literal
    }
    if (host === "")
        return [];
    return expandPortRange(host, container, protocol);
};

/**
 * Parse a compose long-syntax port mapping object, i.e.
 * { target, published, protocol }, into its host port bindings. Mappings
 * without a fixed published port are ignored.
 *
 * @param entry The long-syntax port mapping
 */
const parseComposeLongPort = (entry: JsonObject): ComposePort[] => {
    const published = entry.published;
    const target = entry.target;
    const protocol = (entry.protocol as string) ?? "tcp";
    if (published === undefined || published === null || published === "")
        return [];
    const host = String(published);
    const container = target === undefined || target === null ? host : String(target);
    return expandPortRange(host, container, protocol);
};

/**
 * Extract the services and their host port bindings from a normalized compose
 * config, as returned by client.composeConfig().
 *
 * @param config The normalized stack configuration
 */
const extractComposeServices = (config: JsonObject): Omit<InactiveStackService, "project">[] => {
    const services = (config.services as JsonObject | undefined) ?? {};
    const result: Omit<InactiveStackService, "project">[] = [];
    Object.entries(services).forEach(([service, serviceConfig]) => {
        const obj = serviceConfig as JsonObject;
        const ports: ComposePort[] = [];
        if (Array.isArray(obj.ports)) {
            obj.ports.forEach(entry => {
                if (typeof entry === "string")
                    ports.push(...parseComposeShortPort(entry));
                else if (entry && typeof entry === "object")
                    ports.push(...parseComposeLongPort(entry as JsonObject));
            });
        }
        result.push({
            service,
            image: typeof obj.image === "string" ? obj.image : "",
            ports,
        });
    });
    return result;
};

/**
 * Collect the host ports a container binds from its network settings.
 *
 * The port mapping is a dict like { "80/tcp": [{ HostIp, HostPort }] }. Only
 * bindings with an explicit host port occupy a port on the host; exposed
 * ports without a binding are ignored.
 *
 * @param container The container to inspect
 */
/**
 * Collect the host ports from a port binding map, deduplicating the bindings
 * per host port and protocol.
 *
 * A port map like { "80/tcp": [{ HostIp, HostPort }] } is reported by the
 * daemon in two places: NetworkSettings.Ports holds the live ports of a
 * running container (empty once it stops), and HostConfig.PortBindings holds
 * the configured ports that persist across stop/start. Both maps have the
 * same shape. Docker publishes a port on every host IP (e.g. 0.0.0.0 and ::),
 * reporting one binding per address, so a host port/protocol pair only
 * occupies one port and is recorded once. Bindings without an explicit host
 * port (random assignment) are ignored.
 *
 * @param ports The port binding map to extract the ports of
 */
const portsFromMap = (ports: Record<string, DockerPortBinding[] | null> | undefined): ComposePort[] => {
    const result: ComposePort[] = [];
    const seen = new Set<string>();
    Object.entries(ports ?? {}).forEach(([containerPort, bindings]) => {
        const [port, proto] = containerPort.split('/');
        const containerPortNumber = Number(port);
        (bindings ?? []).forEach(binding => {
            if (!binding.HostPort || !Number.isInteger(Number(binding.HostPort)))
                return;
            const protocol = proto ?? "tcp";
            const hostPort = Number(binding.HostPort);
            const dedupeKey = `${hostPort}/${protocol}`;
            if (seen.has(dedupeKey))
                return;
            seen.add(dedupeKey);
            result.push({ hostPort, containerPort: containerPortNumber, protocol });
        });
    });
    return result;
};

/**
 * Mark the entries that are not from a live container and whose host port is
 * also claimed by another container or service as conflicts, recording which
 * other entries claim the same port for the row notice. An entry that is only
 * configured (stopped container or inactive stack) conflicts when starting it
 * would fail because the port is already taken. The array is modified in
 * place.
 *
 * @param entries The port map entries to annotate
 */
const applyConflicts = (entries: PortEntry[]): PortEntry[] => {
    const byHostPort = new Map<number, PortEntry[]>();
    entries.forEach(entry => {
        const group = byHostPort.get(entry.hostPort);
        if (group)
            group.push(entry);
        else
            byHostPort.set(entry.hostPort, [entry]);
    });

    byHostPort.forEach(group => {
        if (new Set(group.map(entry => entry.sourceKey)).size <= 1)
            return;
        group.forEach(entry => {
            if (entry.source === "container")
                return;
            entry.conflict = true;
            const others = new Set<string>();
            group.forEach(other => {
                if (other.sourceKey === entry.sourceKey)
                    return;
                others.add(other.containerName + (other.stackName ? ` (${other.stackName})` : ""));
            });
            entry.conflictWith = Array.from(others);
        });
    });

    return entries;
};

/**
 * Build every port map entry from the containers and the loaded inactive
 * stacks.
 *
 * The live ports of all containers (from NetworkSettings.Ports, i.e. the ones
 * actually bound by running containers) are always shown. When includeInactive
 * is true, the configured ports of stopped and never-started containers (from
 * HostConfig.PortBindings) and the ports reserved by inactive stack files are
 * added as well.
 *
 * @param containers       All containers across owners
 * @param includeInactive  Whether stopped containers and inactive stacks are shown
 * @param inactiveServices Ports of inactive stacks, or null when not included
 */
const buildEntries = (containers: Record<string, DockerContainer>, includeInactive: boolean, inactiveServices: InactiveStackService[] | null): PortEntry[] => {
    const entries: PortEntry[] = [];

    Object.values(containers).forEach(container => {
        const image = container.Config?.Image ?? container.Image;
        const stackName = container.Config?.Labels?.['com.docker.compose.project'] ?? null;
        const livePorts = portsFromMap(container.NetworkSettings?.Ports);
        livePorts.forEach(port => {
            entries.push({
                key: `container-${container.key}-${port.hostPort}-${port.protocol}`,
                hostPort: port.hostPort,
                protocol: port.protocol,
                containerName: container.Name,
                imageName: image,
                stackName,
                source: "container",
                conflict: false,
                conflictWith: [],
                sourceKey: container.key,
            });
        });

        if (includeInactive) {
            const liveKeys = new Set(livePorts.map(port => `${port.hostPort}/${port.protocol}`));
            const configuredPorts = portsFromMap(container.HostConfig?.PortBindings)
                    .filter(port => !liveKeys.has(`${port.hostPort}/${port.protocol}`));
            configuredPorts.forEach(port => {
                entries.push({
                    key: `stopped-${container.key}-${port.hostPort}-${port.protocol}`,
                    hostPort: port.hostPort,
                    protocol: port.protocol,
                    containerName: container.Name,
                    imageName: image,
                    stackName,
                    source: "stopped-container",
                    conflict: false,
                    conflictWith: [],
                    sourceKey: container.key,
                });
            });
        }
    });

    if (includeInactive) {
        (inactiveServices ?? []).forEach(service => {
            service.ports.forEach(port => {
                entries.push({
                    key: `inactive-${service.project}-${service.service}-${port.hostPort}-${port.protocol}`,
                    hostPort: port.hostPort,
                    protocol: port.protocol,
                    containerName: service.service,
                    imageName: service.image,
                    stackName: service.project,
                    source: "inactive-stack",
                    conflict: false,
                    conflictWith: [],
                    sourceKey: `inactive:${service.project}:${service.service}`,
                });
            });
        });
    }

    return applyConflicts(entries);
};

/**
 * Group the flat port entries by their container or service, so one row can
 * show a container that occupies several ports at once.
 *
 * @param entries The flat port entries
 */
const groupByContainer = (entries: PortEntry[]): PortEntry[][] => {
    const bySource = new Map<string, PortEntry[]>();
    entries.forEach(entry => {
        const group = bySource.get(entry.sourceKey);
        if (group)
            group.push(entry);
        else
            bySource.set(entry.sourceKey, [entry]);
    });
    return Array.from(bySource.values());
};

/**
 * The conflict notice of a row: a short warning that the host port is already
 * claimed by another container or service.
 *
 * @param entry The entry to render the notice of
 */
const conflictNotice = (entry: PortEntry) => (
    <small key={`conflict-${entry.key}`} className="ct-portmap-conflict">
        <ExclamationTriangleIcon />
        {cockpit.format(_("Port $0 is also used by $1"), entry.hostPort, entry.conflictWith.join(", "))}
    </small>
);

/** The container cell: name, the image below it, the status and any conflict notices */
const renderContainer = (entry: PortEntry) => (
    <div className="container-block">
        <span className="container-name">{entry.containerName}</span>
        {entry.imageName && <small>{entry.imageName}</small>}
        {entry.source === "stopped-container" && <small className="ct-portmap-inactive">{_("stopped")}</small>}
        {entry.conflict && conflictNotice(entry)}
    </div>
);

/** The container cell of a grouped row, showing the notice of every conflicting port */
const renderContainerGroup = (group: PortEntry[]) => (
    <div className="container-block">
        <span className="container-name">{group[0].containerName}</span>
        {group[0].imageName && <small>{group[0].imageName}</small>}
        {group[0].source === "stopped-container" && <small className="ct-portmap-inactive">{_("stopped")}</small>}
        {group.filter(entry => entry.conflict).map(conflictNotice)}
    </div>
);

/** The stack cell, marking entries that come from inactive stack files */
const renderStack = (entry: PortEntry) => {
    if (!entry.stackName)
        return null;
    return (
        <div className="container-block">
            <span>{entry.stackName}</span>
            {entry.source === "inactive-stack" && <small className="ct-portmap-inactive">{_("inactive stack")}</small>}
        </div>
    );
};

/** The port cell of a grouped row, listing all ports of the container */
const renderPorts = (group: PortEntry[]) => (
    <span>
        {[...group]
                .sort((a, b) => a.hostPort - b.hostPort)
                .map((entry, index) => (
                    <React.Fragment key={entry.key}>
                        {index > 0 && <span>, </span>}
                        <span className="ct-portmap-port">{entry.hostPort}/{entry.protocol}</span>
                    </React.Fragment>
                ))}
    </span>
);

/**
 * Dialog listing all host ports in use across the daemons.
 *
 * Every running container with a published port contributes one row (or, when
 * grouping is enabled, one row per container listing all its ports). Ports
 * reserved by stopped containers and by inactive (not yet started) stacks are
 * only loaded and shown once the "Include stopped containers and inactive
 * stacks" display option is enabled, because reading the stack files shells
 * out to `docker compose config` per stack.
 */
const PortMapModal = ({ close, containers, inactiveStacks }: {
    close: () => void,
    /** All containers across owners */
    containers: Record<string, DockerContainer>,
    /** Project names of stacks without any container, i.e. still in file */
    inactiveStacks: string[],
}) => {
    const [includeInactive, setIncludeInactive] = useState(false);
    const [groupByStack, setGroupByStack] = useState(false);
    const [inactiveServices, setInactiveServices] = useState<InactiveStackService[] | null>(null);
    const [inactiveLoading, setInactiveLoading] = useState(false);
    const [inactiveErrors, setInactiveErrors] = useState<string[]>([]);

    /**
     * Load the port reservations of every inactive stack by running
     * `docker compose config` in its directory. Stacks whose files cannot be
     * parsed are skipped and reported in a warning below the table.
     */
    const loadInactivePorts = () => {
        setInactiveLoading(true);
        setInactiveErrors([]);
        Promise.all(inactiveStacks.map(project => {
            const dir = `${client.getStacksDir()}/${project}`;
            return client.composeConfig(dir)
                    .then(config => ({ project, services: extractComposeServices(config), error: "" }))
                    .catch(ex => ({ project, services: [], error: `${project}: ${ex.message}` }));
        })).then(results => {
            const services: InactiveStackService[] = [];
            const errors: string[] = [];
            results.forEach(result => {
                if (result.error)
                    errors.push(result.error);
                result.services.forEach(service => services.push({ project: result.project, ...service }));
            });
            setInactiveServices(services);
            setInactiveErrors(errors);
            setInactiveLoading(false);
        });
    };

    const onIncludeInactiveClick = () => {
        if (!includeInactive && inactiveServices === null && inactiveStacks.length > 0)
            loadInactivePorts();
        setIncludeInactive(!includeInactive);
    };

    const entries = useMemo(
        () => buildEntries(containers, includeInactive, inactiveServices),
        [containers, includeInactive, inactiveServices]
    );

    const sortRows = (sortedRows: ListingTableRowProps[], direction: SortByDirection, idx: number) => {
        const result = sortedRows.sort((a, b) => {
            const aitem = (a.columns[idx] as PortMapRowColumn).sortKey ?? (a.columns[idx] as PortMapRowColumn).title;
            const bitem = (b.columns[idx] as PortMapRowColumn).sortKey ?? (b.columns[idx] as PortMapRowColumn).title;
            // Ports are numeric; the other columns sort as strings
            if (idx === 0)
                return (aitem as number) - (bitem as number);
            return String(aitem).localeCompare(String(bitem));
        });
        return direction === SortByDirection.asc ? result : result.reverse();
    };

    const columns: ListingTableColumnProps[] = [
        { title: _("Host port"), sortable: true },
        { title: _("Container"), sortable: true },
        { title: _("Stack"), sortable: true },
    ];

    const flatRows = entries.map(entry => ({
        columns: [
            { title: `${entry.hostPort}/${entry.protocol}`, sortKey: entry.hostPort },
            { title: renderContainer(entry), sortKey: entry.containerName },
            { title: renderStack(entry), sortKey: entry.stackName ?? "" },
        ],
        expandedContent: null,
        initiallyExpanded: false,
        props: {
            key: entry.key,
            "data-row-id": entry.key,
            "data-row-name": entry.containerName,
        },
    })) as unknown as ListingTableRowProps[];

    const groupedRows = groupByContainer(entries).map(group => ({
        columns: [
            { title: renderPorts(group), sortKey: Math.min(...group.map(entry => entry.hostPort)) },
            { title: renderContainerGroup(group), sortKey: group[0].containerName },
            { title: renderStack(group[0]), sortKey: group[0].stackName ?? "" },
        ],
        expandedContent: null,
        initiallyExpanded: false,
        props: {
            key: `group-${group[0].sourceKey}`,
            "data-row-id": `group-${group[0].sourceKey}`,
            "data-row-name": group[0].containerName,
        },
    })) as unknown as ListingTableRowProps[];

    const rows = groupByStack ? groupedRows : flatRows;

    return (
        <Modal
            isOpen
            onClose={close}
            position="top" variant="large"
            aria-label={_("Port map")}
        >
            <ModalHeader
                title={_("Port map")}
                help={
                    <KebabDropdown
                        toggleButtonId="port-map-options-dropdown"
                        position="right"
                        dropdownItems={[
                            <DropdownItem
                                key="include-inactive"
                                hasCheckbox
                                isSelected={includeInactive}
                                onClick={onIncludeInactiveClick}
                            >
                                {_("Include stopped containers and inactive stacks")}
                            </DropdownItem>,
                            <DropdownItem
                                key="group-containers"
                                hasCheckbox
                                isSelected={groupByStack}
                                onClick={() => setGroupByStack(!groupByStack)}
                            >
                                {_("Group ports by container")}
                            </DropdownItem>,
                        ]}
                    />
                }
            />
            <ModalBody>
                <p>{_("Host ports in use by containers and stacks")}</p>
                {inactiveErrors.length > 0 &&
                    <Alert
                        isInline
                        variant="warning"
                        title={_("Could not read the ports of some inactive stacks")}
                    >
                        {inactiveErrors.join("; ")}
                    </Alert>}
                {inactiveLoading &&
                    <EmptyStatePanel title={_("Loading inactive stacks...")} loading />}
                <ListingTable
                    id="port-map-table"
                    aria-label={_("Port map")}
                    variant="compact"
                    columns={columns}
                    rows={rows}
                    sortMethod={sortRows}
                    sortBy={{ index: 0, direction: SortByDirection.asc }}
                    emptyCaption={includeInactive
                        ? <Content component={ContentVariants.h3}>{_("No host ports are in use")}</Content>
                        : <Content component={ContentVariants.h3}>{_("No containers publish any host port")}</Content>}
                    emptyCaptionDetail={<span className="pf-v6-u-font-size-sm">{_("Use the display options in the dialog header to show the ports of stopped containers and inactive stacks.")}</span>}
                />
            </ModalBody>
        </Modal>
    );
};

export default PortMapModal;
