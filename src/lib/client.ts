/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Docker Engine API client wrapping the daemon's HTTP endpoints.
 */

import type { JsonObject, JsonValue } from "cockpit";
import cockpit from "cockpit";

import { type Connection, type MonitorCallback } from "./rest.ts";

import type { DockerContainer, DockerImage, ImageHistoryLayer, ImageSearchResult } from "./types.ts";

/** Docker Engine API version prefix; the oldest version that we support */
export const VERSION = "/v1.41/";

/**
 * Issue a raw HTTP request against the Docker Engine API.
 *
 * @param con    An established Docker API connection
 * @param name   API endpoint path, relative to VERSION (e.g. "containers/json")
 * @param method HTTP method to use (GET, POST, DELETE, ...)
 * @param args   Query parameters to append to the request URL
 * @param body   Optional request body sent as-is
 * @returns A promise resolving to the raw response body as a string
 */
const dockerCall = (con: Connection, name: string, method: string, args: JsonObject, body?: string):
                   Promise<string> =>
    con.call({
        method,
        path: VERSION + name,
        body: body || "",
        params: args,
        headers: { "Content-Type": "application/json" },
    });

/**
 * Issue a raw HTTP request against the Docker Engine API and parse the response as JSON.
 *
 * @param con    An established Docker API connection
 * @param name   API endpoint path, relative to VERSION (e.g. "containers/json")
 * @param method HTTP method to use (GET, POST, DELETE, ...)
 * @param args   Query parameters to append to the request URL
 * @param body   Optional request body sent as-is
 * @returns A promise resolving to the parsed JSON response
 */
const dockerJson = (con: Connection, name: string, method: string, args: JsonObject, body?: string):
                   Promise<JsonObject | JsonValue> =>
    dockerCall(con, name, method, args, body)
            .then(reply => JSON.parse(reply));

/**
 * Subscribe to the stream of events emitted by the Docker daemon.
 *
 * @param con      An established Docker API connection
 * @param callback Invoked for every newline-delimited JSON event received
 */
export const streamEvents = (con: Connection, callback: MonitorCallback) =>
    con.monitor(`${VERSION}events`, callback);

/**
 * Fetch system-wide information from the Docker daemon.
 *
 * Rejects with a "timeout" error if the daemon does not answer within 10 seconds.
 *
 * @param con An established Docker API connection
 * @returns A promise resolving to the daemon info object
 */
export function getInfo(con: Connection): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 10000);
        dockerJson(con, "info", "GET", {})
                .then(reply => resolve(reply as JsonObject)) // Docker API, we know it's an object
                .catch(reject)
                .finally(() => clearTimeout(timeout));
    });
}

/**
 * List all containers, including stopped ones.
 *
 * @param con An established Docker API connection
 * @returns A promise resolving to a list of container summaries
 */
export const getContainers = (con: Connection): Promise<DockerContainer[]> =>
    dockerJson(con, "containers/json", "GET", { all: true })
            .then(reply => reply as unknown as DockerContainer[]);

/**
 * Stream usage statistics of a single container.
 *
 * Docker only exposes the stats endpoint per container; there is no bulk
 * endpoint that would cover all containers at once.
 *
 * @param con      An established Docker API connection
 * @param id       Id of the container to stream the stats of
 * @param callback Invoked for every newline-delimited JSON stats message received
 */
export const streamContainerStats = (con: Connection, id: string, callback: MonitorCallback) =>
    con.monitor(`${VERSION}containers/${id}/stats?stream=true`, callback);

/**
 * Inspect a container and return its detailed configuration.
 *
 * @param con An established Docker API connection
 * @param id  Id or name of the container
 * @returns A promise resolving to the container's full inspect object
 */
export function inspectContainer(con: Connection, id: string): Promise<DockerContainer> {
    const options = {
        size: false // set true to display filesystem usage
    };
    return dockerJson(con, `containers/${id}/json`, "GET", options)
            .then(reply => reply as unknown as DockerContainer);
}

/**
 * Remove a container.
 *
 * @param con   An established Docker API connection
 * @param id    Id or name of the container
 * @param force When true the container is killed before removal
 */
export const delContainer = (con: Connection, id: string, force: boolean) => dockerCall(con, `containers/${id}`, "DELETE", { force });

/**
 * Rename a container.
 *
 * @param con  An established Docker API connection
 * @param id   Id of the container
 * @param name New name for the container, must be unique
 */
export const renameContainer = (con: Connection, id: string, name: string) => dockerCall(con, `containers/${id}/rename`, "POST", { name });

