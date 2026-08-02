/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Stateless helper functions used across the module.
 */

import { debounce } from 'throttle-debounce';

import cockpit from 'cockpit';

import type { ContainerStats } from './types.ts';

const _ = cockpit.gettext;

/**
 * Log a message to the console when the "docker" debugging flag is enabled.
 *
 * @param args Values to log, formatted like console.debug
 */
export function debug(...args: unknown[]): void {
    if (window.debugging === "all" || window.debugging?.includes("docker"))
        console.debug("docker", ...args);
}

/**
 * Container states in the order used for sorting the containers table,
 * derived from the Docker container state machine.
 */
export const states = [_("Created"), _("Restarting"), _("Running"), _("Paused"), _("Exited"), _("Removing"), _("Dead")];

/**
 * Whether a string is usable as a new container name.
 *
 * Docker only allows lowercase alphanumeric characters, underscores and
 * dashes, without leading separators.
 *
 * @param name The proposed container name
 */
export function is_valid_container_name(name: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}

/**
 * The CPU and memory usage shown for a container, computed from a raw docker
 * stats snapshot, or undefined when the snapshot does not carry the data.
 */
export interface ContainerStatsView {
    /** CPU usage as a percentage of all host CPUs, e.g. 12.34 */
    CPU?: number;
    /** Memory usage in bytes */
    MemUsage?: number;
    /** Memory limit in bytes, or undefined when the cgroup has no limit */
    MemLimit?: number;
}

/**
 * Compute CPU and memory usage from a docker stats snapshot.
 *
 * The CPU percentage is the ratio of the CPU time consumed since the previous
 * snapshot to the elapsed system CPU time, scaled to the number of online
 * CPUs, as the docker CLI does. The memory usage is the cgroup usage minus the
 * reclaimable inactive file cache, again matching the docker CLI.
 *
 * @param stats A raw snapshot from the containers/stats stream
 * @returns The CPU and memory values, or undefined fields when not computable
 */
export function dockerStatsToView(stats: ContainerStats): ContainerStatsView {
    const view: ContainerStatsView = {};

    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
    const onlineCpus = stats.cpu_stats?.online_cpus;
    if (systemDelta > 0 && cpuDelta > 0 && onlineCpus) {
        view.CPU = (cpuDelta / systemDelta) * onlineCpus * 100;
    }

    const memUsage = stats.memory_stats?.usage;
    const inactiveFile = stats.memory_stats?.stats?.inactive_file;
    if (Number.isInteger(memUsage)) {
        view.MemUsage = memUsage! - (Number.isInteger(inactiveFile) ? inactiveFile! : 0);
        const memLimit = stats.memory_stats?.limit;
        if (memLimit !== undefined && Number.isInteger(memLimit))
            view.MemLimit = memLimit;
    }

    return view;
}

/**
 * Return the primary tag of an image, or a placeholder when it has none.
 *
 * @param image Image object as returned by the Docker API
 * @returns The first repository tag of the image
 */
export function image_name(image: { RepoTags?: string[] | null }): string {
    return image.RepoTags?.[0] ?? "<none>:<none>";
}

// containers and images state are indexed by these keys, to make the ids
// globally unique across users
/**
 * Build a state key that is globally unique across users.
 *
 * @param uid The owner of the object, or null for the session user
 * @param id  The object id
 */
export const makeKey = (uid: number | null, id: string) => `${uid ?? "user"}-${id}`;

/**
 * Shorten an object id to its first 12 characters for display.
 *
 * The "sha256:" algorithm prefix is stripped first, as the docker CLI does,
 * so that only the digest is shown.
 *
 * @param id The full id
 * @returns The truncated digest without its algorithm prefix
 */
export function truncate_id(id: string): string {
    if (!id) {
        return "";
    }
    const digest = id.startsWith("sha256:") ? id.substring("sha256:".length) : id;
    return digest.substring(0, 12);
}

/** Predicate matching a single space character, used by the command-line quote helpers */
const is_whitespace = (c: string) => c === ' ';

/*
 * The functions quote_cmdline and unquote_cmdline implement
 * a simple shell-like quoting syntax.  They are used when letting the
 * user edit a sequence of words as a single string.
 *
 * When parsing, words are separated by whitespace.  Single and double
 * quotes can be used to protect a sequence of characters that
 * contains whitespace or the other quote character.  A backslash can
 * be used to protect any character.  Quotes can appear in the middle
 * of a word.
 */

/**
 * Quote an array of words into a single shell-like command line string.
 *
 * @param words The list of words to quote
 * @returns The quoted command line
 */
export function quote_cmdline(words: string[] | undefined): string {
    words = words || [];

    function quote(word: string): string {
        let text = "";
        let quote_char = "";
        let i: number;
        for (i = 0; i < word.length; i++) {
            if (word[i] === '\\' || word[i] === quote_char)
                text += '\\';
            else if (quote_char === "") {
                if (word[i] === "'" || is_whitespace(word[i]))
                    quote_char = '"';
                else if (word[i] === '"')
                    quote_char = "'";
            }
            text += word[i];
        }

        return quote_char + text + quote_char;
    }

    return words.map(quote).join(' ');
}

/**
 * Parse a shell-like command line string back into an array of words.
 *
 * @param text The command line to parse
 * @returns The list of unquoted words
 */
export function unquote_cmdline(text: string): string[] {
    const words: string[] = [];
    let next = 0;

    function skip_whitespace() {
        while (next < text.length && is_whitespace(text[next]))
            next++;
    }

    function parse_word() {
        let word = "";
        let quote_char: string | null = null;

        while (next < text.length) {
            if (text[next] === '\\') {
                next++;
                if (next < text.length) {
                    word += text[next];
                }
            } else if (text[next] === quote_char) {
                quote_char = null;
            } else if (quote_char) {
                word += text[next];
            } else if (text[next] === '"' || text[next] === "'") {
                quote_char = text[next];
            } else if (is_whitespace(text[next])) {
                break;
            } else
                word += text[next];
            next++;
        }
        return word;
    }

    skip_whitespace();
    while (next < text.length) {
        words.push(parse_word());
        skip_whitespace();
    }

    return words;
}

/** Object mapping form field names to their validation error messages */
type ValidationState = Record<string, string>;
/** Callback that receives an updated validation state */
type ValidationHandler = (state: ValidationState) => void;

/**
 * Clear a single field from the validationFailed object.
 *
 * @param validationFailed   Object containing the fields with validation errors
 * @param key                The field whose error is to be cleared
 * @param onValidationChange Callback invoked with the updated validation object
 */
export const validationClear = (validationFailed: ValidationState | undefined, key: string, onValidationChange?: ValidationHandler) => {
    if (!validationFailed || !onValidationChange)
        return;

    const delta = { ...validationFailed };
    delete delta[key];
    onValidationChange(delta);
};

/**
 * Debounced wrapper that defers a validation run by 500ms.
 *
 * Defined at module scope because a debounce instance must survive re-renders;
 * recreating it inside a component would reset the timer on every render.
 */
export const validationDebounce = debounce(500, (validationHandler: () => void) => validationHandler());
