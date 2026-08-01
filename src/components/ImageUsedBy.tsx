/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * List of containers that use a particular image.
 */

import React from 'react';

import { Badge } from "@patternfly/react-core/dist/esm/components/Badge";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { List, ListItem } from "@patternfly/react-core/dist/esm/components/List";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";

import cockpit from 'cockpit';

import type { ImageUse } from '../lib/types.ts';

const _ = cockpit.gettext;

/**
 * Show the containers using an image, with a link to each container.
 *
 * @param containers The containers using the image, null while loading
 * @param showAll    Callback to show all containers when an inactive one is clicked
 */
const ImageUsedBy = ({ containers, showAll }: {
    containers: ImageUse[] | null | undefined,
    showAll: () => void,
}) => {
    if (containers === null)
        return _("Loading...");
    if (containers === undefined)
        return _("No containers are using this image");

    return (
        <List isPlain>
            {containers.map(c => {
                const container = c.container;
                const isRunning = container.State?.Status === "running";
                return (
                    <ListItem key={container.Id}>
                        <Flex>
                            <Button
                                variant="link"
                                isInline
                                onClick={() => {
                                    cockpit.location.go('#' + container.Id);

                                    if (!isRunning)
                                        showAll();
                                }}
                            >
                                {container.Name}
                            </Button>
                            {isRunning && <Badge className="ct-badge-container-running">{_("Running")}</Badge>}
                        </Flex>
                    </ListItem>
                );
            })}
        </List>
    );
};

export default ImageUsedBy;
