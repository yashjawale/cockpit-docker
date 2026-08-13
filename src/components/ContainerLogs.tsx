/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The Logs tab of an expanded container row, streaming the container output
 * into an xterm.js view.
 */

import React, { useEffect, useRef, useState } from 'react';

import { ExclamationCircleIcon } from '@patternfly/react-icons';
import { Terminal } from "@xterm/xterm";

import cockpit from 'cockpit';
import { EmptyStatePanel } from "cockpit-components-empty-state.tsx";

import * as client from '../lib/client.ts';
import rest from '../lib/rest.ts';

import "../styles/ContainerTerminal.scss";

const _ = cockpit.gettext;

// Default xterm.js scrollback size https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/#optional-scrollback
const LOGS_MAX_SIZE = 1000;

/** The xterm internals we reach into for sizing, which lack a public API */
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

/** Props for the Logs tab of a container row */
interface ContainerLogsProps {
    /** Id of the container to stream the logs of */
    containerId: string;
    /** Current state of the container, to reconnect after a restart */
    containerStatus: string | undefined;
    /** Width of the containing panel in pixels, for resizing the terminal */
    width: number;
    /** Owner of the container, to resolve the daemon socket */
    uid: number | null;
}

/**
 * Stream the logs of a container into an xterm.js view.
 *
 * The container logs are streamed in docker's multiplexed frame format; the
 * first eight bytes of each frame describe the stream and the frame size.
 */
const ContainerLogs = ({ containerId, containerStatus, width, uid }: ContainerLogsProps) => {
    const [errorMessage, setErrorMessage] = useState("");
    const logRef = useRef<HTMLDivElement>(null);
    // The xterm view is created once and reused for the lifetime of the tab;
    // the other fields are only ever read from the stream callbacks.
    const viewRef = useRef<Terminal | null>(null);
    if (!viewRef.current) {
        viewRef.current = new Terminal({
            cols: 80,
            rows: 24,
            convertEol: true,
            cursorBlink: false,
            disableStdin: true,
            fontSize: 12,
            fontFamily: 'Menlo, Monaco, Consolas, monospace',
            screenReaderMode: true,
            scrollback: LOGS_MAX_SIZE,
        });
        (viewRef.current as unknown as XtermCore)._core.cursorHidden = true;
        viewRef.current.write(_("Loading logs..."));
    }
    const view = viewRef.current;
    const loadingRef = useRef(true);
    const openedRef = useRef(false);
    const streamerRef = useRef<ReturnType<typeof rest.connect> | null>(null);
    const mountedRef = useRef(false);
    // Bytes of a frame that did not arrive in one message; a single docker
    // frame can straddle two channel messages, and the tail must be prepended
    // to the next one instead of being misparsed as a new frame header.
    const pendingRef = useRef<Uint8Array>(new Uint8Array());

    const resize = (newWidth: number) => {
        const dimensions = (view as unknown as XtermCore)._core._renderService?.dimensions;
        if (!dimensions?.css?.cell?.width)
            return;
        // 24 PF padding * 4
        // 3 line border
        // 21 inner padding of xterm.js
        // xterm.js scrollbar 20
        const padding = 24 * 4 + 3 + 21 + 20;
        const realWidth = dimensions.css.cell.width;
        const cols = Math.max(1, Math.floor((newWidth - padding) / realWidth));
        view.resize(cols, 24);
    };

    const onStreamMessage = (data: Uint8Array) => {
        if (data) {
            if (loadingRef.current) {
                view.reset();
                (view as unknown as XtermCore)._core.cursorHidden = true;
                loadingRef.current = false;
            }
            // First 8 bytes encode information about stream and frame
            // See 'Stream format' on https://docs.docker.com/engine/api/v1.41/#operation/ContainerAttach
            if (pendingRef.current.byteLength > 0) {
                const combined = new Uint8Array(pendingRef.current.byteLength + data.byteLength);
                combined.set(pendingRef.current, 0);
                combined.set(data, pendingRef.current.byteLength);
                data = combined;
                pendingRef.current = new Uint8Array();
            }
            while (data.byteLength >= 8) {
                // split into frames (size is the second 32-bit word)
                const size = data[7] + data[6] * 0x100 + data[5] * 0x10000 + data[4] * 0x1000000;
                // a frame that is not complete yet is kept for the next message
                if (data.byteLength < 8 + size) {
                    pendingRef.current = data;
                    break;
                }
                const frame = data.slice(8, 8 + size);
                // old docker versions just have CR endings, append NL then
                if (frame[size - 1] === 13)
                    view.writeln(frame);
                else
                    // recent docker versions have CRNL endings
                    view.write(frame);
                data = data.slice(8 + size);
            }
            // a trailing partial frame header is also kept for the next message
            if (data.byteLength > 0 && data.byteLength < 8)
                pendingRef.current = data;
        }
    };

    const onStreamClose = () => {
        if (mountedRef.current) {
            streamerRef.current = null;
            view.write(_("Streaming disconnected"));
        }
    };

    const connectStream = () => {
        if (streamerRef.current !== null)
            return;

        // Show the terminal. Once it was shown, do not show it again but reuse the previous one.
        // The default DOM renderer is used instead of the WebGL addon: every
        // terminal tab would otherwise need its own WebGL2 context, which the
        // browsers only allow in limited numbers and revoke the oldest one of,
        // leaving blank terminals.
        if (!openedRef.current) {
            view.open(logRef.current as HTMLDivElement);
            openedRef.current = true;
        }
        resize(width);

        const connection = rest.connect(uid);
        connection.monitor(client.VERSION + "containers/" + containerId +
                           `/logs?follow=true&stdout=true&stderr=true&tail=${LOGS_MAX_SIZE}`,
                           onStreamMessage, true)
                .then(onStreamClose)
                .catch(e => {
                    setErrorMessage(e.message ?? e.toString());
                    streamerRef.current = null;
                });
        streamerRef.current = connection;
        setErrorMessage("");
    };

    useEffect(() => {
        mountedRef.current = true;
        connectStream();
        return () => {
            mountedRef.current = false;
            streamerRef.current?.close();
            view.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reconnect when the container starts and resize the terminal with the panel
    useEffect(() => {
        if (containerStatus === "running" && streamerRef.current === null)
            connectStream();
        resize(width);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [width, containerStatus]);

    let element = <div className="container-logs" ref={logRef} />;

    if (errorMessage) {
        element = <EmptyStatePanel icon={ExclamationCircleIcon} title={errorMessage} />;
    }

    return element;
};

export default ContainerLogs;
