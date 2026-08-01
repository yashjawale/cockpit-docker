/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Confirmation dialog shown when an operation needs to be forced to succeed.
 */

import React, { useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

/**
 * Confirm a destructive action that failed with the given reason.
 *
 * @param name              The name of the object that will be deleted
 * @param reason            The error that triggered the force-remove prompt
 * @param handleForceRemove Async callback run when the user confirms
 */
const ForceRemoveModal = ({ name, reason, handleForceRemove }: {
    name: string,
    reason: string,
    handleForceRemove: () => Promise<void>,
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
            <ModalHeader
                title={cockpit.format(_("Delete $0?"), name)}
                titleIconVariant="warning"
            />
            <ModalBody>
                {reason}
            </ModalBody>
            <ModalFooter>
                <Button
                    variant="danger"
                    isDisabled={inProgress}
                    isLoading={inProgress}
                    onClick={() => { setInProgress(true); handleForceRemove().catch(() => setInProgress(false)) }}
                >
                    {_("Force delete")}
                </Button>
                <Button variant="link" isDisabled={inProgress} onClick={() => Dialogs.close()}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

export default ForceRemoveModal;
