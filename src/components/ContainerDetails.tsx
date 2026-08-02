/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The Details tab of an expanded container row: identity, image, command,
 * networking and state.
 */

import React from 'react';

import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex";

import cockpit from 'cockpit';

import { quote_cmdline, truncate_id } from '../lib/util.ts';
import { RelativeTime } from './RelativeTime.tsx';

import type { DockerContainer } from '../lib/types.ts';

const _ = cockpit.gettext;

/**
 * Render the container state line: "Up since" with a relative timestamp for
 * running containers, otherwise a plain "Exited" marker.
 *
 * @param container The container to render the state for
 */
const render_container_state = (container: DockerContainer) => {
    if (container.State?.Status === "running") {
        return <><span>{ _("Up since:") } </span><RelativeTime time={container.State.StartedAt ?? ""} /></>;
    }
    return cockpit.format(_("Exited"));
};

/**
 * The Details tab of an expanded container row.
 *
 * @param container The container to show the details of
 */
const ContainerDetails = ({ container }: { container: DockerContainer }) => {
    const networkOptions = (
        [
            container.NetworkSettings?.IPAddress,
            container.NetworkSettings?.Gateway,
            container.NetworkSettings?.MacAddress,
        ].some(itm => !!itm)
    );

    return (
        <Flex>
            <FlexItem>
                <DescriptionList className='container-details-basic'>
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("ID")}</DescriptionListTerm>
                        <DescriptionListDescription className="ignore-pixels">{truncate_id(container.Id)}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Image")}</DescriptionListTerm>
                        <DescriptionListDescription>{container.Config?.Image ?? container.Image}</DescriptionListDescription>
                    </DescriptionListGroup>
                    {container.Config?.Cmd &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Command")}</DescriptionListTerm>
                        <DescriptionListDescription>{quote_cmdline(container.Config.Cmd)}</DescriptionListDescription>
                    </DescriptionListGroup>}
                </DescriptionList>
            </FlexItem>
            <FlexItem>
                {networkOptions &&
                <DescriptionList columnModifier={{ default: '2Col' }} className='container-details-networking'>
                    {container.NetworkSettings?.IPAddress &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("IP address")}</DescriptionListTerm>
                        <DescriptionListDescription className="ignore-pixels">{container.NetworkSettings.IPAddress}</DescriptionListDescription>
                    </DescriptionListGroup>}
                    {container.NetworkSettings?.Gateway &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Gateway")}</DescriptionListTerm>
                        <DescriptionListDescription className="ignore-pixels">{container.NetworkSettings.Gateway}</DescriptionListDescription>
                    </DescriptionListGroup>}
                    {container.NetworkSettings?.MacAddress &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("MAC address")}</DescriptionListTerm>
                        <DescriptionListDescription className="container-mac-address">{container.NetworkSettings.MacAddress}</DescriptionListDescription>
                    </DescriptionListGroup>}
                </DescriptionList>}
            </FlexItem>
            <FlexItem>
                <DescriptionList className='container-details-state'>
                    {container.Created &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Created")}</DescriptionListTerm>
                        <DescriptionListDescription className="container-created"><RelativeTime time={container.Created} /></DescriptionListDescription>
                    </DescriptionListGroup>}
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("State")}</DescriptionListTerm>
                        <DescriptionListDescription>{render_container_state(container)}</DescriptionListDescription>
                    </DescriptionListGroup>
                </DescriptionList>
            </FlexItem>
        </Flex>
    );
};

export default ContainerDetails;
