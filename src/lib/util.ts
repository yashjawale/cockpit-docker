/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Stateless helper functions used across the module.
 */

import { debounce } from 'throttle-debounce';

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
