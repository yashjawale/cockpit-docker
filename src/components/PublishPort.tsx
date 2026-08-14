/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Dynamic-list row that edits a single port mapping.
 */

import React from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect";
import { Popover } from "@patternfly/react-core/dist/esm/components/Popover";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { Grid } from "@patternfly/react-core/dist/esm/layouts/Grid";
import { OutlinedQuestionCircleIcon, TrashIcon } from '@patternfly/react-icons';
import { FormHelper } from "cockpit-components-form-helper.jsx";
import ipaddr from "ipaddr.js";

import cockpit from 'cockpit';

import { validationClear, validationDebounce } from '../lib/util.ts';

import type { DynamicListRowProps } from '../lib/types.ts';

const _ = cockpit.gettext;

/** Highest port number that can be mapped */
const MAX_PORT = 65535;

/**
 * Validate a port mapping field.
 *
 * @param value The value to validate
 * @param key   Either "IP", "hostPort" or "containerPort"
 * @returns An error message, or an empty string when the value is valid
 */
export function validatePublishPort(value: string | number | null | undefined, key: "IP" | "hostPort" | "containerPort"): string {
    const str = value === null || value === undefined ? "" : String(value);
    switch (key) {
    case "IP":
        if (str && !ipaddr.isValid(str))
            return _("Must be a valid IP address");
        break;
    case "hostPort": {
        if (str) {
            // use Number() so that fractional ("1.5") and non-numeric ("abc")
            // input is rejected instead of parseInt silently truncating to 1
            const hostPort = Number(str);
            if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > MAX_PORT)
                return _("1 to 65535");
        }

        break;
    }
    case "containerPort": {
        if (!str)
            return _("Container port must not be empty");

        const containerPort = Number(str);
        if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > MAX_PORT)
            return _("1 to 65535");

        break;
    }
    default:
        console.error(`Unknown key "${key}"`); // not-covered: unreachable assertion
    }
    return "";
}

/**
 * A single port mapping row of the run-image dialog.
 *
 * Maps a host IP and port to a container port over TCP or UDP. The IP and
 * ports are validated with validatePublishPort, and help popovers explain the
 * default binding behavior.
 */
export const PublishPort = ({ id, item, onChange, idx, removeitem, validationFailed, onValidationChange }: DynamicListRowProps) => (
    <Grid hasGutter id={id}>
        <FormGroup
            className="pf-m-5-col-on-md"
            id={`${id}-ip-address-group`}
            label={_("IP address")}
            fieldId={`${id}-ip-address`}
            labelHelp={
                <Popover
                    aria-label={_("IP address help")}
                    enableFlip
                    bodyContent={_("If host IP is set to 0.0.0.0 or not set at all, the port will be bound on all IPs on the host.")}
                >
                    <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
                </Popover>
            }
        >
            <TextInput
                id={`${id}-ip-address`}
                value={item.IP || ''}
                validated={validationFailed?.IP ? "error" : "default"}
                onChange={(_event, value) => {
                    validationClear(validationFailed, "IP", onValidationChange);
                    validationDebounce(id + "-IP", () => onValidationChange?.({ ...validationFailed, IP: validatePublishPort(value, "IP") }));
                    onChange(idx, 'IP', value);
                }}
            />
            <FormHelper helperTextInvalid={validationFailed?.IP} />
        </FormGroup>
        <FormGroup
            className="pf-m-2-col-on-md"
            id={`${id}-host-port-group`}
            label={_("Host port")}
            fieldId={`${id}-host-port`}
            labelHelp={
                <Popover
                    aria-label={_("Host port help")}
                    enableFlip
                    bodyContent={_("If the host port is not set the container port will be randomly assigned a port on the host.")}
                >
                    <Button variant="plain" hasNoPadding aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
                </Popover>
            }
        >
            <TextInput
                id={`${id}-host-port`}
                type='number'
                step={1}
                min={1}
                max={MAX_PORT}
                value={item.hostPort || ''}
                validated={validationFailed?.hostPort ? "error" : "default"}
                onChange={(_event, value) => {
                    validationClear(validationFailed, "hostPort", onValidationChange);
                    validationDebounce(id + "-hostPort", () => onValidationChange?.({ ...validationFailed, hostPort: validatePublishPort(value, "hostPort") }));
                    onChange(idx, 'hostPort', value);
                }}
            />
            <FormHelper helperTextInvalid={validationFailed?.hostPort} />
        </FormGroup>
        <FormGroup
            className="pf-m-3-col-on-md"
            id={`${id}-container-port-group`}
            label={_("Container port")}
            fieldId={`${id}-container-port`}
            isRequired
        >
            <TextInput
                id={`${id}-container-port`}
                type='number'
                step={1}
                min={1}
                max={MAX_PORT}
                validated={validationFailed?.containerPort ? "error" : "default"}
                value={item.containerPort || ''}
                onChange={(_event, value) => {
                    validationClear(validationFailed, "containerPort", onValidationChange);
                    validationDebounce(id + "-containerPort", () => onValidationChange?.({ ...validationFailed, containerPort: validatePublishPort(value, "containerPort") }));
                    onChange(idx, 'containerPort', value);
                }}
            />
            <FormHelper helperTextInvalid={validationFailed?.containerPort} />
        </FormGroup>
        <FormGroup
            className="pf-m-2-col-on-md"
            label={_("Protocol")}
            fieldId={`${id}-protocol`}
        >
            <FormSelect
                className='pf-v6-c-form-control container-port-protocol'
                id={`${id}-protocol`}
                value={item.protocol || 'tcp'}
                onChange={(_event, value) => onChange(idx, 'protocol', value)}
            >
                <FormSelectOption value='tcp' key='tcp' label={_("TCP")} />
                <FormSelectOption value='udp' key='udp' label={_("UDP")} />
            </FormSelect>
        </FormGroup>
        <FormGroup className="pf-m-1-col-on-md remove-button-group">
            <Button
                variant='plain'
                className="btn-close"
                id={`${id}-btn-close`}
                size="sm"
                aria-label={_("Remove item")}
                icon={<TrashIcon />}
                onClick={() => removeitem(idx)}
            />
        </FormGroup>
    </Grid>
);
