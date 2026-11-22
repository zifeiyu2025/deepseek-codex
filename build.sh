#!/usr/bin/env bash
set -euo pipefail

ROOT="D:/MyWorkspace/codex-deepseek"
export CARGO_TARGET_DIR="$ROOT/build"
export LIBSQLITE3_FLAGS=SQLITE_DISABLE_INTRINSIC
export GIT_CONFIG_GLOBAL="${GIT_CONFIG_GLOBAL:-$ROOT/.gitconfig}"
export CARGO_NET_GIT_FETCH_WITH_CLI="${CARGO_NET_GIT_FETCH_WITH_CLI:-true}"
export RUSTUP_DIST_SERVER="${RUSTUP_DIST_SERVER:-https://rsproxy.cn}"
export RUSTUP_UPDATE_ROOT="${RUSTUP_UPDATE_ROOT:-https://rsproxy.cn/rustup}"

trap 'echo "BUILD_EXIT:$?"' EXIT

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

mkdir -p "$ROOT/dist"
cp "$CARGO_TARGET_DIR/release/codex.exe" "$ROOT/dist/codex.exe"
echo "BUILD_DONE"
