# Daemon connections, ownership and state sync

This is a deeper dive into the part of cockpit-docker that is easiest to get
wrong: talking to **multiple Docker daemons** and keeping the UI state in sync
with them. Read `docs/architecture.md` first for the general layout.

## The "one daemon per owner" model

A single machine can run Docker in several independent ways at once:

1. The **system daemon** (`/var/run/docker.sock`), owned by root.
2. A **rootless daemon** for the logged-in session user
   (`$XDG_RUNTIME_DIR/docker.sock`).
3. **Rootless daemons for other logged-in users** (`/run/user/<uid>/docker.sock`).
4. A **Docker Desktop** daemon (a special case reached via a socket in the
   user's home directory).

Each of these is a completely separate daemon with its own containers, images
and events. The module therefore connects to all of them that are reachable and
merges their containers/images into one page, tagging every object with the
`uid` of the daemon that owns it.

### Resolution of the socket (`lib/rest.ts:getAddress`)

| uid | socket path | superuser mode |
|---|---|---|
| `UID_DOCKER_DESKTOP` (`-1`) | `$DOCKER_DESKTOP_HOME/.docker/desktop/docker.sock` | none |
| `null` (session user) | `$XDG_RUNTIME_DIR/docker.sock` | none |
| `0` (system) | `/var/run/docker.sock` | `"require"` |
| other integer uid | `/run/user/<uid>/docker.sock` | `"require"` |

For the session user and Docker Desktop, the paths come from `sessionStorage`
keys (`XDG_RUNTIME_DIR`, `DOCKER_DESKTOP_HOME`) because the module cannot make
an async `cockpit.user()` call at connection-setup time.

### Connection lifecycle (`lib/rest.ts:connect`)

`connect(uid)` returns a `Connection` with three operations:

- `call(options)` — one HTTP request; resolves with the body as a string,
  rejects with the daemon error merged via `format_error()`.
- `monitor(path, callback, return_raw?)` — opens a binary `stream` channel,
  sends a hand-written `GET <path> HTTP/1.0` request, parses the `\r\n\r\n`
  header/body separator, then feeds newline-delimited JSON messages (or raw
  bytes) to the callback.
- `close()` — closes the HTTP object and all open stream channels.

A binary channel is used on purpose so raw byte streams (container terminal,
logs) can be transported without corruption.

### How the UI discovers reachable daemons (`src/app.tsx`)

The initial state seeds three dummy users (`system`, `user`, `Docker desktop`)
with `con: null`. During initialization, `app.tsx`:

1. Walks the system users via the `cockpit.user()`-based users channel
   (sorted by `compareUser`), and
2. for each candidate, calls `client.getInfo()` with a 10-second timeout
   (`lib/client.ts:getInfo`). A success replaces the dummy entry with a live
   connection; a timeout/refusal means "no daemon for this user" and the entry
   is removed from the owner dropdown.

Once a connection is live, the app subscribes to its event stream and loads its
containers and images.

## Unique keys (`key` + `uid`)

Containers and images from different daemons can share ids (e.g. the same image
id pulled on system and rootless daemons). To avoid collisions in the shared
state maps, `lib/util.ts` computes a globally unique `key` per object that
incorporates the owning `uid`. All maps in `ApplicationState` (`containers`,
`images`) are keyed by that.

The `uid` field on each object also drives:

- which owner filter shows the object,
- whether actions run as root (stacks, some daemon calls),
- the `key` derivation.

## Event-driven refresh

`app.tsx` subscribes to each daemon's `/events` stream once
(`lib/client.ts:streamEvents`). The handler looks at `event.Action`/`event.Type`
and refreshes the affected object:

- a `container` event refreshes that container's inspect and updates image
  "used-by" info;
- an `image` event refreshes the image list;
- after actions like start/stop the UI also re-lists to pick up state changes.

Because the listeners are registered once but the state evolves, they always
read the latest state through `stateRef` rather than through a closure.

## Stats streaming

`streamContainerStats()` opens the `containers/stats?stream=true` endpoint,
which emits one snapshot per running container per second. Each snapshot is
compared with the previous one by `dockerStatsToView()` in `lib/util.ts` to
compute CPU percent (delta of `cpu_usage` over delta of `system_cpu_usage`,
scaled by `online_cpus`) and memory usage (excluding `inactive_file`).

## Stacks (docker-compose)

Stacks are the one feature that shells out to the docker CLI rather than the
API. For each owner:

- `getStacksDir(uid)` — `/var/lib/cockpit-docker/stacks` for the system daemon
  (and Docker Desktop), otherwise `$HOME/.local/share/cockpit-docker/stacks`.
- `getStacksSuperuser(uid)` — `"try"` for root-owned locations, `undefined`
  otherwise, so `cockpit.spawn` escalates only when needed.
- `listStacks(uid)` — `find` over the stacks directory (empty/missing → []).
- `composeAction(dir, action, uid)` — `docker compose up -d` / `docker compose stop`.

This is what `StackActions`, `CreateStackModal` and `InactiveStackActions` use;
they pass the per-owner directory around so the right daemon's stacks are
managed.

## URL state mirroring

Filters that users might want to share or keep across reloads are persisted in
the URL via `cockpit.location`:

- `?name=` — the text search box
- `?owner=` — the owner filter (`all`, `user`, or a uid)
- `?container=` — the containers "Show" filter (`all` | `running`)

`app.tsx` reads these on init and updates them via `updateUrl()` whenever the
corresponding filter changes.

## Failure / empty states

The app distinguishes:

- **Docker not installed** (`dockerInstalled === false`) — the `docker` CLI
  (and thus no daemon setup) is missing; shown as a distinct empty state.
- **No reachable daemon** — every candidate timed out or was refused.
- **Partial** — some daemons up, some down; the UI shows the ones that work.

`dockerInstalled` is probed by checking for the docker binary/CLI so the
"install docker" message is not confused with a broken service.
