#!/bin/sh
#
# Sign release artifacts with the project's GPG signing key.
#
# The armored private key is expected in the GPG_KEY environment variable,
# base64-encoded (e.g. `base64 -w0 secret.gpg.key`), with its passphrase in
# GPG_PASSPHRASE. Every artifact is signed with a detached armored signature
# (*.asc) and the public key is exported to KEYS in the current directory.
#
# Usage: sign-release.sh ARTIFACT...

set -eu

[ -n "${GPG_KEY:-}" ] || { echo "error: GPG_KEY not set" >&2; exit 1; }
[ -n "${GPG_PASSPHRASE:-}" ] || { echo "error: GPG_PASSPHRASE not set" >&2; exit 1; }
[ $# -gt 0 ] || { echo "usage: $0 ARTIFACT..." >&2; exit 1; }

keyfile="${TMPDIR:-/tmp}/cockpit-docker-gpg.key"
trap 'rm -f "$keyfile"' EXIT

# allow gpg --pinentry-mode loopback to feed the passphrase non-interactively
mkdir -p "${GNUPGHOME:-$HOME/.gnupg}" && chmod 700 "${GNUPGHOME:-$HOME/.gnupg}"
if ! grep -q '^allow-loopback-pinentry$' "${GNUPGHOME:-$HOME/.gnupg}/gpg-agent.conf" 2>/dev/null; then
    echo "allow-loopback-pinentry" >> "${GNUPGHOME:-$HOME/.gnupg}/gpg-agent.conf"
fi

# import the signing key and derive its key id
echo "$GPG_KEY" | base64 --decode > "$keyfile"
gpg --batch --import "$keyfile" 2>/dev/null
KEYID="$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^sec:/ { print $5; exit }')"
[ -n "$KEYID" ] || { echo "error: no secret key imported" >&2; exit 1; }

for artifact in "$@"; do
    gpg --batch --yes --pinentry-mode loopback --passphrase "$GPG_PASSPHRASE" \
        --local-user "$KEYID" --detach-sign --armor "$artifact"
    echo "signed $artifact"
done

# export the public key so users can verify the signatures
gpg --batch --armor --export "$KEYID" > KEYS
echo "wrote KEYS"