/**
 * Create a new container from the given config.
 *
 * @param con    An established Docker API connection
 * @param config Container configuration used as the request body
 * @param name   Optional unique name for the container, passed as query parameter
 * @returns A promise resolving to the id of the created container
 */
export const createContainer = (con: Connection, config: JsonObject, name?: string) => dockerJson(con, "containers/create", "POST", name ? { name } : {}, JSON.stringify(config));

/**
 * Create a new image from a container's changes.
 *
 * @param con        An established Docker API connection
 * @param commitData Query parameters describing the commit, e.g. container, repo and tag
 */
export const commitContainer = (con: Connection, commitData: JsonObject) => dockerCall(con, "commit", "POST", commitData);

/**
 * Perform an action on a container, e.g. start, stop, restart, kill, pause or unpause.
 *
 * @param con    An established Docker API connection
 * @param action Name of the action to perform
 * @param id     Id or name of the container
 * @param args   Query parameters for the action, e.g. signal or t
 */
export const postContainer = (con: Connection, action: string, id: string, args: JsonObject) => dockerCall(con, `containers/${id}/${action}`, "POST", args);

/**
 * Create an interactive /bin/sh shell inside a container.
 *
 * @param con An established Docker API connection
 * @param id  Id or name of the container
 * @returns A promise resolving to the id of the created exec session
 */
export function execContainer(con: Connection, id: string) {
    const args = {
        AttachStderr: true,
        AttachStdout: true,
        AttachStdin: true,
        Tty: true,
        Cmd: ["/bin/sh"],
    };

    return dockerJson(con, `containers/${id}/exec`, "POST", {}, JSON.stringify(args));
}

/**
 * Resize the TTY of a running container or of an exec session.
 *
 * @param con    An established Docker API connection
 * @param id     Id of the container or exec session
 * @param exec   When true id refers to an exec session id instead of a container id
 * @param width  New width of the TTY in characters
 * @param height New height of the TTY in characters
 */
export function resizeContainersTTY(con: Connection, id: string, exec: boolean, width: number, height: number) {
    const args = {
        h: height,
        w: width,
    };

    let point = "containers/";
    if (exec)
        point = "exec/";

    return dockerCall(con, `${point}${id}/resize`, "POST", args);
}

/**
 * Extract the image metadata we are interested in from an image config object.
 *
 * @param info Image config object as returned by the image inspect endpoint
 * @returns A flat object holding entrypoint, command, ports and environment
 */
function parseImageInfo(info: JsonObject): JsonObject {
    const image: JsonObject = {};

    if (info.Config) {
        const config = info.Config as JsonObject;
        image.Entrypoint = config.Entrypoint;
        image.Command = config.Cmd;
        image.Ports = Object.keys((config.ExposedPorts as JsonObject) || {});
        image.Env = config.Env || [];
    }
    image.Author = info.Author;

    return image;
}

/**
 * List all images together with the metadata of each image config.
 *
 * When id is given only the image with that id is inspected.
 *
 * @param con An established Docker API connection
 * @param id  Optional id of a single image to filter by
 * @returns A promise resolving to a map of image id to its summary plus config metadata
 */
export function getImages(con: Connection, id?: string): Promise<Record<string, Omit<DockerImage, "key">>> {
    const options: JsonObject = {};
    if (id)
        options.filters = JSON.stringify({ id: [id] });
    return dockerJson(con, "images/json", "GET", options)
            .then(reply => {
                const images: JsonObject = {};
                const promises: Promise<JsonObject | JsonValue>[] = [];

                for (const image of reply as JsonObject[]) {
                    images[image.Id as string] = image;
                    promises.push(dockerJson(con, `images/${image.Id}/json`, "GET", {}));
                }

                // An image may be deleted between the list and the inspect
                // calls; skip the failed ones instead of losing the whole list.
                return Promise.allSettled(promises)
                        .then(results => {
                            for (const result of results) {
                                if (result.status !== "fulfilled")
                                    continue;
                                const info = result.value as JsonObject;
                                const imageId = info.Id as string;
                                const existingImage = images[imageId] as JsonObject || {};
                                images[imageId] = { uid: con.uid, ...existingImage, ...parseImageInfo(info) };
                            }
                            return images;
                        });
            })
            .then(images => images as unknown as Record<string, Omit<DockerImage, "key">>);
}

/**
 * Remove an image.
 *
 * @param con   An established Docker API connection
 * @param id    Id, name or tag of the image
 * @param force When true the image is removed even if it is used by a container
 * @returns A promise resolving to the report of untagged and deleted image layers
 */
export const delImage = (con: Connection, id: string, force: boolean) => dockerJson(con, `images/${id}`, "DELETE", { force });

