# Architecture overview

This document describes how the cockpit-docker module is structured and how it
talks to the Docker daemon. It is aimed at contributors who want to understand
or modify the codebase.

## What it is

A [Cockpit](https://cockpit-project.org/) module that lets users manage Docker
containers and images from a web UI. It talks directly to the Docker daemon's
HTTP API over its unix socket (no `docker` CLI required for containers/images;
stacks do use `docker compose`, see below).

The module is a client-side web application: a TypeScript/React SPA built by
esbuild into `dist/` and served by Cockpit from `/docker`.

## High-level data flow

```
Browser (React UI)
    │  reads/writes state
    ▼
app.tsx  (Application component: single source of truth)
    │  uses
    ▼
lib/client.ts   (Docker Engine API client: typed endpoints)
    │  uses
    ▼
lib/rest.ts     (low-level unix-socket HTTP connection)
    │  uses
    ▼
cockpit.http / cockpit.channel   (Cockpit bridge → /var/run/docker.sock)
    │
    ▼
Docker daemon (system, per-user, or Docker Desktop)
```

State lives in one `useState` object in `app.tsx` and is pushed down to
presentational components. Components never call the daemon directly; they
invoke `client.*` functions and receive the resulting data via props or shared
context.

## Entry points and top-level structure

- `src/index.tsx` — mounts `<Application />` into `#app` once the DOM is ready;
  imports the PatternFly theme and module styles.
- `src/app.tsx` — the `Application` component: connects to daemons, subscribes
  to their event streams, keeps the shared state in sync, renders the page.
- `src/manifest.json` — Cockpit metadata: page label, menu keywords, required
  cockpit version, CSP.
- `src/components/` — presentational React components (one per view/dialog).
- `src/lib/` — the non-UI core:
  - `rest.ts` — low-level HTTP connection handling
  - `client.ts` — Docker Engine API client
  - `types.ts` — shared TypeScript types
  - `context.tsx` — React context for shared daemon info
  - `util.ts` — helpers (formatting, stats math, notification keys)

## Daemon connections and ownership

The module can talk to **three kinds** of Docker daemon at once, keyed by a
`User` object:

| Owner | uid | Socket | Notes |
|---|---|---|---|
| system daemon | `0` | `/var/run/docker.sock` | needs root, so `superuser: "require"` |
| session user | `null` | `$XDG_RUNTIME_DIR/docker.sock` | rootless Docker |
| arbitrary uid | `uid` | `/run/user/<uid>/docker.sock` | other logged-in users |
| Docker Desktop | `-1` (`UID_DOCKER_DESKTOP`) | `$DOCKER_DESKTOP_HOME/.docker/desktop/docker.sock` | sentinel, not a real user |

Socket resolution lives in `lib/rest.ts:getAddress()`. `lib/rest.ts:connect()`
returns a `Connection` object bound to one socket. `app.tsx` starts with dummy
`{ con: null }` entries for system/user/Docker Desktop and replaces each one
with a real connection once that daemon answers.

Stacks (docker-compose) are the one feature that does use the docker CLI:
`lib/client.ts:getStacksDir()` resolves where they live — always the session
user's `~/.local/share/cockpit-docker/stacks`, so the files are owned by the
user and bind-mounted directories behave like a local `docker compose up`.
`composeAction()` runs `docker compose up -d` / `docker compose stop` as the
session user, retrying as root only when the user cannot reach the daemon
socket.

## Layering

### `lib/rest.ts` — the socket transport

- Wraps `cockpit.http(path, { superuser, binary: true })` for single requests
  (`call()`).
- Wraps `cockpit.channel(...)` with a `stream` payload for **streaming**
  endpoints (`monitor()`): it hand-rolls the HTTP request
  (`GET <path> HTTP/1.0`), buffers until the `\r\n\r\n` header/body separator
  (`findNLNL()`), then splits the body into newline-delimited JSON messages —
  or passes raw bytes through when `return_raw` is set (needed for terminal and
  log streams).
- Errors are merged with the daemon's response body via `format_error()`.

### `lib/client.ts` — the Docker Engine API

All endpoints are version-prefixed with `VERSION = "/v1.41/"`. Two helpers wrap
every call:

- `dockerCall()` — raw request, returns the response body string.
- `dockerJson()` — request plus JSON parse.

Typed functions cover containers (`getContainers`, `inspectContainer`,
`delContainer`, `renameContainer`, `createContainer`, `postContainer` for
start/stop/restart/…, `execContainer`, `commitContainer`), images
(`getImages`, `delImage`, `tagImage`, `untagImage`, `pullImage`,
`searchImages`, `imageHistory`, `pruneUnusedImages`), and streaming
(`streamEvents`, `streamContainerStats`). Stacks functions are at the bottom of
the file.

`getImages()` inspects every image (one request per image) to augment the list
with config metadata (entrypoint, command, ports, env); failed inspects are
skipped via `Promise.allSettled` so a deleted image doesn't drop the whole list.

### `lib/types.ts` — the data model

Mirrors the shapes returned by the Docker API that the UI cares about:
`DockerContainer`, `DockerImage`, `DockerContainerState` (incl. `Health`),
`DockerMount`, `ContainerStats`, `DockerEvent`, `ImageSearchResult`, etc.

Two fields are added by the application for cross-owner state management:

- `uid` — which daemon/owner owns the object.
- `key` — a globally unique key (owner + id) so containers/images of different
  users never collide in the shared maps.

### `src/app.tsx` — state management

The whole application state is a single `useState<ApplicationState>` object
(see its interface in the file). Key points:

- A `stateRef` ref always holds the latest state, so one-shot event listeners
  registered during initialization never read a stale closure.
- **Event-driven updates**: `streamEvents()` subscribes to each daemon's
  `/events` endpoint; events like `container create/start/die` trigger a
  refresh of the affected container (and images' "used-by" info).
- **Containers** are listed (`getContainers`) and then inspected one by one
  (`inspectContainer`) for details; `initContainers()` replaces only the given
  user's containers.
- **Images** come from `client.getImages()` (list + per-image inspect).
- **Stats** come from `streamContainerStats()`; `dockerStatsToView()` in
  `lib/util.ts` turns successive snapshots into CPU% and memory usage.
- **URL state**: text filter, owner filter, and containers "Show" filter are
  mirrored into the URL via `cockpit.location` (`?name=`, `?owner=`,
  `?container=`), so they survive reloads and are shareable.
- **Notifications**: a toast system with a monotonically increasing index
  (`notificationIndex`) so dismissing one toast can never collide with another.

### `src/lib/context.tsx` — shared daemon info

`DockerInfoContext` provides `{ selinuxAvailable, version }` to the whole tree
via `WithDockerInfo` / `useDockerInfo()`.

## Component inventory (`src/components/`)

- **Containers / Images** — the two main list cards.
- **ContainerDetails / ImageDetails** — detail views (tabs: logs, terminal,
  health, history, integration, used-by).
- **Modals** — ContainerDeleteModal, ForceRemoveModal, ContainerRenameModal,
  ContainerCommitModal, ImageDeleteModal, ImageRunModal, ImageSearchModal,
  CreateStackModal, PruneUnusedContainersModal, PruneUnusedImagesModal,
  PortMapModal.
- **Misc** — Notification (toasts), RelativeTime, Volume, Env, PublishPort,
  ContainerHeader, StackActions, ContainerTerminal, ContainerLogs,
  ContainerHealthLogs, ContainerIntegration.

## Build system

- `build.js` — esbuild bundler producing `dist/` (entry `src/index.tsx`); in
  production it minifies and compresses. The `Makefile` `dist` target builds a
  release tarball from `git ls-files` plus the checked-out Cockpit
  `pkg/lib`/`test/common`/`tools/node-modules`.
- `tsconfig.json` — TypeScript settings (strict, `es2022` lib, noEmit; used by
  the `test/common/typecheck` check).
- `src/app.scss` / `src/styles/` — the module's own styling; base is PatternFly
  via `patternfly/patternfly-6-cockpit.scss`.

## Testing

- Browser integration tests in `test/check-application` run against a test VM
  via `make check` (`TEST_BROWSER=firefox` recommended), and in CI via
  Packit/Testing Farm (see `docs/ci.md`).
- Static checks via `make codecheck` (eslint, stylelint, mypy, ruff, vulture,
  TypeScript typecheck) — see `docs/ci.md`.
