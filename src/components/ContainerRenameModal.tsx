/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Dialog renaming a stopped container.
 */

import React, { useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { FormHelper } from 'cockpit-components-form-helper.jsx';
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';

import { ErrorNotification } from './Notification.tsx';
import * as client from '../lib/client.ts';
import { is_valid_container_name } from '../lib/util.ts';

import type { Connection } from '../lib/rest.ts';
import type { DockerContainer } from '../lib/types.ts';

const _ = cockpit.gettext;

/**
 * Dialog renaming a stopped container.
 */
const ContainerRenameModal = ({ con, container }: {
    con: Connection,
    container: DockerContainer,
}) => {
    const Dialogs = useDialogs();
    const [name, setName] = useState(container.Name);
    const [nameError, setNameError] = useState("");
    const [dialogError, setDialogError] = useState("");
    const [dialogErrorDetail, setDialogErrorDetail] = useState("");

    /**
     * Validate the new name as the user types it.
     *
     * @param targetName The changed field, only "name" is handled
     * @param value      The new value of the field
     */
    const handleInputChange = (targetName: string, value: string) => {
        if (targetName === "name") {
            setName(value);
            if (value === "") {
                setNameError(_("Container name is required."));
            } else if (is_valid_container_name(value)) {
                setNameError("");
            } else {
                setNameError(_("Invalid characters. Name can only contain letters, numbers, and certain punctuation (_ . -)."));
            }
        }
    };

    /**
     * Rename the container, closing the dialog on success.
     */
    const handleRename = () => {
        if (!name) {
            setNameError(_("Container name is required."));
            return;
        }

        setNameError("");
        setDialogError("");
        client.renameContainer(con, container.Id, name)
                .then(Dialogs.close)
                .catch(ex => {
                    setDialogError(cockpit.format(_("Failed to rename container $0"), container.Name)); // not-covered: OS error
                    setDialogErrorDetail(cockpit.format("$0: $1", ex.message, ex.reason));
                });
    };

    /**
     * Submit the form when the user presses Enter.
     *
     * @param event The keyboard event
     */
    const handleKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === "Enter") {
            event.preventDefault();
            handleRename();
        }
    };

    const renameContent = (
        <Form isHorizontal>
            <FormGroup fieldId="rename-dialog-container-name" label={_("New container name")}>
                <TextInput
                    id="rename-dialog-container-name"
                    value={name}
                    validated={nameError ? "error" : "default"}
                    type="text"
                    aria-label={nameError ?? ""}
                    onChange={(_, value) => handleInputChange("name", value)}
                />
                <FormHelper fieldId="rename-dialog-container-name" helperTextInvalid={nameError ?? undefined} />
            </FormGroup>
        </Form>
    );

    return (
        <Modal
            isOpen
            position="top" variant="medium"
            onClose={() => Dialogs.close()}
            onKeyDown={handleKeyDown}
        >
            <ModalHeader title={cockpit.format(_("Rename container $0"), container.Name)} />
            <ModalBody>
                {dialogError && <ErrorNotification errorMessage={dialogError} errorDetail={dialogErrorDetail} onDismiss={() => setDialogError("")} />}
                {renameContent}
            </ModalBody>
            <ModalFooter>
                <Button
variant="primary"
                        className="btn-ctr-rename"
                        id="btn-rename-dialog-container"
                        isDisabled={!!nameError}
                        onClick={handleRename}
                >
                    {_("Rename")}
                </Button>
                <Button
variant="link"
                        className="btn-ctr-cancel-commit"
                        onClick={() => Dialogs.close()}
                >
                    {_("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
};

export default ContainerRenameModal;
