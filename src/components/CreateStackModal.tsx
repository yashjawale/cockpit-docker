/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Dialog creating a new docker-compose stack: a project directory in the
 * session user's stacks directory, holding a docker-compose.yml and .env file.
 */

import React, { useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { FormHelper } from 'cockpit-components-form-helper.jsx';
import { useDialogs } from "dialogs.jsx";

import { CodeEditor, Language } from '@patternfly/react-code-editor';
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

import cockpit from 'cockpit';
import * as dockerNames from 'docker-names';

import { ErrorNotification } from './Notification.tsx';
import * as client from '../lib/client.ts';
import { is_valid_container_name } from '../lib/util.ts';

const _ = cockpit.gettext;

// The plugin bundles Monaco locally (see build.js), so point the loader at our
// bundled instance instead of the CDN and provide our own web worker. The
// worker is emitted as a sibling "editor.worker.js" of the main bundle; derive
// its URL from the document base since the main bundle is not a module.
loader.config({ monaco });
self.MonacoEnvironment = {
    getWorker: () => new Worker(new URL('editor.worker.js', document.baseURI)),
};

/** The default docker-compose.yml content of a new stack */
const DEFAULT_COMPOSE = `# Define your stack here, e.g.
services:
  web:
    image: nginx:latest
    ports:
      - "8080:80"
`;

/** The default .env content of a new stack */
const DEFAULT_ENV = `# Environment variables for the stack, e.g.
# FOO=bar
`;

/**
 * Dialog creating or editing a docker-compose stack.
 *
 * Asks for a project name and lets the user edit the stack's docker-compose.yml
 * and .env files. On save both files are written into the session user's
 * stacks directory, so they are owned by the user and behave like a local
 * `docker compose up` in the user's home.
 */
const CreateStackModal = ({ projectName, initialCompose, initialEnv, initialBuild, onStackCreated }: {
    /** The project name to prefill; defaults to a random name when creating */
    projectName?: string,
    /** The docker-compose.yml content to prefill; defaults to a template */
    initialCompose?: string,
    /** The .env content to prefill; defaults to a template */
    initialEnv?: string,
    /** Whether starting the stack builds local images; read from the marker file when editing */
    initialBuild?: boolean,
    /** Invoked after the stack files have been written (not on edit) */
    onStackCreated?: () => void,
}) => {
    const Dialogs = useDialogs();
    const [name, setName] = useState(projectName ?? dockerNames.getRandomName());
    const [nameError, setNameError] = useState("");
    const [compose, setCompose] = useState(initialCompose ?? DEFAULT_COMPOSE);
    const [env, setEnv] = useState(initialEnv ?? DEFAULT_ENV);
    const [build, setBuild] = useState(initialBuild ?? false);
    const [inProgress, setInProgress] = useState(false);
    const [dialogError, setDialogError] = useState("");
    const [dialogErrorDetail, setDialogErrorDetail] = useState("");

    /**
     * Validate the project name as the user types it.
     *
     * @param value The new value of the name field
     */
    const handleInputChange = (value: string) => {
        setName(value);
        if (value === "") {
            setNameError(_("Project name is required."));
        } else if (is_valid_container_name(value)) {
            setNameError("");
        } else {
            setNameError(_("Invalid characters. Name can only contain letters, numbers, and certain punctuation (_ . -)."));
        }
    };

    /**
     * Write the stack files into the session user's stacks directory,
     * closing the dialog on success. The build flag is stored as a marker
     * file, so it applies to the later `docker compose up` that starts the
     * stack. The stack is not started automatically; the user starts it
     * later from the inactive stacks section.
     */
    const handleSave = () => {
        if (!name) {
            setNameError(_("Project name is required."));
            return;
        }

        setNameError("");
        setDialogError("");
        setInProgress(true);

        const dir = `${client.getStacksDir()}/${name}`;
        cockpit.spawn(["mkdir", "-p", dir], { err: "message" })
                .then(() => cockpit.file(`${dir}/docker-compose.yml`).replace(compose))
                .then(() => cockpit.file(`${dir}/.env`).replace(env))
                .then(() => client.writeBuildFlag(dir, build))
                .then(() => {
                    if (!projectName)
                        onStackCreated?.();
                    Dialogs.close();
                })
                .catch(ex => {
                    setInProgress(false);
                    setDialogError(cockpit.format(_("Failed to create stack $0"), name)); // not-covered: OS error
                    setDialogErrorDetail(cockpit.format("$0: $1", ex.message, ex.reason ?? ""));
                });
    };

    return (
        <Modal
            isOpen
            position="top" variant="medium"
            onClose={() => Dialogs.close()}
        >
            <ModalHeader title={projectName ? cockpit.format(_("Edit stack $0"), projectName) : _("Create stack")} />
            <ModalBody>
                {dialogError && <ErrorNotification errorMessage={dialogError} errorDetail={dialogErrorDetail} onDismiss={() => setDialogError("")} />}
                <Form isHorizontal>
                    <FormGroup fieldId="create-stack-dialog-name" label={_("Project name")}>
                        <TextInput
                            id="create-stack-dialog-name"
                            value={name}
                            validated={nameError ? "error" : "default"}
                            type="text"
                            aria-label={nameError ?? ""}
                            onChange={(_, value) => handleInputChange(value)}
                        />
                        <FormHelper fieldId="create-stack-dialog-name" helperTextInvalid={nameError ?? undefined} />
                    </FormGroup>
                    <FormGroup fieldId="create-stack-dialog-build" label={_("Options")} isStack hasNoPaddingTop>
                        <Checkbox
                            id="create-stack-dialog-build"
                            isChecked={build}
                            onChange={(_, checked) => setBuild(checked)}
                            label={_("Build local images when starting")}
                            body={_("Runs docker compose up --build when starting the stack, for images built from a Dockerfile in the stack folder.")}
                        />
                    </FormGroup>
                    <FormGroup fieldId="create-stack-dialog-compose" label={_("docker-compose.yml")}>
                        <CodeEditor
                            id="create-stack-dialog-compose"
                            language={Language.yaml}
                            code={compose}
                            onChange={(value) => setCompose(value)}
                            height="300px"
                            isMinimapVisible={false}
                            isDarkTheme
                        />
                    </FormGroup>
                    <FormGroup fieldId="create-stack-dialog-env" label={_(".env")}>
                        <CodeEditor
                            id="create-stack-dialog-env"
                            language={Language.plaintext}
                            code={env}
                            onChange={(value) => setEnv(value)}
                            height="300px"
                            isMinimapVisible={false}
                            isDarkTheme
                        />
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button
                    variant="primary"
                    id="create-stack-dialog-create-btn"
                    isDisabled={!!nameError}
                    isLoading={inProgress}
                    onClick={handleSave}
                >
                    {projectName ? _("Save") : _("Create stack")}
                </Button>
                <Button
                    variant="link"
                    className="btn-cancel"
                    onClick={() => Dialogs.close()}
                    isDisabled={inProgress}
                >
                    {_("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
};

export default CreateStackModal;
