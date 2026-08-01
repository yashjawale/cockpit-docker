/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
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

const DOCKER_SYSTEM_ADDRESS = "/var/run/docker.sock";

/** A standard Unix UID, or null for the logged in session user */
export type Uid = number | null;

// FIXME: export SuperuserMode in cockpit.d.ts, and use it here
/**
 * Resolve the Docker daemon socket address for a given user.
 *
 * @param uid The user id to resolve the socket for, or null for the session user
 * @returns The unix socket path and, when applicable, the superuser mode to use
 */
function getAddress(uid: Uid): { path: string, superuser?: cockpit.ChannelOptions["superuser"] } {
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
 * Split an HTTP response message at the \r\n\r\n separator, separating headers from the body.
 *
 * @param text The raw HTTP response message
 * @returns A tuple of the header text and the body text, or null when no body follows
 */
function splitAtNLNL(text: string): [string, string | null] {
    const idx = text.indexOf("\r\n\r\n");
    if (idx < 0) {
        console.error("did not find NLNL in message", text); // not-covered: if this happens, it's a docker bug
        return [text, null]; // not-covered: ditto
    }
    return [text.slice(0, idx), text.slice(idx + 4)];
}

export type MonitorCallbackJson = (data: JsonObject) => void;
export type MonitorCallbackRaw = (data: string) => void;
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
 * No channel is actually created until the first request is made.
 *
 * @param uid The user id to connect as, or null for the session user
 * @returns A connection object bound to the resolved docker socket
 */
function connect(uid: Uid): Connection {
    const addr = getAddress(uid);
    /* This doesn't create a channel until a request */
    const http = cockpit.http(addr.path, { superuser: addr.superuser });
    const raw_channels: cockpit.Channel<string>[] = [];
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
                    .then(result => {
                        debug(user_str, `call ${id} result:`, result);
                        resolve(result);
                    })
                    // @ts-expect-error: magic cockpit defer error extra "content" parameter
                    .catch((error: object, content: unknown) => {
                        debug(user_str, `call ${id} error:`, JSON.stringify(error), "content", content);
                        reject(format_error(error, content));
                    });
        });
    }

    /**
     * Subscribe to a streaming endpoint of the Docker daemon.
     *
     * @param path       Request path, including any query parameters
     * @param callback   Invoked for each newline-delimited JSON line, or raw message when return_raw is set
     * @param return_raw When true the callback receives raw data instead of parsed JSON
     * @returns A promise resolving once the stream is closed
     */
    function monitor(path: string, callback: MonitorCallback, return_raw: boolean = false): Promise<void> {
        return new Promise((resolve, reject) => {
            const ch = cockpit.channel({ unix: addr.path, superuser: addr.superuser, payload: "stream" });
            raw_channels.push(ch);
            let buffer = "";

            ch.addEventListener("close", () => {
                debug(user_str, "monitor", path, "closed");
                resolve();
            });

            const onHTTPMessage = (event: unknown, message: string) => {
                const [headers, body] = splitAtNLNL(message);
                debug(user_str, "monitor", path, "HTTP response:", headers);
                if (headers.match(/^HTTP\/1.*\s+200\s/)) {
                    // any further message is actual streaming data
                    ch.removeEventListener("message", onHTTPMessage);
                    ch.addEventListener("message", onDataMessage);

                    // process the initial response data
                    if (body)
                        onDataMessage(event, body);
                } else {
                    // empty body Should not Happen™, would be a docker bug
                    const body_text = body || "(empty)";
                    reject(format_error({ reason: headers.split('\r\n')[0] }, body_text));
                }
            };

            const onDataMessage = (_event: unknown, message: string) => {
                if (isReturnRaw(return_raw, callback)) {
                    callback(message);
                } else {
                    buffer += message;

                    // split the buffer into lines on NL
                    for (;;) {
                        const idx = buffer.indexOf('\n');
                        if (idx < 0)
                            break;

                        const line = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 1);

                        debug(user_str, "monitor", path, "data:", line);
                        callback(JSON.parse(line));
                    }
                }
            };

            // the initial message is the HTTP status response
            ch.addEventListener("message", onHTTPMessage);

            ch.send(`GET ${path} HTTP/1.0\r\nContent-Length: 0\r\n\r\n`);
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
    connect,
    getAddress,
};
