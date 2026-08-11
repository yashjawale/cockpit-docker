# Packit / Testing Farm setup & findings

Status: **working — Packit/COPR builds and Testing Farm browser tests pass.**
The `test.yml` GitHub Actions workflow was disabled (`test.yml.disabled`) in
favor of the Packit path; see `docs/ci.md` for the full CI picture.

This file captures the setup and lessons learned for moving the cockpit-docker
CI to Packit + Testing Farm, so future maintainers can reproduce/repair it.

## Why Packit instead of GitHub Actions

The repo ships a complete Packit test harness:

- `packit.yaml` — jobs for `tests` (PR + main push), `copr_build` (PR), and release `copr_build`
- `plans/all.fmf` — the tmt plan
- `test/browser/{main.fmf,browser.sh,run-test.sh}` — the actual browser test runner
- `.cockpit-ci/container` — pinned tasks container (`ghcr.io/cockpit-project/tasks:<date>`)

The killer difference vs. `make check` on GitHub Actions:

- `make check` boots nested VMs via libvirt/KVM inside a container. In GitHub
  Actions this required a long chain of container hacks (start `virtqemud`,
  `virtlogd`, mount `/dev/kvm`, `--privileged`, disable libvirt security driver
  and cgroups, run QEMU as root, …) and it never fully worked (last failure:
  guest completes systemd poweroff but `wait_poweroff` times out).
- `test/browser/run-test.sh` runs the tests **against the Testing Farm host
  itself** (`--machine localhost:22`, `--browser localhost:9090`). The tasks
  container only supplies firefox/test tooling, sharing the host network via
  `podman run --network=host` (or `systemd-nspawn`, as cockpit-podman does).
  No libvirt, no nested KVM, no container hacks.

## What works

- `packit validate packit.yaml` → ✅ valid. One harmless warning:
  `Package 'cockpit-docker' does not exist` — only matters for
  `propose_downstream`/`koji`/`bodhi` jobs, which are disabled.
- `packit srpm` → ✅ builds the source tarball and an SRPM
  (`cockpit-docker-1-1.<timestamp>.main.fc44.src.rpm`). The `git describe`
  "failed" log lines are noise from there being no tags yet; it correctly falls
  back to `make print-version` → `1`. All build artifacts are gitignored.
- COPR RPM builds pass on all targets (fedora 43/44/rawhide, centos-stream 9/10,
  incl. aarch64).
- Testing Farm browser tests pass on all supported targets. This required the
  fixes below (history, in case they regress).

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
- **Merge to main**: `tests` runs again (`trigger: commit`, `branch: ^main$`).
- **Tag push** (e.g. `123`): the release `copr_build` job builds RPMs in the
  `yashjawale/cockpit-docker` COPR project; the GitHub `release.yml` workflow
  creates the release with tarball + node cache + `.deb` + `.rpm`.

## Caveats / decisions

- Packit / Testing Farm covers **Fedora + CentOS Stream only**. The
  `debian-trixie` coverage from the old `.github/workflows/test.yml` does NOT
  carry over to Packit.
- GPG signing of release assets is still deferred.
- The pinned `.cockpit-ci/container` is kept fresh by the existing
  `tasks-container-update.yml` workflow.
- `tmt` is not installed locally, so the plan could not be linted here; Testing
  Farm runs it.

## Fixes that were needed (regression notes)

These are the issues hit while getting the Packit tests green, and their fixes:

1. **No libvirt in container** (`qemu:///session` had no socket): GitHub Actions
   containers don't run `virtqemud`/`virtlogd`. Solved in the *disabled*
   `test.yml` by starting them manually — but this whole path was abandoned in
   favor of Packit (see `docs/ci.md`).

2. **`dnf config-manager --add-repo` and `--allowerasing` don't exist on dnf5**
   (Fedora 44): `test/vm.install` now fetches the docker-ce repo with `curl`
   and drops the dnf4-only flags.

3. **Debian detection**: `[ -e /etc/debian_version ]` is false on the trixie
   VM image. `test/vm.install` now branches on `$ID` from `/etc/os-release`.

4. **Tests container had no network** on Testing Farm: `make bots test/common`
   failed with `Could not resolve host: github.com` inside `podman run`.
   Fixed with `--network=host` in `test/browser/browser.sh`.

5. **Wrong host address**: `run-test.sh` used `_gateway` (resolved to the cloud
   router, e.g. `172.31.16.1`), so SSH to the test host timed out. The container
   shares the host network, so the host is reached via `localhost:22` /
   `localhost:9090` (matching cockpit-podman's `run-test.sh`).
