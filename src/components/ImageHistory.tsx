/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * History tab for a single image, listing its build layers.
 */

import React, { useState, useEffect } from 'react';

import cockpit from 'cockpit';
import { ListingTable } from "cockpit-components-table";

import { RelativeTime } from './RelativeTime.tsx';
import * as client from '../lib/client.ts';
import { truncate_id } from '../lib/util.ts';

import type { DockerImage, ImageHistoryLayer } from '../lib/types.ts';
import type { Connection } from '../lib/rest.ts';

const _ = cockpit.gettext;

/**
 * Render the id of a history layer, shortened for display.
 *
 * Placeholder values such as "<missing>" are rendered in grey instead of
 * being truncated.
 *
 * @param Id The full layer id or placeholder
 * @returns The element or string to display
 */
const IdColumn = (Id: string) => {
    Id = truncate_id(Id);
    // Not an id but <missing> or something else
    if (/<[a-z]+>/.test(Id)) {
        return <div className="ct-grey-text">{Id}</div>;
    }
    return Id;
};

/**
 * Show the build history of a single image.
 *
 * @param con   Connection of the image's owner
 * @param image The image whose history is shown
 */
const ImageHistory = ({ con, image }: {
    con: Connection,
    image: DockerImage,
}) => {
    const [history, setHistory] = useState<ImageHistoryLayer[]>([]);
    const [error, setError] = useState(false);
    const id = image.Id;

    useEffect(() => {
        client.imageHistory(con, id).then(setHistory)
                .catch(ex => {
                    console.error("Cannot get image history", ex);
                    setError(true);
                });
    }, [con, id]);

    const columns = ["ID", _("Created"), _("Created by"), _("Size"), _("Comments")];
    let showComments = false;
    const rows = history.map(layer => {
        const row = {
            columns: [
                { title: IdColumn(layer.Id), props: { className: "ignore-pixels" } },
                { title: <RelativeTime time={layer.Created * 1000} />, props: { className: "ignore-pixels" } },
                { title: layer.CreatedBy, props: { className: "ignore-pixels" } },
                { title: cockpit.format_bytes(layer.Size), props: { className: "ignore-pixels" } },
                { title: layer.Comment, props: { className: "ignore-pixels" } },
            ]
        };
        if (layer.Comment) {
            showComments = true;
        }
        return row;
    });

    if (!showComments) {
        columns.pop();
    }

    return (
        <ListingTable
            variant='compact'
            isStickyHeader
            emptyCaption={error ? _("Unable to load image history") : _("Loading details...")}
            columns={columns}
            rows={rows}
        />
    );
};

export default ImageHistory;
