/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Shared TypeScript types for the objects exchanged with the Docker daemon.
 */

import type { ReactNode } from "react";

import type { Connection } from "./rest.ts";

/** A standard Unix UID, or null for the logged in session user */
export type Uid = number | null;

/**
 * A user that can own containers and images.
 *
 * Each user talks to its own Docker daemon socket; con is null until the
 * connection has been established successfully.
 */
export interface User {
    name: string;
    uid: Uid;
    con: Connection | null;
    containersLoaded?: boolean;
    imagesLoaded?: boolean;
}

/**
 * A Docker image summary as produced by client.getImages().
 *
 * The `uid` and `key` fields are added by the application to track ownership
 * and to keep the ids globally unique across users.
 */
export interface DockerImage {
    Id: string;
    RepoTags: string[] | null;
    RepoDigests?: string[] | null;
    ParentId?: string;
    Labels?: Record<string, string>;
    Size: number;
    Created?: number;
    Containers?: number;
    VirtualSize?: number;
    SharedSize?: number;
    Author?: string;
    Env?: string[];
    Entrypoint?: string[];
    Command?: string[];
    Ports?: string[];
    uid: Uid;
    key: string;
    /** Primary repository tag, set together with toString() for the run dialog */
    Name?: string;
    /** Short description shown for registry search results */
    Description?: string;
    toString?: () => string;
}

/** A Docker container summary as returned by the containers endpoints */
export interface DockerContainer {
    Id: string;
    Name: string;
    Image: string;
    State?: { Status?: string };
    uid: Uid;
    key: string;
}

/** A single layer of an image history as returned by the history endpoint */
export interface ImageHistoryLayer {
    Id: string;
    Created: number;
    CreatedBy: string;
    Size: number;
    Comment?: string;
}

/**
 * A container that uses a particular image, keyed by its state key.
 */
export interface ImageUse {
    container: DockerContainer;
}

/** A single result of the daemon's registry image search */
export interface ImageSearchResult {
    name: string;
    description?: string;
    is_automated?: boolean;
    is_official?: boolean;
    star_count?: number;
}

/** A Docker daemon event stream message */
export interface DockerEvent {
    Type: string;
    Action: string;
    Actor: {
        ID: string;
        Attributes?: Record<string, string>;
    };
    time?: number;
    timeNano?: number;
}

/** A toast notification shown by the application */
export interface Notification {
    type: 'danger' | 'success' | 'info' | 'warning' | 'default';
    error: string;
    errorDetail?: ReactNode;
    index?: number;
}

/** Error object used by the Docker API client to reject requests */
export interface DockerError {
    message?: string;
    reason?: string;
    problem?: string;
}

/** A single row of a dynamic list form (ports, volumes, environment variables) */
export interface DynamicListItem {
    key?: number;
    [field: string]: string | number | null | undefined;
}

/**
 * Props passed by DynamicListForm to each of its row components.
 *
 * The fields that a component does not use can be omitted from the
 * destructuring; itemCount is only provided by some DynamicListForm versions.
 */
export interface DynamicListRowProps {
    id: string;
    item: DynamicListItem;
    onChange: (idx: number, field: string, value: string | null) => void;
    idx: number;
    removeitem: (idx: number) => void;
    additem: () => void;
    itemCount?: number;
    options?: Record<string, unknown> | undefined;
    validationFailed?: Record<string, string> | undefined;
    onValidationChange?: ((value: Record<string, string>) => void) | undefined;
}