/**
 * Tag an image with a repository and tag name.
 *
 * @param con  An established Docker API connection
 * @param id   Id or name of the image
 * @param repo Repository to tag the image with
 * @param tag  Tag to apply within the repository
 */
export const tagImage = (con: Connection, id: string, repo: string, tag: string) => dockerCall(con, `images/${id}/tag`, "POST", { repo, tag });

/**
 * Remove a tag from an image, deleting the image if no other references remain.
 *
 * @param con  An established Docker API connection
 * @param repo Repository of the tag to remove
 * @param tag  Tag to remove
 */
export const untagImage = (con: Connection, repo: string, tag: string) => dockerCall(con, `images/${repo}:${tag}`, "DELETE", {});

/**
 * Pull an image from a registry by its reference.
 *
 * The daemon streams one JSON status object per line and keeps the HTTP status
 * at 200 even when the pull fails, reporting the error as a terminal
 * {"error": ...} message. Scan every line for it (an error may be followed by
 * trailing progress lines), so that a pull failure is always reported as a
 * rejection instead of resolving silently.
 *
 * @param con       An established Docker API connection
 * @param reference Image reference in the form name[:tag]
 */
export function pullImage(con: Connection, reference: string) {
    return new Promise<void>((resolve, reject) => {
        dockerCall(con, "images/create", "POST", { fromImage: reference })
                .then(r => {
                    for (const line of r.split("\n")) {
                        const trimmed = line.trim();
                        if (trimmed.length === 0)
                            continue;
                        let response: { error?: string, cause?: string, errorDetail?: { message?: string } };
                        try {
                            response = JSON.parse(trimmed);
                        } catch {
                            // ignore malformed progress lines, they are not fatal
                            continue;
                        }
                        if (response.error) {
                            // reject with a real Error carrying the daemon's
                            // structured error detail for the notification
                            reject(Object.assign(new Error(response.error), { errorDetail: response.errorDetail }));
                            return;
                        } else if (response.cause) { // present for 400 and 500 errors
                            reject(response);
                            return;
                        }
                    }
                    resolve();
                })
                .catch(reject);
    });
}

/**
 * Search the registry for images matching the given search term.
 *
 * Searches the daemon's default registry (Docker Hub) on the user's behalf.
 *
 * @param con  An established Docker API connection
 * @param term Search term to look up in the registry
 */
export const searchImages = (con: Connection, term: string): Promise<ImageSearchResult[]> =>
    dockerJson(con, "images/search", "GET", { term })
            .then(reply => reply as unknown as ImageSearchResult[]);

/**
 * Fetch the current digest of an image reference from its registry.
 *
 * Uses the docker CLI's buildx plugin to resolve the image's current digest
 * without pulling it. Comparing this digest with the digests recorded in the
 * local image's RepoDigests reveals whether a mutable tag like "latest" has
 * moved, i.e. whether an update is available. Requires the docker CLI and the
 * buildx plugin on the host; the promise rejects when they are missing, the
 * tag does not exist in the registry or the registry cannot be reached.
 *
 * @param ref Image reference in the form name[:tag]
 * @returns A promise resolving to the current digest of the reference
 */
export const checkImageUpdate = (ref: string): Promise<string> =>
    cockpit.spawn(["docker", "buildx", "imagetools", "inspect", "--format", "{{.Manifest.Digest}}", ref], { err: "ignore" })
            .then(output => output.trim());

/**
 * Remove all unused images, not just dangling ones.
 *
 * The Docker API removes either dangling images (dangling=true) or unused
 * images that are still tagged (dangling=false) in a single call, so both
 * kinds are pruned to free all disk space of unused images.
 *
 * @param con An established Docker API connection
 * @returns A promise resolving to the report of freed disk space
 */
export const pruneUnusedImages = (con: Connection) =>
    Promise.all([
        dockerJson(con, "images/prune", "POST", { filters: JSON.stringify({ dangling: ["true"] }) }),
        dockerJson(con, "images/prune", "POST", { filters: JSON.stringify({ dangling: ["false"] }) }),
    ]);

/**
 * Return the commit history of an image.
 *
 * @param con An established Docker API connection
 * @param id  Id or name of the image
 */
export const imageHistory = (con: Connection, id: string): Promise<ImageHistoryLayer[]> =>
    dockerJson(con, `images/${id}/history`, "GET", {})
            .then(reply => reply as unknown as ImageHistoryLayer[]);

/**
 * Check whether an image exists, resolving on success and rejecting with a 404 error otherwise.
 *
 * @param con An established Docker API connection
 * @param id  Id or name of the image
 */
