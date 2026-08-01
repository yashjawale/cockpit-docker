/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/**
 * Log a message to the console when the "docker" debugging flag is enabled.
 *
 * @param args Values to log, formatted like console.debug
 */
export function debug(...args: unknown[]): void {
    if (window.debugging === "all" || window.debugging?.includes("docker"))
        console.debug("docker", ...args);
}
