/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Confirmation dialog for pruning selected stopped containers across all owners.
 */

import React, { useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { SortByDirection } from "@patternfly/react-table";

import cockpit from 'cockpit';
import { ListingTable } from 'cockpit-components-table';

import * as client from '../lib/client.ts';
import { RelativeTime } from './RelativeTime.tsx';

import type { ListingTableColumnProps, ListingTableRowProps } from "cockpit-components-table";
import type { Connection } from '../lib/rest.ts';
import type { DockerError, Notification, Uid, UnusedContainer, User } from '../lib/types.ts';

const _ = cockpit.gettext;

/**
 * Build the table row of one unused container, marking it selected or not.
 *
 * @param container        The unused container to render
 * @param showOwnerColumn  Whether an owner column is shown
 * @param users            The known users, to resolve the owner's display name
 * @param selected         Whether the row's checkbox is checked
 */
const getContainerRow = (container: UnusedContainer, showOwnerColumn: boolean, users: User[], selected: boolean): ListingTableRowProps => {
    const username = users.find(u => u.uid === container.uid)?.name;

    const columns: ListingTableRowProps["columns"] = [
        {
            title: container.name,
            sortKey: container.name,
        },
        {
            title: <RelativeTime time={container.created ?? ""} />,
            sortKey: container.created ?? "",
        },
    ];

    if (showOwnerColumn)
        columns.push({
            title: container.uid === 0 ? _("system") : <div><span className="ct-grey-text">{_("user:")} </span>{username}</div>,
            sortKey: container.key,
        });

    return { columns, selected, props: { key: container.key, id: container.key } };
};

/**
 * Modal that deletes the selected stopped containers, grouped by owner.
 */
const PruneUnusedContainersModal = ({ close, unusedContainers, onAddNotification, users }: {
    close: () => void,
    unusedContainers: UnusedContainer[],
    onAddNotification: (notification: Notification) => void,
    users: User[],
}) => {
    const [isPruning, setPruning] = useState(false);
    const [selectedContainerKeys, setSelectedContainerKeys] = useState(unusedContainers.map(u => u.key));

    /**
     * Force-remove every selected container, across all owners, in parallel.
     *
     * Closes the dialog on success, and reports a notification plus closes on
     * failure.
     */
    const handlePruneUnusedContainers = () => {
        setPruning(true);

        const con_for = (uid: Uid) => users.find(u => u.uid === uid)?.con as Connection | undefined;

        const actions = unusedContainers
                .filter(u => selectedContainerKeys.includes(u.key))
                .map(u => client.delContainer(con_for(u.uid) as Connection, u.id, true));

        Promise.allSettled(actions).then(results => {
            const failures = results
                    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
                    .map(result => (result.reason as DockerError).message);
            if (failures.length > 0) {
                const error = _("Failed to prune unused containers");
                onAddNotification({ type: 'danger', error, errorDetail: failures.join("\n") });
            }
            close();
        });
    };

    const columns: ListingTableColumnProps[] = [
        { title: _("Name"), sortable: true },
        { title: _("Created"), sortable: true },
    ];

    const showOwnerColumn = unusedContainers.some(u => u.uid !== 0);

    if (showOwnerColumn)
        columns.push({ title: _("Owner"), sortable: true });

    /**
     * Select or deselect all unused containers at once.
     *
     * @param isSelecting Whether all containers are now selected
     */
    const selectAllContainers = (isSelecting: boolean) => setSelectedContainerKeys(isSelecting ? unusedContainers.map(c => c.key) : []);

    /**
     * Add or remove a single container from the selection.
     *
     * @param container  The container whose checkbox changed
     * @param isSelecting Whether the container is now selected
     */
    const setContainerSelected = (container: UnusedContainer, isSelecting: boolean) => setSelectedContainerKeys(prevSelected => {
        const otherSelectedContainerNames = prevSelected.filter(r => r !== container.key);
        return isSelecting ? [...otherSelectedContainerNames, container.key] : otherSelectedContainerNames;
    });

    /**
     * Handle a row checkbox toggle, resolving the container by its row id.
     *
     * @param key       The row id, i.e. the container's state key
     * @param _rowIndex The row index, unused
     * @param isSelecting Whether the row is now selected
     */
    const onSelectContainer = (key: string, _rowIndex: number, isSelecting: boolean) => {
        const container = unusedContainers.find(u => u.key === key);
        if (container)
            setContainerSelected(container, isSelecting);
    };

    return (
        <Modal
            isOpen
            onClose={close}
            position="top" variant="medium"
        >
            <ModalHeader title={cockpit.format(_("Prune unused containers"))} />
            <ModalBody>
                <p>{_("Removes selected non-running containers")}</p>
                <ListingTable
                    columns={columns}
                    onSelect={(_event, isSelecting, rowIndex, rowData) => onSelectContainer(rowData.props.id as string, rowIndex, isSelecting)}
                    onHeaderSelect={(_event, isSelecting) => selectAllContainers(isSelecting as boolean)}
                    id="unused-container-list"
                    rows={unusedContainers.map(container => getContainerRow(container, showOwnerColumn, users, selectedContainerKeys.includes(container.key)))}
                    variant="compact" sortBy={{ index: 0, direction: SortByDirection.asc }}
                />
            </ModalBody>
            <ModalFooter>
                <Button
                    id="btn-img-delete"
                    variant="danger"
                    {...(isPruning ? { spinnerAriaValueText: _("Pruning containers") } : {})}
                    isLoading={isPruning}
                    isDisabled={isPruning || selectedContainerKeys.length === 0}
                    onClick={handlePruneUnusedContainers}
                >
                    {isPruning ? _("Pruning containers") : _("Prune")}
                </Button>
                <Button variant="link" onClick={() => close()}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

export default PruneUnusedContainersModal;
