#!/usr/bin/env bash
# Offline lifecycle tests. No root, Docker daemon, network or /opt writes required.
set -Eeuo pipefail
TEST_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lumina.sh"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lumina.test.sh"
if [[ -n "${LUMINA_TEST_PYTHON:-}" ]]; then
  python3() { "$LUMINA_TEST_PYTHON" "$@"; }
  export -f python3
fi

worker() {
  local scenario="$1"
  source "$TEST_SCRIPT"
  INSTALL_ROOT="$LUMINA_TEST_ROOT"
  TMP_DIR="$INSTALL_ROOT/.staging.test"
  mkdir -p "$TMP_DIR" "$INSTALL_ROOT/config" "$INSTALL_ROOT/data" "$INSTALL_ROOT/releases/1.0.0/deploy" "$INSTALL_ROOT/releases/1.1.0/deploy"
  printf 'original database\n' > "$INSTALL_ROOT/data/gallery.db"
  printf '%s\n' "$MARKER_TEXT" > "$INSTALL_ROOT/.managed"
  printf 'installed\n' > "$INSTALL_ROOT/.state"
  DOMAIN=gallery.example.com EMAIL=admin@example.com
  write_env "$INSTALL_ROOT/config/deploy.env" lumina-gallery:1.0.0
  printf '1.0.0\n' > "$INSTALL_ROOT/pointer"
  VERSION=1.1.0
  record() { printf '%s\n' "$*" >> "$INSTALL_ROOT/events"; }
  current_release() { printf '%s/releases/%s\n' "$INSTALL_ROOT" "$(cat "$INSTALL_ROOT/pointer")"; }
  point_current() {
    if [[ "$scenario" == pointer-fail && "$1" == "$INSTALL_ROOT/releases/1.1.0" ]]; then die 'injected pointer failure'; fi
    printf '%s\n' "${1##*/}" > "$INSTALL_ROOT/pointer"
    record "pointer ${1##*/}"
  }
  compose_at() {
    local release="$1" env_file="$2"; shift 2
    validate_env "$release" "$env_file" || return 1
    record "compose ${release##*/} $*"
    if [[ "$1" == up && "${release##*/}" == 1.1.0 && "${*: -1}" == lumina ]]; then
      printf 'migrated database\n' > "$INSTALL_ROOT/data/gallery.db"
    fi
  }
  release_metadata() { VERSION=1.1.0; record metadata; }
  fetch_release() { record fetch; }
  checkpoint_backup() {
    record snapshot
    [[ "$scenario" != snapshot-fail ]] || die 'injected snapshot failure'
    ROLLBACK_DIR="$INSTALL_ROOT/upgrade-backups/test"
    mkdir -p "$ROLLBACK_DIR"
    cp "$INSTALL_ROOT/config/deploy.env" "$ROLLBACK_DIR/deploy.env"
    cp "$INSTALL_ROOT/data/gallery.db" "$ROLLBACK_DIR/gallery.db"
  }
  docker() {
    record restore-database
    cp "$ROLLBACK_DIR/gallery.db" "$INSTALL_ROOT/data/gallery.db"
  }
  wait_healthy() {
    local version; version="$(cat "$INSTALL_ROOT/pointer")"
    record "health $version ${1:-yes}"
    [[ "$scenario" != health-fail || "$version" != 1.1.0 ]]
  }
  install_manager() { record manager; }
  cleanup_owned_history() { record prune; }
  verify_https() { record https; }
  trap cleanup EXIT
  do_upgrade
}

if [[ "${1:-}" == --worker ]]; then worker "$2"; exit; fi

source "$TEST_SCRIPT"
TEST_ROOT="$(mktemp -d)"
if command -v cygpath >/dev/null; then TEST_ROOT="$(cygpath -m "$TEST_ROOT")"; fi
trap 'rm -rf -- "$TEST_ROOT"' EXIT
INSTALL_ROOT="$TEST_ROOT/basic"
mkdir -p "$INSTALL_ROOT/config" "$INSTALL_ROOT/releases/1.0.0"
assert() { "$@" || { printf 'FAIL: %s\n' "$*" >&2; exit 1; }; }
reject() { if "$@" >/dev/null 2>&1; then printf 'FAIL: unexpectedly accepted %s\n' "$*" >&2; exit 1; fi; }

assert version_valid 1.0.0
assert version_valid 2.0.0-beta.1
reject version_valid '../1.0.0'
reject version_valid '1.0.0;whoami'
reject version_valid '01.0.0'
reject version_valid '1.0.0-beta..1'
assert domain_valid gallery.example.com
reject domain_valid 'https://gallery.example.com'
reject domain_valid 'gallery.example.com { respond secret }'
reject domain_valid 127.0.0.1
reject email_valid 'a@example.com;whoami'
assert newer_version 1.0.0 1.0.1
assert newer_version 1.0.0-beta.2 1.0.0-beta.10
assert newer_version 1.0.0-beta.10 1.0.0
reject newer_version 1.1.0 1.0.9
reject newer_version 1.0.0 1.0.0-beta.10
reject newer_version 1.0.0 1.0.0

