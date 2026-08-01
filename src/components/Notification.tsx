/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Inline error alert that logs each distinct message to the console once.
 */

import React from 'react';

import { Alert, AlertActionCloseButton } from "@patternfly/react-core/dist/esm/components/Alert";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

/** The last error message logged, used to avoid repeating identical log lines */
let last_error = "";

/**
 * Log an error to the browser console, but only if it differs from the
 * previously logged one, to keep the log readable during repeated failures.
 *
 * @param error The error message to log
 */
function log_error_if_changed(error: string) {
    // Put the error in the browser log, for easier debugging and
    // matching of known issues in the integration tests.
    if (error !== last_error) {
        last_error = error;
        console.error(error);
    }
}

/**
 * Render an inline error alert, logging the message to the console at most once.
 *
 * @param errorMessage  The main error title to display
 * @param errorDetail   Optional additional error details
 * @param onDismiss     Optional callback shown as a close button
 */
export const ErrorNotification = ({
    errorMessage,
    errorDetail,
    onDismiss,
} : {
    errorMessage: string,
    errorDetail?: string,
    onDismiss?: () => void,
}) => {
    log_error_if_changed(errorMessage + (errorDetail ? `: ${errorDetail}` : ""));
    return (
        <Alert
            isInline
            variant='danger'
            title={errorMessage}
            actionClose={onDismiss ? <AlertActionCloseButton onClose={onDismiss} /> : null}
        >
            { errorDetail && <p> {_("Error message")}: <samp>{errorDetail}</samp> </p> }
        </Alert>
    );
};
