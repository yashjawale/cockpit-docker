/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The Console tab of an expanded container row, attaching to the container's
 * TTY (or starting a shell) over an upgraded HTTP stream.
 */

import React, { useEffect, useRef, useState } from 'react';

import { Terminal } from "@xterm/xterm";

import cockpit from 'cockpit';
import { EmptyStatePanel } from "cockpit-components-empty-state.tsx";

import { ErrorNotification } from './Notification.tsx';
import * as client from '../lib/client.ts';
import rest from '../lib/rest.ts';

import "../styles/ContainerTerminal.scss";

const _ = cockpit.gettext;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The xterm internals we reach into for hiding the cursor */
interface XtermCore {
    _core: {
        cursorHidden: boolean;
        _renderService?: {
            dimensions?: {
                css?: { cell?: { width?: number } }
            }
        }
    };
}

/** A cockpit stream channel with the undocumented buffer() accessor */
interface BufferedChannel extends cockpit.Channel<Uint8Array> {
    buffer: () => {
        callback: ((data: Uint8Array) => number) | null;
    };
}

/**
 * Find the offset of the byte sequence in the byte array, or -1.
 *
 * @param seq  The array to search in
 * @param find The byte sequence to search for
 * @returns The index of the first match, or -1 when not found
 */
function sequence_find(seq: Uint8Array, find: number[]): number {
    let f;
    const fl = find.length;
    let s;
    const sl = (seq.length - fl) + 1;
    for (s = 0; s < sl; s++) {
        for (f = 0; f < fl; f++) {
            if (seq[s + f] !== find[f])
                break;
        }
        if (f === fl)
            return s;
    }

    return -1;
}

/** Props for the Console tab of a container row */
interface ContainerTerminalProps {
    /** Connection of the container's owner daemon */
    con: ReturnType<typeof rest.connect>;
    /** Id of the container to attach to */
    containerId: string;
    /** Current state of the container, to (re)connect when it is running */
    containerStatus: string | undefined;
    /** Width of the containing panel in pixels, for resizing the terminal */
    width: number;
    /** Owner of the container, to resolve the daemon socket */
    uid: number | null;
    /** Whether the container has a TTY; undefined until the container is known */
    tty?: boolean;
}

/**
 * Attach to a container's console, or start a /bin/sh shell for containers
 * without a TTY, and expose it through an xterm.js view.
 */