DOMAIN=gallery.example.com EMAIL=admin@example.com
write_env "$INSTALL_ROOT/config/deploy.env" lumina-gallery:1.0.0
assert validate_env "$INSTALL_ROOT/releases/1.0.0" "$INSTALL_ROOT/config/deploy.env"
assert test "$(env_value "$INSTALL_ROOT/config/deploy.env" LUMINA_IMAGE)" = lumina-gallery:1.0.0
cp "$INSTALL_ROOT/config/deploy.env" "$INSTALL_ROOT/config/wrong.env"
printf 'LUMINA_DATA_DIR=/tmp/foreign-data\n' >> "$INSTALL_ROOT/config/wrong.env"
reject validate_env "$INSTALL_ROOT/releases/1.0.0" "$INSTALL_ROOT/config/wrong.env"
cp "$INSTALL_ROOT/config/deploy.env" "$INSTALL_ROOT/config/injection.env"
printf 'ATTACK=$(touch /tmp/lumina-must-never-run)\n' >> "$INSTALL_ROOT/config/injection.env"
reject env_value "$INSTALL_ROOT/config/injection.env" LUMINA_IMAGE
reject validate_env "$INSTALL_ROOT/releases/1.0.0" "$INSTALL_ROOT/config/injection.env"
assert test ! -e /tmp/lumina-must-never-run
write_env "$INSTALL_ROOT/config/invalid-proxy.env" lumina-gallery:1.0.0 172.30.91.0/29 172.30.91.3
reject validate_env "$INSTALL_ROOT/releases/1.0.0" "$INSTALL_ROOT/config/invalid-proxy.env"
reject validate_env "$INSTALL_ROOT/releases/1.1.0" "$INSTALL_ROOT/config/deploy.env"

# Prove shell exports cannot override the checked deployment env file.
mkdir -p "$TEST_ROOT/bin"
cat > "$TEST_ROOT/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "${LUMINA_IMAGE-unset}" "${LUMINA_DOMAIN-unset}" "${ACME_EMAIL-unset}" "${LUMINA_DATA_DIR-unset}" "${LUMINA_CONFIG_DIR-unset}" "${LUMINA_PROXY_SUBNET-unset}" "${LUMINA_PROXY_IP-unset}" > "$LUMINA_TEST_CAPTURE"
MOCK
chmod +x "$TEST_ROOT/bin/docker"
export LUMINA_TEST_CAPTURE="$TEST_ROOT/capture"
export LUMINA_IMAGE=evil LUMINA_DOMAIN=evil ACME_EMAIL=evil LUMINA_DATA_DIR=/tmp/foreign-data LUMINA_CONFIG_DIR=evil LUMINA_PROXY_SUBNET=evil LUMINA_PROXY_IP=evil
MOCK_BIN="$TEST_ROOT/bin"
if command -v cygpath >/dev/null; then MOCK_BIN="$(cygpath -u "$MOCK_BIN")"; fi
PATH="$MOCK_BIN:$PATH" compose_at "$INSTALL_ROOT/releases/1.0.0" "$INSTALL_ROOT/config/deploy.env" config --quiet
assert test "$(cat "$TEST_ROOT/capture" | sort -u)" = unset
unset LUMINA_IMAGE LUMINA_DOMAIN ACME_EMAIL LUMINA_DATA_DIR LUMINA_CONFIG_DIR LUMINA_PROXY_SUBNET LUMINA_PROXY_IP

run_worker() {
  local scenario="$1" expected="$2" root="$TEST_ROOT/$1" code=0
  mkdir -p "$root"
  LUMINA_TEST_ROOT="$root" bash "$SELF" --worker "$scenario" > "$root/output" 2>&1 || code=$?
  if [[ "$expected" == success ]]; then assert test "$code" -eq 0; else assert test "$code" -ne 0; fi
}
run_worker success success
run_worker snapshot-fail failure
run_worker health-fail failure
run_worker pointer-fail failure

python3 - "$TEST_ROOT" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
def events(case): return (root / case / 'events').read_text().splitlines()
success = events('success')
stop = success.index('compose 1.0.0 stop -t 60 caddy lumina')
snapshot = success.index('snapshot')
new_start = success.index('compose 1.1.0 up -d --no-build --no-deps lumina')
healthy = success.index('health 1.1.0 no')
proxy_start = success.index('compose 1.1.0 up -d --no-build caddy')
assert stop < snapshot < new_start < healthy < proxy_start, success
assert (root / 'success' / 'pointer').read_text().strip() == '1.1.0'
for case in ('snapshot-fail', 'health-fail', 'pointer-fail'):
    assert (root / case / 'pointer').read_text().strip() == '1.0.0', case
    assert (root / case / 'data' / 'gallery.db').read_text() == 'original database\n', case
snapshot_fail = events('snapshot-fail')
assert 'compose 1.0.0 up -d --no-build' in snapshot_fail, snapshot_fail
assert not any(e.startswith('compose 1.1.0 up ') for e in snapshot_fail), snapshot_fail
for case in ('health-fail', 'pointer-fail'):
    e = events(case)
    stop = e.index('compose 1.1.0 stop -t 60 caddy lumina')
    restore = e.index('restore-database')
    old_start = e.index('compose 1.0.0 up -d --no-build --no-deps lumina')
    old_healthy = e.index('health 1.0.0 no')
    old_proxy = e.index('compose 1.0.0 up -d --no-build caddy')
    assert stop < restore < old_start < old_healthy < old_proxy, e
print('PASS: validators, literal config, environment isolation, upgrade order, snapshot failure, health rollback, pointer-switch rollback')
PY
