#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${ROOT:-$SCRIPT_DIR}"
CODEX_SRC="$ROOT/codex-src"
TOOLCHAIN="${CODEX_RUST_TOOLCHAIN:-1.99.1}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/build}"
export LIBSQLITE3_FLAGS="${LIBSQLITE3_FLAGS:-SQLITE_DISABLE_INTRINSIC}"
export CARGO_NET_GIT_FETCH_WITH_CLI="${CARGO_NET_GIT_FETCH_WITH_CLI:-true}"
export RUSTUP_DIST_SERVER="${RUSTUP_DIST_SERVER:-https://rsproxy.cn}"
export RUSTUP_UPDATE_ROOT="${RUSTUP_UPDATE_ROOT:-https://rsproxy.cn/rustup}"
export CARGO_PROFILE_RELEASE_DEBUG="${CARGO_PROFILE_RELEASE_DEBUG:-0}"
export CARGO_PROFILE_RELEASE_STRIP="${CARGO_PROFILE_RELEASE_STRIP:-symbols}"

if [ -n "${CODEX_GIT_CONFIG:-}" ]; then
  export GIT_CONFIG_GLOBAL="$CODEX_GIT_CONFIG"
elif [ -f "$ROOT/.gitconfig" ]; then
  export GIT_CONFIG_GLOBAL="$ROOT/.gitconfig"
fi

TMP_ENGINE=""
cleanup() {
  status=$?
  [ -n "$TMP_ENGINE" ] && rm -f "$TMP_ENGINE"
  echo "BUILD_EXIT:$status"
}
trap cleanup EXIT

echo "BUILD_START $(date -u +%FT%TZ)"
cd "$CODEX_SRC/codex-rs"

for PATCH in "$ROOT"/patches/*.diff; do
  if [ ! -f "$PATCH" ]; then
    continue
  fi
  if git -C "$CODEX_SRC" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
    echo "PATCH_ALREADY_APPLIED:$(basename "$PATCH")"
  elif git -C "$CODEX_SRC" apply --check "$PATCH" >/dev/null 2>&1; then
    git -C "$CODEX_SRC" apply "$PATCH"
    echo "PATCH_APPLIED:$(basename "$PATCH")"
  else
    echo "PATCH_APPLY_FAILED:$PATCH" >&2
    exit 1
  fi
done

if ! rustup toolchain list 2>/dev/null | grep -q "^${TOOLCHAIN}-"; then
  rustup toolchain install "$TOOLCHAIN" --profile minimal \
    --component clippy --component rustfmt --component rust-src
fi
echo "TOOLCHAIN_OK:$TOOLCHAIN"

if cargo +"$TOOLCHAIN" tree -p codex-cli -i v8 2>/dev/null | grep -q '^v8 v'; then
  echo "V8_FOUND_IN_GRAPH"
  exit 1
fi
echo "V8_CHECK_OK"

cargo +"$TOOLCHAIN" build --release --locked -p codex-cli --bin codex
echo "CARGO_BUILD_OK"

ENGINE_SRC="$CARGO_TARGET_DIR/release/codex.exe"
ENGINE_DST="$ROOT/dist/codex.exe"
if [ ! -f "$ENGINE_SRC" ]; then
  echo "ENGINE_MISSING:$ENGINE_SRC" >&2
  exit 1
fi
if [ -e "$ENGINE_DST" ] && ! ( : >> "$ENGINE_DST" ) 2>/dev/null; then
  echo "ENGINE_IN_USE: stop the app that owns $ENGINE_DST" >&2
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

CODEX_COMMIT=$(git -C "$CODEX_SRC" rev-parse HEAD 2>/dev/null || echo unknown)
CODEX_DIRTY=$(git -C "$CODEX_SRC" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
PATCH_SHA="none"
if compgen -G "$ROOT/patches/*.diff" >/dev/null; then
  PATCH_SHA=$(sha256sum "$ROOT"/patches/*.diff | sha256sum | cut -d' ' -f1)
fi
RUSTC_VERSION=$(rustc +"$TOOLCHAIN" --version 2>/dev/null || echo unknown)
CARGO_VERSION=$(cargo +"$TOOLCHAIN" --version 2>/dev/null || echo unknown)
if command -v node >/dev/null 2>&1; then
  MANIFEST_PATH="$ROOT/dist/engine-manifest.json" \
  ENGINE_SHA="$SRC_SHA" \
  CODEX_COMMIT="$CODEX_COMMIT" \
  CODEX_DIRTY="$CODEX_DIRTY" \
  PATCH_SHA="$PATCH_SHA" \
  RUSTC_VERSION="$RUSTC_VERSION" \
  CARGO_VERSION="$CARGO_VERSION" \
  TOOLCHAIN="$TOOLCHAIN" \
  ENGINE_SRC="$ENGINE_SRC" \
  node -e '
const fs = require("node:fs");
const manifest = {
  builtAt: new Date().toISOString(),
  engineSha256: process.env.ENGINE_SHA,
  engineSource: process.env.ENGINE_SRC,
  codexCommit: process.env.CODEX_COMMIT,
  dirtyFiles: Number(process.env.CODEX_DIRTY || 0),
  patchSha256: process.env.PATCH_SHA,
  rustc: process.env.RUSTC_VERSION,
  cargo: process.env.CARGO_VERSION,
  toolchain: process.env.TOOLCHAIN,
  profile: {
    debug: process.env.CARGO_PROFILE_RELEASE_DEBUG,
    strip: process.env.CARGO_PROFILE_RELEASE_STRIP,
  },
};
fs.writeFileSync(process.env.MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
'
fi
echo "MANIFEST_OK"
echo "BUILD_DONE"