const ContainerTerminal = ({ con, containerId, containerStatus, width, uid, tty }: ContainerTerminalProps) => {
    const [opened, setOpened] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const terminalRef = useRef<HTMLDivElement>(null);
    // The xterm view is created once and reused for the lifetime of the tab;
    // the stream channel and its buffer are kept in refs so the attached
    // callbacks always operate on the current state.
    const termRef = useRef<Terminal | null>(null);
    if (!termRef.current) {
        termRef.current = new Terminal({
            cols: 80,
            rows: 24,
            cursorBlink: true,
            fontSize: 12,
            fontFamily: 'Menlo, Monaco, Consolas, monospace',
            screenReaderMode: true
        });
    }
    const term = termRef.current;
    const openedRef = useRef(false);
    const sessionIdRef = useRef(containerId);
    const channelRef = useRef<BufferedChannel | null>(null);
    const bufferRef = useRef<{ callback:((data: Uint8Array) => number) | null } | null>(null);
    // Whether the HTTP upgrade (101) has completed; the daemon only accepts a
    // resize for an exec session once it has actually started.
    const connectedRef = useRef(false);

    const resize = (newWidth: number) => {
        const dimensions = (term as unknown as XtermCore)._core._renderService?.dimensions;
        if (!dimensions?.css?.cell?.width)
            return;
        // 24 PF padding * 4
        // 3 line border
        // 21 inner padding of xterm.js
        // xterm.js scrollbar 20
        const padding = 24 * 4 + 3 + 21 + 20;
        const realWidth = dimensions.css.cell.width;
        const cols = Math.max(1, Math.floor((newWidth - padding) / realWidth));
        term.resize(cols, 24);
        if (!connectedRef.current)
            return;
        client.resizeContainersTTY(con, sessionIdRef.current, !tty, cols, 24)
                .catch(e => setErrorMessage(e.message));
    };

    const onChannelMessage = (buffer: Uint8Array) => {
        if (buffer)
            term.write(decoder.decode(buffer));
        return buffer.length;
    };

    const disconnectChannel = () => {
        if (bufferRef.current)
            bufferRef.current.callback = null;
        if (channelRef.current) {
            channelRef.current.removeEventListener('close', onChannelClose);
        }
    };

    const onChannelClose = () => {
        term.write('\x1b[31m disconnected \x1b[m\r\n');
        disconnectChannel();
        channelRef.current = null;
        connectedRef.current = false;
        (term as unknown as XtermCore)._core.cursorHidden = true;
    };

    const setUpBuffer = (channel: BufferedChannel) => {
        const buffer = channel.buffer();

        // Parse the full HTTP response
        buffer.callback = (data: Uint8Array) => {
            let ret = 0;
            let pos = 0;

            // Double line break separates header from body
            pos = sequence_find(data, [13, 10, 13, 10]);
            if (pos === -1)
                return ret;

            const headers = decoder.decode(
                data.subarray ? data.subarray(0, pos) : data.slice(0, pos));

            const parts = headers.split("\r\n", 1)[0].split(" ");
            // Check if we got `101` as we expect `HTTP/1.1 101 UPGRADED`
            if (parts[1] !== "101") {
                console.log(parts.slice(2).join(" "));
                buffer.callback = null;
                return ret;
            } else if (data.subarray) {
                data = data.subarray(pos + 4);
                ret += pos + 4;
            } else {
                data = data.slice(pos + 4);
                ret += pos + 4;
            }
            // Set up callback for new incoming messages and if the first response
            // contained any body, pass it into the callback
            buffer.callback = onChannelMessage;
            connectedRef.current = true;
            const consumed = onChannelMessage(data);
            // The exec session is ready now, so the daemon accepts a resize
            resize(width);
            return ret + consumed;
        };

        channel.addEventListener('close', onChannelClose);

        // Show the terminal. Once it was shown, do not show it again but reuse the previous one.
        // The default DOM renderer is used instead of the WebGL addon: every
        // terminal tab would otherwise need its own WebGL2 context, which the
        // browsers only allow in limited numbers and revoke the oldest one of,
        // leaving blank terminals.
        if (!openedRef.current) {
            term.open(terminalRef.current as HTMLDivElement);
            openedRef.current = true;
            setOpened(true);

            term.onData((data) => {
                if (channelRef.current)
                    channelRef.current.send(encoder.encode(data));
            });
        }

        return buffer;
    };

    const execAndConnect = () => {
        client.execContainer(con, containerId)
                .then(r => {
                    const result = r as { Id: string };
                    const address = rest.getAddress(uid);
                    const channel = cockpit.channel({
                        payload: "stream",
                        unix: address.path,
                        superuser: address.superuser,
                        binary: true
                    }) as BufferedChannel;

                    const body = JSON.stringify({ Detach: false, Tty: true });
                    channel.send(encoder.encode("POST " + client.VERSION + "exec/" + encodeURIComponent(result.Id) +
                              "/start HTTP/1.0\r\n" +
                              "Upgrade: WebSocket\r\nConnection: Upgrade\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\n\r\n" + body));

                    const buffer = setUpBuffer(channel);
                    channelRef.current = channel;
                    bufferRef.current = buffer;
                    sessionIdRef.current = result.Id;
                    setErrorMessage("");
                })
                .catch(e => setErrorMessage(e.message));
    };

    const connectToTty = () => {
        const address = rest.getAddress(uid);
        const channel = cockpit.channel({
            payload: "stream",
            unix: address.path,
            superuser: address.superuser,
            binary: true
        }) as BufferedChannel;

        channel.send(encoder.encode("POST " + client.VERSION + "containers/" + encodeURIComponent(containerId) +
                      "/attach?stream=true&stdin=true&stdout=true&stderr=true HTTP/1.0\r\n" +
                      "Upgrade: WebSocket\r\nConnection: Upgrade\r\nContent-Length: 0\r\n\r\n"));

        const buffer = setUpBuffer(channel);
        channelRef.current = channel;
        bufferRef.current = buffer;
        setErrorMessage("");
        // Send SIGWINCH to show prompt on attaching
        channel.send(encoder.encode(String.fromCharCode(12)));
    };

    const connectChannel = () => {
        if (channelRef.current)
            return;

        if (containerStatus !== "running")
            return;

        if (tty === undefined)
            return;

        if (tty)
            connectToTty();
        else
            execAndConnect();
    };

    useEffect(() => {
        connectChannel();
        return () => {
            disconnectChannel();
            channelRef.current?.close();
            term.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Connect the channel once the container runs and the TTY is resolved,
    // and resize the terminal with the panel
    useEffect(() => {
        if (containerStatus === "running" && tty !== undefined && channelRef.current === null)
            connectChannel();
        resize(width);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [containerStatus, tty, width]);

    let element = <div className="container-terminal" ref={terminalRef} />;

    if (containerStatus !== "running" && !opened)
        element = <EmptyStatePanel title={_("Container is not running")} />;

    return (
        <>
            {errorMessage && <ErrorNotification errorMessage={_("Error occurred while connecting console")} errorDetail={errorMessage} onDismiss={() => setErrorMessage("")} />}
            {element}
        </>
    );
};

export default ContainerTerminal;
