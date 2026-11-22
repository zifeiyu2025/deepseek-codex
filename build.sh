#!/usr/bin/env bash
set -euo pipefail

ROOT="D:/MyWorkspace/codex-deepseek"
export CARGO_TARGET_DIR="$ROOT/build"
export LIBSQLITE3_FLAGS=SQLITE_DISABLE_INTRINSIC
export GIT_CONFIG_GLOBAL="${GIT_CONFIG_GLOBAL:-$ROOT/.gitconfig}"
export CARGO_NET_GIT_FETCH_WITH_CLI="${CARGO_NET_GIT_FETCH_WITH_CLI:-true}"
export RUSTUP_DIST_SERVER="${RUSTUP_DIST_SERVER:-https://rsproxy.cn}"
export RUSTUP_UPDATE_ROOT="${RUSTUP_UPDATE_ROOT:-https://rsproxy.cn/rustup}"

TMP_ENGINE=""
cleanup() {
  status=$?
  [ -n "$TMP_ENGINE" ] && rm -f "$TMP_ENGINE"
  echo "BUILD_EXIT:$status"
}
trap cleanup EXIT

echo "BUILD_START $(date -u +%FT%TZ)"
cd "$ROOT/codex-src/codex-rs"

rustup toolchain install 1.99.1 --profile minimal \
  --component clippy --component rustfmt --component rust-src
echo "TOOLCHAIN_OK"

if cargo tree -p codex-cli -i v8 2>/dev/null | grep -q '^v8 v'; then
  echo "V8_FOUND_IN_GRAPH"
  exit 1
fi
echo "V8_CHECK_OK"

cargo build --release -p codex-cli --bin codex
echo "CARGO_BUILD_OK"

ENGINE_SRC="$CARGO_TARGET_DIR/release/codex.exe"
ENGINE_DST="$ROOT/dist/codex.exe"
if [ ! -f "$ENGINE_SRC" ]; then
  echo "ENGINE_MISSING:$ENGINE_SRC" >&2
  exit 1
fi
if tasklist 2>/dev/null | tr -d '\r' | grep -qi '^codex\.exe'; then
  echo "ENGINE_IN_USE: stop the running desktop app before replacing $ENGINE_DST" >&2
  exit 1
fi
mkdir -p "$ROOT/dist"
TMP_ENGINE="$ENGINE_DST.tmp.$$"
cp "$ENGINE_SRC" "$TMP_ENGINE"
SRC_SHA=$(sha256sum "$ENGINE_SRC" | cut -d' ' -f1)
TMP_SHA=$(sha256sum "$TMP_ENGINE" | cut -d' ' -f1)
if [ "$SRC_SHA" != "$TMP_SHA" ]; then
  echo "ENGINE_COPY_HASH_MISMATCH" >&2
  exit 1
fi
mv -f "$TMP_ENGINE" "$ENGINE_DST"
TMP_ENGINE=""
echo "ENGINE_SHA256:$SRC_SHA"
echo "BUILD_DONE"
