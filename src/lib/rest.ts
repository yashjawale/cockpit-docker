/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Low-level HTTP connection handling for the Docker daemon unix socket.
 */

import cockpit from "cockpit";

import { debug } from "./util.ts";

type JsonObject = cockpit.JsonObject;

// make this `unknown` to conveniently call it on raw error objects
/**
 * Merge an HTTP error object with the response content received from the daemon.
 *
 * The content is expected to be a JSON string (e.g. the daemon's error message);
 * if it cannot be parsed it is stored verbatim in the returned object's message field.
 *
 * @param error   The low-level error object from the HTTP request
 * @param content The raw response body, or a parsed object if it was not a string
 * @returns The error object augmented with any parsed server-provided fields
 */
function format_error(error: object, content: unknown): object {
    let content_o: JsonObject = {};
    if (typeof content === 'string') {
        try {
            content_o = JSON.parse(content);
        } catch {
            content_o.message = content;
        }
        return { ...error, ...content_o };
    } else {
        console.warn("format_error(): content is not a string:", content);
        return error;
    }
}

// calls are async, so keep track of a call counter to associate a result with a call
let call_id = 0;

const NL = '\n'.charCodeAt(0); // always 10, but avoid magic constant
const CR = '\r'.charCodeAt(0); // always 13, but avoid magic constant

/** Unix socket path of the system-wide Docker daemon, only reachable by root */
const DOCKER_SYSTEM_ADDRESS = "/var/run/docker.sock";

/** A standard Unix UID, or null for the logged in session user */
export type Uid = number | null;

/** Sentinel uid identifying the Docker Desktop daemon, which is not a real user */
export const UID_DOCKER_DESKTOP = -1;

// FIXME: export SuperuserMode in cockpit.d.ts, and use it here
/**
 * Resolve the Docker daemon socket address for a given user.
 *
 * @param uid The user id to resolve the socket for, or null for the session user
 * @returns The unix socket path and, when applicable, the superuser mode to use
 */
function getAddress(uid: Uid): { path: string, superuser?: cockpit.ChannelOptions["superuser"] } {
    if (uid === UID_DOCKER_DESKTOP) {
        // Docker Desktop exposes its daemon on a socket inside the user's home.
        const home = sessionStorage.getItem('DOCKER_DESKTOP_HOME');
        if (home)
            return { path: `${home}/.docker/desktop/docker.sock` };
        console.warn("$HOME is not present. Cannot use Docker Desktop.");
        return { path: "" };
    }

    if (uid === null) {
        // FIXME: make this async and call cockpit.user()
        const xrd = sessionStorage.getItem('XDG_RUNTIME_DIR');
        if (xrd)
            return { path: `${xrd}/docker.sock` };
        console.warn("$XDG_RUNTIME_DIR is not present. Cannot use user service.");
        return { path: "" };
    }

    if (uid === 0)
        return { path: DOCKER_SYSTEM_ADDRESS, superuser: "require" };

    if (Number.isInteger(uid))
        return { path: `/run/user/${uid}/docker.sock`, superuser: "require" };

    throw new Error(`getAddress: uid ${uid} not supported`);
}

/**
 * Find the offset of the \r\n\r\n separator of an HTTP response, or -1.
 *
 * The daemon may deliver the response header split across several channel
 * messages, so the caller buffers the data until the separator is complete.
 *
 * @param array The raw binary bytes of an HTTP response received so far
 * @returns The index of the \r\n\r\n separator, or -1 when it is not complete yet
 */
function findNLNL(array: Uint8Array): number {
    for (let i = 0; i <= array.length - 4; i++) {
        if (array[i] === CR && array[i + 1] === NL && array[i + 2] === CR && array[i + 3] === NL) {
            return i;
        }
    }
    return -1;
}

/** Callback invoked with each parsed JSON message of a streaming endpoint */
export type MonitorCallbackJson = (data: JsonObject) => void;
/** Callback invoked with each raw binary message of a streaming endpoint */
export type MonitorCallbackRaw = (data: Uint8Array) => void;
/** Union of the possible monitor callbacks, selected via the return_raw flag */
export type MonitorCallback = MonitorCallbackJson | MonitorCallbackRaw;

// type predicate helper for narrowing which monitor callback is being used
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function isReturnRaw(return_raw: boolean, callback: MonitorCallback): callback is MonitorCallbackRaw {
    return return_raw;
}

/** A connection to the Docker daemon used to make API calls and stream data */
export type Connection = {
    uid: Uid;
    /** Subscribe to a streaming endpoint, invoking callback for every JSON line or raw message */
    monitor: (path: string, callback: MonitorCallback, return_raw?: boolean) => Promise<void>;
    /** Make a single HTTP request and resolve with the raw response body */
    call: (options: JsonObject) => Promise<string>;
    /** Close the underlying HTTP connection and any streaming channels */
    close: () => void;
};

