/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Ambient types for the untyped "docker-names" package.
 */
declare module "docker-names" {
    export function getRandomName(appendNumber?: boolean | number): string;
}
