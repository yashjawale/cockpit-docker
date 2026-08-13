# AGENTS.md

Guidance for AI coding agents and contributors working in this repository.

## Project overview

`cockpit-docker` is a [Cockpit](https://cockpit-project.org/) plugin for
managing Docker containers and images. It builds a web UI into `dist/` with
esbuild, and is packaged as RPM, Debian, and Arch artifacts.

## Documentation

See the `docs/` directory for in-depth notes:

- `docs/architecture.md` — overall module architecture: data flow, layering
  (`rest.ts` → `client.ts` → React components), daemon connections, state
  management in `app.tsx`.
- `docs/architecture-connections.md` — deeper dive into the multi-daemon
  ("one daemon per owner") model, unique keys, event-driven refresh, stats
  streaming, and docker-compose stacks.
- `docs/ci.md` — GitHub Actions workflows, Packit/Testing Farm, Dependabot, and
  the release (tarball + .deb + .rpm) pipeline.
- `docs/packit-setup.md` — Packit/COPR/Testing Farm setup and regression notes.

## Common commands

- `make` — build the bundle into `dist/`.
- `make devel-install` / `make devel-uninstall` — symlink/remove the local
  development install into `~/.local/share/cockpit/`.
- `make watch` — rebuild on every change; `RSYNC=<host> make watch` uploads to a
  remote host.
- `make dist` — build the release tarball (also generates the spec, Arch
  PKGBUILD, and `debian/` packaging).
- `make srpm` / `make rpm` / `make deb` — build distribution packages.
- `make codecheck` — static checks (eslint, stylelint, mypy, ruff, vulture,
  TypeScript typecheck, ...). Run it in the tasks container if tools are missing
  locally: `docker run --rm -v $PWD:/src -w /src ghcr.io/cockpit-project/tasks make codecheck`.
- `make check` — browser integration tests against a test VM. **Always use
  `TEST_BROWSER=firefox`** (chromium is prone to OOM):
  `TEST_BROWSER=firefox make check`. Pick a VM image with `TEST_OS=...`
  (e.g. `fedora-44`, `debian-trixie`).

## CI

- Browser tests run via Packit/Testing Farm (not GitHub Actions); `codecheck`
  and releases run in GitHub Actions. See `docs/ci.md`.
- The `release.yml` workflow has a manual "Dry run" mode that builds all
  artifacts without publishing a GitHub release.

## Dependabot

npm + GitHub Actions deps are auto-updated. `typescript`, `eslint-plugin-promise`
(major), `eslint` (major), `sass`, `@patternfly/*` (major), and `*react*` (major)
are pinned/ignored due to peer-dependency conflicts — do not remove those
ignores without verifying the new versions resolve (`make codecheck` will catch
breakage).
