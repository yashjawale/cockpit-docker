# CI / automated checks

This project uses two CI systems: **GitHub Actions** (lints, releases, repo
maintenance) and **Packit / Testing Farm** (RPM builds and browser integration
tests on Fedora/CentOS Stream).

## GitHub Actions workflows (`.github/workflows/`)

| Workflow | Trigger | What it does |
|---|---|---|
| `codecheck.yml` | PR + push to main | Runs `make codecheck` (eslint, stylelint, mypy, ruff, vulture, TS typecheck, JSON/HTML/SPDX checks) in the `cockpit-project/tasks` container |
| `release.yml` | tag `[0-9]*` (e.g. `123`) or manual | Builds the source tarball + node cache, builds a `.deb` (Debian) and an `.rpm` (CentOS Stream), creates the GitHub release with all four artifacts. Manual runs default to **dry run** (artifacts only, no release) |
| `cockpit-lib-update.yml` | scheduled | Updates the checked-out Cockpit `pkg/lib`/`test/common` files |
| `tasks-container-update.yml` | scheduled | Bumps the pinned tasks container in `.cockpit-ci/container` |
| `test.yml.disabled` | (disabled) | Former libvirt-in-container attempt; superseded by Packit tests |

### Release workflow details

- `source` job: `make dist` + `make node-cache`, uploads both as workflow
  artifacts, then (unless dry run) creates the GitHub release.
- `debian` job: downloads the source tarball, runs `dpkg-buildpackage -b -us -uc`
  (no node toolchain needed — the tarball ships the pre-built `dist/`).
- `rpm` job: builds on `quay.io/centos/centos:stream10` (where the spec does not
  rebuild the bundle), using the tarball + node cache as `Source0`/`Source1`.
- **Dry run**: Actions → `release` → "Run workflow" → keep "Dry run" checked.
  No GitHub release is created; artifacts are uploaded to the run.

Known pitfalls (fixed):
- `safe.directory` must be the exact repo path (`/__w/cockpit-docker/cockpit-docker`),
  not `/__w/` (git matches exact paths).
- Extract only the *main* tarball (`cockpit-docker-[0-9]*.tar.xz`), never the
  node cache (`cockpit-docker-node-*.tar.xz`) with the same glob.
- Debian needs `build-essential` (the `dh` toolchain) in the `debian` job.

## Packit (`packit.yaml`)

Runs on Packit-as-a-service; see `docs/packit-setup.md` for setup and findings.

- `tests` (Testing Farm): PRs **and** pushes to main, on fedora-all,
  fedora-latest-stable-aarch64, centos-stream-9 (x86_64 + aarch64),
  centos-stream-10. Runs the tmt plan `plans/all.fmf` → `test/browser/`.
- `copr_build` (PR): builds RPMs for the same targets in a throwaway COPR
  project.
- `copr_build` (release): tag pushes build RPMs in `yashjawale/cockpit-docker`.

The tests run in the tasks container against the Testing Farm host itself
(`localhost:22` / `localhost:9090`), so no nested VMs are needed.

## Dependabot (`.github/dependabot.yml`)

Keeps npm + GitHub Actions deps updated. Some packages are pinned/ignored
because newer major versions break peer deps:

- `typescript` — `@typescript-eslint` only supports `<6.1` (TS 7 is the native
  compiler).
- `eslint-plugin-promise` (major) — `eslint-config-standard` requires `^6`.
- `eslint` (major), `sass` (>=1.80), `@patternfly/*` (major), `*react*` (major).

## Prerequisites for running locally

- `make` needs node + npm and `gettext` (see README).
- `make codecheck` needs the tools; the simplest way is the tasks container:
  `docker run --rm -v $PWD:/src -w /src ghcr.io/cockpit-project/tasks make codecheck`.
- `make check` boots a test VM (needs KVM on the host); prefer `TEST_BROWSER=firefox`
  (see README).
