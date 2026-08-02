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
    /** Registry host of the primary tag, set together with Name for the run dialog */
    Index?: string;
    /** Short description shown for registry search results */
    Description?: string;
    toString?: () => string;
}

/** A single binding of a container port to a host port */
export interface DockerPortBinding {
    HostIp?: string;
    HostPort?: string;
}

/** A single mount of a container, e.g. a bind mount or a named volume */
export interface DockerMount {
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
    Driver?: string;
    Mode?: string;
    RW?: boolean;
}

/** A single recorded run of a container health check */
export interface DockerHealthLog {
    Start?: string;
    End?: string;
    ExitCode?: number;
    Output?: string;
}

/** Health check state of a running container */
export interface DockerHealth {
    Status?: string;
    FailingStreak?: number;
    Log?: DockerHealthLog[];
}

/** Runtime state of a container as reported by the inspect endpoint */
export interface DockerContainerState {
    Status?: string;
    Running?: boolean;
    Paused?: boolean;
    Restarting?: boolean;
    OOMKilled?: boolean;
    Dead?: boolean;
    Pid?: number;
    ExitCode?: number;
    Error?: string;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: DockerHealth;
}

/** Container configuration, i.e. the parts of the inspect object we display */
export interface DockerContainerConfig {
    Image?: string;
    Env?: string[];
    Cmd?: string[];
    Tty?: boolean;
    Labels?: Record<string, string>;
    Healthcheck?: {
        Test?: string[];
        Interval?: number;
        Timeout?: number;
        Retries?: number;
        StartPeriod?: number;
    };
}

/** Network settings of a container, including the published ports */
export interface DockerNetworkSettings {
    IPAddress?: string;
    Gateway?: string;
    MacAddress?: string;
    Ports?: Record<string, DockerPortBinding[] | null>;
}

/** Resource limits of a container */
export interface DockerHostConfig {
    Memory?: number;
}

/** A Docker container as returned by the inspect endpoint */
export interface DockerContainer {
    Id: string;
    Name: string;
    /** Image reference the container was created from */
    Image: string;
    Created?: string;
    State?: DockerContainerState;
    Config?: DockerContainerConfig;
    HostConfig?: DockerHostConfig;
    NetworkSettings?: DockerNetworkSettings;
    Mounts?: DockerMount[];
    uid: Uid;
    key: string;
}

/**
 * A single usage snapshot streamed from the containers/stats endpoint.
 *
 * Docker sends one snapshot per container per second; CPU usage and memory
 * usage are computed from the differences between the current and previous
 * sample by dockerStatsToView() in util.ts.
 */
export interface ContainerStats {
    read?: string;
    id?: string;
    name?: string;
    cpu_stats?: {
        cpu_usage?: { total_usage?: number };
        system_cpu_usage?: number;
        online_cpus?: number;
    };
    precpu_stats?: {
        cpu_usage?: { total_usage?: number };
        system_cpu_usage?: number;
    };
    memory_stats?: {
        usage?: number;
        limit?: number;
        stats?: { inactive_file?: number };
    };
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

/**
 * A stopped container that is a candidate for pruning, carrying just the data
 * the prune dialog needs.
 */
export interface UnusedContainer {
    id: string;
    name: string;
    key: string;
    created?: string;
    uid: Uid;
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
