# Packit / Testing Farm setup & findings

Status: **in progress — enabled services pending (user-side), and blocked by a
release-workflow bug (see below).**

This file captures everything we learned about moving the cockpit-docker CI to
Packit + Testing Farm, and the current state of the failing build (release)
workflow, so we can pick this up later.

## Why Packit instead of GitHub Actions

The repo already ships a complete Packit test harness:

- `packit.yaml` — jobs for `tests` (PR), `copr_build` (PR), and release `copr_build`
- `plans/all.fmf` — the tmt plan
- `test/browser/{main.fmf,browser.sh,run-test.sh}` — the actual browser test runner
- `.cockpit-ci/container` — pinned tasks container (`ghcr.io/cockpit-project/tasks:2026-07-04`)

The killer difference vs. `make check` on GitHub Actions:

- `make check` boots nested VMs via libvirt/KVM inside a container. In GitHub
  Actions this required a long chain of container hacks (start `virtqemud`,
  `virtlogd`, mount `/dev/kvm`, `--privileged`, disable libvirt security driver
  and cgroups, run QEMU as root, …) and it never fully worked (last failure:
  guest completes systemd poweroff but `wait_poweroff` times out).
- `test/browser/run-test.sh` runs the tests **against the Testing Farm host
  itself** (`--machine ${GATEWAY}:22`, `--browser ${GATEWAY}:9090`). The tasks
  container only supplies firefox/test tooling, running as an unprivileged user
  via `podman run`. No libvirt, no nested KVM, no container hacks.

## What already works (verified locally)

- `packit validate packit.yaml` → ✅ valid. One harmless warning:
  `Package 'cockpit-docker' does not exist` — only matters for
  `propose_downstream`/`koji`/`bodhi` jobs, which are disabled.
- `packit srpm` → ✅ builds the source tarball and an SRPM
  (`cockpit-docker-1-1.<timestamp>.main.fc44.src.rpm`). The `git describe`
  "failed" log lines are noise from there being no tags yet; it correctly falls
  back to `make print-version` → `1`. All build artifacts are gitignored.
- `plans/all.fmf` and `test/browser/*` mirror cockpit-podman's working setup.

## One-time enablement steps (user-side, in order)

1. **Fedora account** (identity for COPR + Packit):
   https://accounts.fedoraproject.org/

2. **Enable the Packit GitHub app** on `yashjawale/cockpit-docker`:
   https://github.com/apps/packit-as-a-service (the "as a service" app; scope
   it to this repo).

3. **Log into the Packit dashboard** with the Fedora account:
   https://dashboard.packit.dev/
   (This is how Packit authenticates as you — it replaces the removed
   `packit login` CLI subcommand.)

4. **Register the Testing Farm SSH key** in the dashboard so Packit can
   provision/ssh into the test VMs. Without this the `tests` job cannot run.

5. **Create the COPR project** for release builds:
   https://copr.fedorainfra.org/ → New project
   - Name: `cockpit-docker`, Owner: `yashjawale`
   - Chroots: at least the release targets (`fedora-all`, `centos-stream-9-x86_64`)
     plus whatever you want for PR copr builds (fedora 43/44, centos-stream 9/10).

6. **Local smoke test** (no tag needed):
   ```bash
   export GITHUB_TOKEN=...   # a PAT
   packit validate .packit.yaml
   packit srpm
   ```

## What happens automatically afterwards

- **Every PR**: `tests` (Testing Farm VMs) + `copr_build` jobs run.
- **Tag push** (e.g. `123`): the release `copr_build` job builds RPMs in the
  `yashjawale/cockpit-docker` COPR project.

## Caveats / decisions

- Packit / Testing Farm covers **Fedora + CentOS Stream only**. The
  `debian-trixie` coverage from `.github/workflows/test.yml` does NOT carry over
  to Packit. Decide later whether Debian coverage is needed.
- GPG signing of release assets is still deferred.
- The pinned `.cockpit-ci/container` is kept fresh by the existing
  `tasks-container-update.yml` workflow.
- The GitHub Actions `test.yml` (the libvirt-in-container attempt) is redundant
  with the Packit path and is a candidate for removal — not yet decided.
- `tmt` is not installed locally, so the plan could not be linted here; Testing
  Farm runs it.

## Known failing: release workflow (blocking)

`.github/workflows/release.yml` (`source` job) fails on every run — including
the manual dry-runs — with:

```
fatal: detected dubious ownership in repository at '/__w/cockpit-docker/cockpit-docker'
make: *** [Makefile:45: pkg/lib/cockpit-po-plugin.js] Error 128
```

### Details

- Fails in `make dist` → the Makefile target that checks out cockpit's
  `pkg/lib`/`test/common`/`tools/node-modules` from upstream cockpit repo
  (Makefile line ~45: `git fetch --no-tags ... $(COCKPIT_REPO_COMMIT)`).
- The `source` job has a "Pacify git's permission check" step
  (`git config --global --add safe.directory /__w/`), but the fetch inside
  `make` still hits dubious-ownership.
- Affected runs (all same error):
  - run 31117331732 (2026-08-06 16:47, before dry-run/RPM changes)
  - run 31140380509 (2026-08-07 02:10)
  - run 31179538162 (2026-08-07 12:45, latest dry-run)
- So this bug predates the dry-run/RPM work and is a pre-existing issue.

### Likely fix (not yet applied)

The tasks container runs `--user root`, but `actions/checkout` and `make-bots`
reset `$HOME`/git config, so the `--global` safe.directory may not stick for the
make step's `git fetch`. Try adding a repo-local safe.directory, e.g. in the
"Build release" step:

```sh
git config --global --add safe.directory '*'   # or the exact /__w/... path
```

or set the env var `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory
GIT_CONFIG_VALUE_0=*` on the job/step. To be verified on the next dry-run run.

### How to reproduce

Trigger the release workflow manually from the Actions tab with the **Dry run**
input enabled (builds artifacts, does not publish a GitHub release).
