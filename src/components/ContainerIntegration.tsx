/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The Integration tab of an expanded container row: published ports, volumes
 * and environment variables.
 */

import React, { useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList";
import { List, ListItem } from "@patternfly/react-core/dist/esm/components/List";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";

import cockpit from 'cockpit';
import { EmptyStatePanel } from "cockpit-components-empty-state.tsx";

import type { DockerContainer, DockerImage, DockerMount, DockerPortBinding } from '../lib/types.ts';

const _ = cockpit.gettext;

/**
 * Render the published ports of a container as a list of ranges.
 *
 * The port mapping is a dict like { "5000/tcp": [{ "HostIp": "", "HostPort": "6000" }] };
 * consecutive host and container ports are collapsed into a single range. The
 * bindings are flattened and sorted by protocol, host IP and port, because the
 * daemon reports them keyed by container port in alphabetical order, which
 * interleaves protocols (e.g. 80/tcp, 80/udp, 81/tcp) and would otherwise
 * prevent merging 80/tcp with 81/tcp.
 *
 * @param ports The container's port bindings, keyed by container port/protocol
 */
export const renderContainerPublishedPorts = (ports: Record<string, DockerPortBinding[] | null> | undefined) => {
    if (!ports || Object.keys(ports).length === 0)
        return null;

    // flatten every binding into one entry so they can be sorted and merged
    // regardless of the dictionary iteration order
    const bindings: { portNumber: number, protocol: string, hostIp: string, hostPort: number }[] = [];
    Object.entries(ports).forEach(([containerPort, hostBindings]) => {
        const [port, proto] = containerPort.split('/');
        const portNumber = Number(port);
        // not-covered: null was observed in the wild, but unknown how to reproduce
        (hostBindings ?? []).forEach(binding => {
            bindings.push({
                portNumber,
                protocol: proto,
                hostIp: binding.HostIp || "0.0.0.0",
                hostPort: Number(binding.HostPort),
            });
        });
    });

    bindings.sort((a, b) =>
        a.protocol.localeCompare(b.protocol) ||
        a.hostIp.localeCompare(b.hostIp) ||
        a.portNumber - b.portNumber ||
        a.hostPort - b.hostPort);

    // collapse consecutive container and host ports into ranges
    const ranges: { startPort: number, endPort: number, protocol: string, hostIp: string, hostStartPort: number, hostEndPort: number }[] = [];
    bindings.forEach(binding => {
        const lastRange = ranges[ranges.length - 1];
        const isConsecutive = lastRange !== undefined &&
            lastRange.protocol === binding.protocol &&
            lastRange.hostIp === binding.hostIp &&
            binding.portNumber === lastRange.endPort + 1 &&
            binding.hostPort === lastRange.hostEndPort + 1;
        if (isConsecutive) {
            lastRange.endPort = binding.portNumber;
            lastRange.hostEndPort = binding.hostPort;
        } else {
            ranges.push({
                startPort: binding.portNumber,
                endPort: binding.portNumber,
                protocol: binding.protocol,
                hostIp: binding.hostIp,
                hostStartPort: binding.hostPort,
                hostEndPort: binding.hostPort,
            });
        }
    });

    // create list items based on the ranges
    const items: React.ReactNode[] = [];
    ranges.forEach(({ startPort, endPort, protocol, hostIp, hostStartPort, hostEndPort }) => {
        // include the protocol in the key so that e.g. 80/tcp and 80/udp bound
        // to the same host port get distinct keys
        items.push(
            <ListItem key={`${startPort}-${hostIp}-${hostStartPort}-${protocol}`}>
                {hostIp}:{hostStartPort}{hostStartPort !== hostEndPort ? `-${hostEndPort}` : ''} &rarr; {startPort}{startPort !== endPort ? `-${endPort}` : ''}/{protocol}
            </ListItem>
        );
    });

    return <List isPlain>{items}</List>;
};

/**
 * Render the volumes of a container as a list of source to destination mappings.
 *
 * @param volumes The container's mounts as reported by the inspect endpoint
 */
export const renderContainerVolumes = (volumes: DockerMount[]) => {
    if (!volumes || volumes.length === 0)
        return null;

    const result = volumes.map(volume => {
        return (
            <ListItem key={(volume.Source ?? "") + volume.Destination}>
                {volume.Source}
                {volume.RW
                    ? <Tooltip content={_("Read-write access")}><span> &harr; </span></Tooltip>
                    : <Tooltip content={_("Read-only access")}><span> &rarr; </span></Tooltip>}
                {volume.Destination}
            </ListItem>
        );
    });

    return <List isPlain>{result}</List>;
};

/**
 * The environment variables of the container, hiding variables that docker or
 * the image set, with a "Show more" toggle revealing everything else.
 */
const ContainerEnv = ({ containerEnv, imageEnv }: { containerEnv: string[], imageEnv: string[] | undefined }) => {
    // filter out some environment variables set by docker or by the image
    const toRemoveEnv = [...(imageEnv ?? []), 'container=docker'];
    let toShow = containerEnv.filter(variable => {
        if (toRemoveEnv.includes(variable)) {
            return false;
        }

        return !variable.match(/(HOME|TERM)=.*/);
    });

    // append filtered out variables to always shown variables when 'show more' is clicked
    const [showMore, setShowMore] = useState(false);
    if (showMore)
        toShow = toShow.concat(containerEnv.filter(variable => !toShow.includes(variable)));

    if (!toShow.length)
        return null;

    const result = toShow.map(variable => {
        return (
            <ListItem key={variable}>
                {variable}
            </ListItem>
        );
    });

    result.push(
        <ListItem key='show-more-env-button'>
            <Button variant='link' isInline onClick={() => setShowMore(!showMore)}>
                {showMore ? _("Show less") : _("Show more")}
            </Button>
        </ListItem>
    );

    return <List isPlain>{result}</List>;
};

/**
 * The Integration tab of an expanded container row.
 *
 * @param container   The container to show the integration details of
 * @param localImages The images available locally, to compare environment variables
 */
const ContainerIntegration = ({ container, localImages }: { container: DockerContainer, localImages: DockerImage[] | null }) => {
    if (localImages === null) { // not-covered: not a stable UI state
        return (
            <EmptyStatePanel title={_("Loading details...")} loading />
        );
    }

    const ports = renderContainerPublishedPorts(container.NetworkSettings?.Ports);
    const volumes = renderContainerVolumes(container.Mounts ?? []);

    const image = localImages.filter(img => img.Id === container.Image)[0];
    let env = null;
    // Docker allows one to remove an image while it has a container attached
    if (image)
        env = <ContainerEnv containerEnv={container.Config?.Env ?? []} imageEnv={image.Env} />;

    return (
        <DescriptionList isAutoColumnWidths columnModifier={{ md: '3Col' }} className='container-integration'>
            {ports &&
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Ports")}</DescriptionListTerm>
                <DescriptionListDescription className="container-integration-ports">{ports}</DescriptionListDescription>
            </DescriptionListGroup>}
            {volumes &&
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Volumes")}</DescriptionListTerm>
                <DescriptionListDescription className="container-integration-volumes">{volumes}</DescriptionListDescription>
            </DescriptionListGroup>}
            {env &&
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Environment variables")}</DescriptionListTerm>
                <DescriptionListDescription className="container-integration-envs">{env}</DescriptionListDescription>
            </DescriptionListGroup>}
        </DescriptionList>
    );
};

export default ContainerIntegration;
