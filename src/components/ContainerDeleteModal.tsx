/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Confirmation dialog for deleting a stopped container.
 */

import React from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';

import * as client from '../lib/client.ts';

import type { Connection } from '../lib/rest.ts';
import type { DockerContainer, Notification } from '../lib/types.ts';

const _ = cockpit.gettext;

/**
 * Modal confirming the deletion of a stopped container.
 */
const ContainerDeleteModal = ({ con, containerWillDelete, onAddNotification }: {
    con: Connection,
    containerWillDelete: DockerContainer,
    onAddNotification: (notification: Notification) => void,
}) => {
    const Dialogs = useDialogs();

    /**
     * Delete the container, closing the dialog first and reporting errors as
     * a toast notification.
     */
    const handleRemoveContainer = () => {
        const container = containerWillDelete;
        const id = container ? container.Id : "";

        Dialogs.close();
        client.delContainer(con, id, false)
                .catch(ex => {
                    const error = cockpit.format(_("Failed to remove container $0"), container.Name); // not-covered: OS error
                    onAddNotification({ type: 'danger', error, errorDetail: ex.message });
                });
    };

    return (
        <Modal
isOpen
               position="top" variant="medium"
               onClose={() => Dialogs.close()}
        >
            <ModalHeader
title={cockpit.format(_("Delete $0?"), containerWillDelete.Name)}
                titleIconVariant="warning"
            />
            <ModalBody>
                {_("Deleting a container will erase all data in it.")}
            </ModalBody>
            <ModalFooter>
                <Button variant="danger" className="btn-ctr-delete" onClick={handleRemoveContainer}>{_("Delete")}</Button>{' '}
                <Button variant="link" onClick={() => Dialogs.close()}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

export default ContainerDeleteModal;
