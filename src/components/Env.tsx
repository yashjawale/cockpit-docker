/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Dynamic-list row that edits a single environment variable.
 */

import React from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { Grid } from "@patternfly/react-core/dist/esm/layouts/Grid";
import { TrashIcon } from '@patternfly/react-icons';
import { FormHelper } from "cockpit-components-form-helper.jsx";

import cockpit from 'cockpit';

import { validationClear, validationDebounce } from '../lib/util.ts';

import type { DynamicListRowProps } from '../lib/types.ts';

const _ = cockpit.gettext;

/**
 * Validate an environment variable key or value.
 *
 * @param env The value to validate
 * @param key Either "envKey" or "envValue"
 * @returns An error message, or an empty string when the value is valid
 */
export function validateEnvVar(env: string, key: "envKey" | "envValue"): string {
    const re = /^[a-zA-Z_]{1,}[a-zA-Z0-9_]*$/;
    switch (key) {
    case "envKey":
        if (!env)
            return _("Key must not be empty");
        if (/^\d/.test(env))
            return _("Key must not begin with a digit");
        if (!re.test(env))
            return _("Key contains invalid characters");
        break;
    case "envValue":
        break;
    default:
        console.error(`Unknown key "${key}"`); // not-covered: unreachable assertion
    }
    return "";
}

/**
 * Handle editing an environment variable field, supporting bulk import.
 *
 * When the typed value contains "=" and the companion field (the other env
 * field of the row) is empty, the value is split on whitespace and every
 * KEY=VALUE pair is spread across existing and newly added rows.
 *
 * @param key           The field being edited, either "envKey" or "envValue"
 * @param value         The newly typed value
 * @param idx           Index of the row being edited
 * @param onChange      Callback storing the value into the row
 * @param additem       Callback adding a new row, used for bulk import
 * @param _itemCount    Number of rows, currently unused
 * @param companionField Value of the other env field of this row
 */
const handleEnvValue = (
    key: string,
    value: string,
    idx: number,
    onChange: (idx: number, field: string, value: string | null) => void,
    additem: () => void,
    _itemCount: number | undefined,
    companionField: string | number | null | undefined
) => {
    // Allow the input of KEY=VALUE separated value pairs for bulk import only if the other
    // field is not empty.
    if (value.includes('=') && !companionField) {
        // split on any whitespace so that space- and newline-separated pairs
        // (the helper text promises "one or more lines") both bulk-import
        const parts = value.trim().split(/\s+/);
        let index = idx;
        for (const part of parts) {
            const [envKey, ...envVar] = part.split('=');
            if (!envKey || !envVar) {
                continue;
            }

            if (index !== idx) {
                additem();
            }
            onChange(index, 'envKey', envKey);
            onChange(index, 'envValue', envVar.join('='));
            index++;
        }
    } else {
        onChange(idx, key, value);
    }
};

/**
 * A single environment variable row of the run-image dialog.
 *
 * Both the key and the value are free-form text inputs; the key is validated
 * with the standard shell variable naming rules.
 */
export const EnvVar = ({ id, item, onChange, idx, removeitem, additem, itemCount, validationFailed, onValidationChange }: DynamicListRowProps) => (
    <Grid hasGutter id={id}>
        <FormGroup
            className="pf-m-6-col-on-md"
            id={`${id}-key-group`}
            label={_("Key")}
            fieldId={`${id}-key-address`}
            isRequired
        >
            <TextInput
                id={`${id}-key`}
                value={item.envKey || ''}
                validated={validationFailed?.envKey ? "error" : "default"}
                onChange={(_event, value) => {
                    validationClear(validationFailed, "envKey", onValidationChange);
                    validationDebounce(() => onValidationChange?.({ ...validationFailed, envKey: validateEnvVar(value, "envKey") }));
                    handleEnvValue('envKey', value, idx, onChange, additem, itemCount, item.envValue);
                }}
            />
            <FormHelper helperTextInvalid={validationFailed?.envKey} />
        </FormGroup>
        <FormGroup
            className="pf-m-6-col-on-md"
            id={`${id}-value-group`}
            label={_("Value")}
            fieldId={`${id}-value-address`}
        >
            <TextInput
                id={`${id}-value`}
                value={item.envValue || ''}
                validated={validationFailed?.envValue ? "error" : "default"}
                onChange={(_event, value) => {
                    validationClear(validationFailed, "envValue", onValidationChange);
                    validationDebounce(() => onValidationChange?.({ ...validationFailed, envValue: validateEnvVar(value, "envValue") }));
                    handleEnvValue('envValue', value, idx, onChange, additem, itemCount, item.envKey);
                }}
            />
            <FormHelper helperTextInvalid={validationFailed?.envValue} />
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
