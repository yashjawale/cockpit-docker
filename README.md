# Cockpit Docker

A simple [Cockpit](https://cockpit-project.org/) plugin for managing docker container & images.

# Development dependencies

On Debian/Ubuntu:

    sudo apt install gettext nodejs npm make

On Fedora:

    sudo dnf install gettext nodejs npm make

On openSUSE Tumbleweed and Leap:

    sudo zypper in gettext-runtime nodejs npm make

# Getting and building the source

These commands check out the source and build it into the `dist/` directory:

```
git clone https://github.com/yashjawale/cockpit-docker.git
cd cockpit-docker
make
```

# Installing

`make install` compiles and installs the package in `/usr/local/share/cockpit/`. The
convenience targets `srpm` and `rpm` build the source and binary rpms,
respectively, and `deb` builds a Debian binary package (requires `dpkg-buildpackage`).
All of these make use of the `dist` target, which is used
to generate the distribution tarball. In `production` mode, source files are
automatically minified and compressed. Set `NODE_ENV=production` if you want to
duplicate this behavior.

# Packaging

The project ships packaging metadata for several distributions:

- RPM: `cockpit-docker.spec` (generated from
  `packaging/cockpit-docker.spec.in`), built with `make srpm` / `make rpm` and
  published through [Packit](./packit.yaml). The
  [release](./.github/workflows/release.yml) workflow also builds an RPM from
  the release tarball on CentOS Stream and attaches it to every GitHub release.
- Arch Linux: `packaging/arch/PKGBUILD.in`.
- Debian/Ubuntu: `packaging/debian/`, assembled into a `debian/` directory in
  the release tarball at `make dist` time. The release tarball ships the
  pre-built `dist/` bundle, so `dpkg-buildpackage -b -us -uc` can be run
  directly from the extracted tarball without a node toolchain. Use
  `make deb` to build a `.deb` locally; the [release](./.github/workflows/release.yml)
  workflow builds and attaches one to every GitHub release.

For development, you usually want to run your module straight out of the git
tree. To do that, run `make devel-install`, which links your checkout to the
location were cockpit-bridge looks for packages. If you prefer to do
this manually:

```
mkdir -p ~/.local/share/cockpit
ln -s `pwd`/dist ~/.local/share/cockpit/cockpit-docker
```

After changing the code and running `make` again, reload the Cockpit page in
your browser.

You can also use
[watch mode](https://esbuild.github.io/api/#watch) to
automatically update the bundle on every code change with

    ./build.js -w

or

    make watch

When developing against a virtual machine, watch mode can also automatically upload
the code changes by setting the `RSYNC` environment variable to
the remote hostname.

    RSYNC=c make watch

When developing against a remote host as a normal user, `RSYNC_DEVEL` can be
set to upload code changes to `~/.local/share/cockpit/` instead of
`/usr/local`.

    RSYNC_DEVEL=example.com make watch

To "uninstall" the locally installed version, run `make devel-uninstall`, or
remove manually the symlink:

    rm ~/.local/share/cockpit/cockpit-docker

# Running eslint

Cockpit Docker uses [ESLint](https://eslint.org/) to automatically check
JavaScript/TypeScript code style in `.js[x]` and `.ts[x]` files.

eslint is executed as part of `test/static-code`, aka. `make codecheck`.

For developer convenience, the ESLint can be started explicitly by:

    npm run eslint

Violations of some rules can be fixed automatically by:

    npm run eslint:fix

Rules configuration can be found in the `.eslintrc.json` file.

## Running stylelint

Cockpit uses [Stylelint](https://stylelint.io/) to automatically check CSS code
style in `.css` and `scss` files.

styleint is executed as part of `test/static-code`, aka. `make codecheck`.

For developer convenience, the Stylelint can be started explicitly by:

    npm run stylelint

Violations of some rules can be fixed automatically by:

    npm run stylelint:fix

Rules configuration can be found in the `.stylelintrc.json` file.

# Running tests locally

Run `make check` to build an RPM, install it into a standard Cockpit test VM
(centos-9-stream by default), and run the test/check-application integration test on
it. This uses Cockpit's Chrome DevTools Protocol based browser tests, through a
Python API abstraction. Note that this API is not guaranteed to be stable, so
if you run into failures and don't want to adjust tests, consider checking out
Cockpit's test/common from a tag instead of main (see the `test/common`
target in `Makefile`).

Chromium is the default test browser, but Firefox is often more reliable
(lower memory usage and fewer OOM issues), so it is recommended:

    TEST_BROWSER=firefox make check

After the test VM is prepared, you can manually run the test without rebuilding
the VM, possibly with extra options for tracing and halting on test failures
(for interactive debugging):

    TEST_OS=fedora-44 test/check-application -tvs

It is possible to setup the test environment without running the tests:

    TEST_OS=fedora-44 make prepare-check

You can also run the test against a different Cockpit image, for example:

    TEST_OS=debian-trixie make check

# Running tests in CI

Integration tests run in [Packit](https://packit.dev/) on
[Testing Farm](https://docs.testing-farm.io/) for all currently supported
Fedora and CentOS Stream releases, on both pull requests and pushes to main;
see the [packit.yaml](./packit.yaml) control file. You need to
[enable Packit-as-a-service](https://packit.dev/docs/packit-service/) in your GitHub project to use this.
To run the tests in the exact same way for upstream pull requests and for
[Fedora package update gating](https://docs.fedoraproject.org/en-US/ci/), the
tests are wrapped in the [FMF metadata format](https://github.com/teemtee/fmf)
for using with the [tmt test management tool](https://docs.fedoraproject.org/en-US/ci/tmt/).
Note that Packit tests can *not* run their own virtual machine images, thus
they only run [@nondestructive tests](https://github.com/cockpit-project/cockpit/blob/main/test/common/testlib.py).

`make codecheck` (eslint, stylelint, mypy, ruff, vulture, TypeScript typecheck,
...), the [release](./.github/workflows/release.yml) workflow, and dependency
updates run in [GitHub Actions](https://github.com/features/actions).

See [docs/ci.md](./docs/ci.md) for details on all CI systems, and
[docs/packit-setup.md](./docs/packit-setup.md) for the Packit/Testing Farm
setup.

# Automated release

Once your cloned project is ready for a release, you should consider automating
that. The intention is that the only manual step for releasing a project is to create
a signed tag for the version number, which includes a summary of the noteworthy
changes:

```
123

- this new feature
- fix bug #123
```

Pushing the release tag triggers the [release.yml](.github/workflows/release.yml)
[GitHub action](https://github.com/features/actions) workflow. This creates the
official release tarball, builds and attaches Debian and RPM packages, and
publishes them as upstream release to GitHub.

You can test the release builds without publishing anything by triggering the
workflow manually from the Actions tab (select the `release` workflow, "Run
workflow", keep the "Dry run" input enabled). This builds the same tarball,
`.deb`, and `.rpm`, uploads them to the workflow run as artifacts for
inspection, but does not create a GitHub release.

The Fedora and COPR releases are done with [Packit](https://packit.dev/),
see the [packit.yaml](./packit.yaml) control file.

# Automated maintenance

It is important to keep your [NPM modules](./package.json) up to date, to keep
up with security updates and bug fixes. This happens with
[dependabot](https://github.com/dependabot),
see [configuration file](.github/dependabot.yml).