export const imageExists = (con: Connection, id: string) => dockerCall(con, `images/${id}/json`, "GET", {});

/**
 * Check whether a container exists, resolving on success and rejecting with a 404 error otherwise.
 *
 * @param con An established Docker API connection
 * @param id  Id or name of the container
 */
export const containerExists = (con: Connection, id: string) => dockerCall(con, `containers/${id}/json`, "GET", {});

/* === docker-compose stacks ============================================== */

/** Fallback directory for stack files when the session user's home is unknown */
export const STACKS_DIR = "/var/lib/cockpit-docker/stacks";

/**
 * Resolve the directory that holds the stack files of the session user.
 *
 * Stacks always live in the session user's own data directory, so the compose
 * files are owned by the user and directories that a stack bind-mounts into
 * its containers behave like a local `docker compose up` in the user's home.
 * app.tsx stores the session user's home in DOCKER_DESKTOP_HOME (which is also
 * the home Docker Desktop runs in); it falls back to STACKS_DIR during the
 * short startup window before the user info has been loaded.
 *
 * @returns The absolute path of the stacks directory
 */
export function getStacksDir(): string {
    const home = sessionStorage.getItem('DOCKER_DESKTOP_HOME');
    return home ? `${home}/.local/share/cockpit-docker/stacks` : STACKS_DIR;
}

/**
 * List the stacks of the session user, i.e. the directories under its stacks
 * directory regardless of whether they are running or stopped. An empty or
 * missing directory simply yields an empty list.
 *
 * @returns A promise resolving to the stack project names, sorted
 */
export function listStacks(): Promise<string[]> {
    return cockpit.spawn(["find", getStacksDir(), "-maxdepth", "1", "-mindepth", "1", "-type", "d", "-printf", "%f\\n"], {
        err: "message",
    })
            .then(output => output.split("\n").filter(name => name.length > 0))
            .then(names => names.sort())
            .catch(() => []);
}

/**
 * Error message that the docker CLI prints when it cannot reach the daemon
 * socket. Plain `docker` commands say "Docker daemon socket", while the
 * `docker compose` plugin says "docker API"; match both.
 */
const DOCKER_SOCKET_PERMISSION_DENIED = /permission denied while trying to connect to the docker (daemon socket|api)/i;

/**
 * Run a docker compose command from the given directory.
 *
 * Runs the command as the session user so that the stack files stay owned by
 * the user and bind-mounted directories behave like a local `docker compose up`
 * in the user's home. Users who are not in the docker group can still manage
 * stacks: when the user cannot reach the daemon socket, the command is retried
 * as root through cockpit's privilege escalation.
 *
 * @param args      The docker compose arguments to run
 * @param directory Directory containing the stack's compose file
 * @returns A promise resolving when the compose command has finished
 */
function spawnCompose(args: string[], directory: string): Promise<string> {
    return cockpit.spawn(["docker", "compose", ...args], { directory, err: "message" })
            .catch(ex => {
                if (DOCKER_SOCKET_PERMISSION_DENIED.test(String(ex.message)))
                    return cockpit.spawn(["docker", "compose", ...args], { directory, superuser: "try", err: "message" });
                throw ex;
            });
}

/**
 * Start or stop a docker-compose stack.
 *
 * Runs `docker compose up -d` / `docker compose stop` in the given directory,
 * so the stack is managed through its compose files. Requires the docker CLI
 * and compose plugin on the host.
 *
 * @param dir    Directory containing the stack's docker-compose.yml
 * @param action Either "up" to start or "stop" to stop the stack
 * @returns A promise resolving when the compose command has finished
 */
export function composeAction(dir: string, action: "up" | "stop"): Promise<string> {
    const args = action === "up" ? ["up", "-d"] : ["stop"];
    return spawnCompose(args, dir);
}

/**
 * Read the normalized configuration of a docker-compose stack.
 *
 * Runs `docker compose config`, which merges the stack's compose and .env
 * files into a single JSON document (see "docker compose config --format
 * json"). The normalization resolves the short and long port syntax into the
 * same shape and applies interpolation, so the returned object can be parsed
 * without a YAML library in the browser. The stack does not need to be
 * running; the promise rejects when the files cannot be read or parsed.
 *
 * @param dir Directory containing the stack's compose file
 * @returns A promise resolving to the normalized stack configuration
 */
export function composeConfig(dir: string): Promise<JsonObject> {
    return cockpit.spawn(["docker", "compose", "config", "--format", "json"], {
        directory: dir,
        err: "message",
    })
            .then(output => JSON.parse(output) as JsonObject);
}