/**
 * Establish a connection to the Docker daemon for the given user.
 *
 * No channel is actually created until the first request is made. A binary
 * channel is used so that raw streams (terminal and logs) can transport
 * arbitrary bytes, see https://github.com/cockpit-project/cockpit/issues/19235.
 *
 * @param uid The user id to connect as, or null for the session user
 * @returns A connection object bound to the resolved docker socket
 */
function connect(uid: Uid): Connection {
    const addr = getAddress(uid);
    /* This doesn't create a channel until a request */
    const http = cockpit.http(addr.path, { superuser: addr.superuser, binary: true });
    const raw_channels: cockpit.Channel<Uint8Array>[] = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const user_str = (uid === null) ? "user" : (uid === 0) ? "root" : `uid ${uid}`;

    /**
     * Perform a single HTTP request against the Docker daemon.
     *
     * @param options Request options including method, path, body and params
     * @returns A promise resolving to the response body as a string
     */
    function call(options: JsonObject): Promise<string> {
        const id = call_id++;
        debug(user_str, `call ${id}:`, JSON.stringify(options));
        return new Promise((resolve, reject) => {
            options = options || {};
            http.request(options)
                    .then((result: Uint8Array) => {
                        const text = decoder.decode(result);
                        debug(user_str, `call ${id} result:`, text);
                        resolve(text);
                    })
                    // @ts-expect-error: magic cockpit defer error extra "content" parameter
                    .catch((error: object, content: unknown) => {
                        const content_text = (content instanceof Uint8Array)
                            ? decoder.decode(content as Uint8Array)
                            : content;
                        debug(user_str, `call ${id} error:`, JSON.stringify(error), "content", content_text);
                        reject(format_error(error, content_text));
                    });
        });
    }

    /**
     * Subscribe to a streaming endpoint of the Docker daemon.
     *
     * @param path       Request path, including any query parameters
     * @param callback   Invoked for each newline-delimited JSON line, or raw data when return_raw is set
     * @param return_raw When true the callback receives raw binary data instead of parsed JSON
     * @returns A promise resolving once the stream is closed
     */
    function monitor(path: string, callback: MonitorCallback, return_raw: boolean = false): Promise<void> {
        return new Promise((resolve, reject) => {
            const ch = cockpit.channel({ unix: addr.path, superuser: addr.superuser, payload: "stream", binary: true });
            raw_channels.push(ch);
            let buffer = new Uint8Array();
            let http_buffer = new Uint8Array();

            ch.addEventListener("close", () => {
                debug(user_str, "monitor", path, "closed");
                resolve();
            });

            const onHTTPMessage = (event: unknown, message: Uint8Array) => {
                // The daemon may split the response header across several messages,
                // so accumulate until the header/body separator is complete.
                http_buffer = new Uint8Array([...http_buffer, ...message]);
                const idx = findNLNL(http_buffer);
                if (idx < 0)
                    return;
                ch.removeEventListener("message", onHTTPMessage);

                const headers = decoder.decode(http_buffer.subarray(0, idx));
                const body = http_buffer.subarray(idx + 4);
                http_buffer = new Uint8Array();
                debug(user_str, "monitor", path, "HTTP response:", headers);
                if (headers.match(/^HTTP\/1.*\s+200\s/)) {
                    // any further message is actual streaming data
                    ch.addEventListener("message", onDataMessage);

                    // process the initial response data
                    if (body.length > 0)
                        onDataMessage(event, body);
                } else {
                    // empty body should not happen, would be a docker bug
                    const body_text = body.length > 0 ? decoder.decode(body) : "(empty)";
                    // the request failed, so the channel will never stream data;
                    // close it and drop it so that it does not leak
                    const chIndex = raw_channels.indexOf(ch);
                    if (chIndex >= 0)
                        raw_channels.splice(chIndex, 1);
                    ch.close();
                    reject(format_error({ reason: headers.split('\r\n')[0] }, body_text));
                }
            };

            const onDataMessage = (_event: unknown, message: Uint8Array) => {
                if (isReturnRaw(return_raw, callback)) {
                    debug(user_str, "monitor", path, "raw data:", message);
                    callback(message);
                } else {
                    buffer = new Uint8Array([...buffer, ...message]);

                    // split the buffer into lines on NL (this is safe with UTF-8)
                    for (;;) {
                        const idx = buffer.indexOf(NL);
                        if (idx < 0)
                            break;

                        const line = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 1);

                        const line_str = decoder.decode(line);
                        debug(user_str, "monitor", path, "data:", line_str);
                        callback(JSON.parse(line_str));
                    }
                }
            };

            // the initial message is the HTTP status response
            ch.addEventListener("message", onHTTPMessage);

            ch.send(encoder.encode(`GET ${path} HTTP/1.0\r\nContent-Length: 0\r\n\r\n`));
        });
    }

    /**
     * Close the HTTP connection and all open streaming channels.
     */
    function close(): void {
        http.close();
        raw_channels.forEach(ch => ch.close());
    }

    return { uid, monitor, call, close };
}

export default {
    /** Establish a connection to the Docker daemon for the given user */
    connect,
    /** Resolve the Docker daemon socket address for a given user */
    getAddress,
};
