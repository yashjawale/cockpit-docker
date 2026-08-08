set -eux

cd "${SOURCE}"

# tests need cockpit's bots/ libraries and test infrastructure
git init
rm -f bots  # common local case: existing bots symlink
make bots test/common

# disable detection of affected tests; testing takes too long as there is no parallelization
mv .git dot-git

. /run/host/usr/lib/os-release
export TEST_OS="${ID}-${VERSION_ID/./-}"

if [ "$TEST_OS" = "centos-9" ]; then
    TEST_OS="${TEST_OS}-stream"
fi

# Chromium sometimes gets OOM killed on testing farm
export TEST_BROWSER=firefox

EXCLUDES=""

# make it easy to check in logs
echo "TEST_ALLOW_JOURNAL_MESSAGES: ${TEST_ALLOW_JOURNAL_MESSAGES:-}"
echo "TEST_AUDIT_NO_SELINUX: ${TEST_AUDIT_NO_SELINUX:-}"

RC=0
# the tests run in the tasks container, which shares the host network (podman
# --network=host), so the Cockpit test VM is reachable on localhost; use that
# instead of the container gateway
./test/common/run-tests \
    --nondestructive \
    --machine localhost:22 \
    --browser localhost:9090 \
    $EXCLUDES \
|| RC=$?

echo $RC > "$LOGS/exitcode"
cp --verbose Test* "$LOGS" || true
exit $RC
