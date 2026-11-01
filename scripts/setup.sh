#!/usr/bin/env bash
set -euo pipefail
ZUTRADE_VERSION="$(cat .node-version)"
ZUTRADE_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ZUTRADE_ARCH="$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')"
case "$ZUTRADE_OS-$ZUTRADE_ARCH" in
  darwin-arm64) ZUTRADE_SHA=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7 ;;
  darwin-x64) ZUTRADE_SHA=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035 ;;
  *) echo 'Use macOS arm64/x64, or install the exact .node-version and pnpm manually.' >&2; exit 1 ;;
esac
mkdir -p .local/toolchain .local/logs
ZUTRADE_DIST="node-v$ZUTRADE_VERSION-$ZUTRADE_OS-$ZUTRADE_ARCH"
if [ ! -x ".local/toolchain/$ZUTRADE_DIST/bin/node" ]; then
  curl -fL --connect-timeout 15 --max-time 240 --retry 2 \
    "https://nodejs.org/dist/v$ZUTRADE_VERSION/$ZUTRADE_DIST.tar.gz" -o .local/toolchain/node.tar.gz
  ZUTRADE_ACTUAL="$(shasum -a 256 .local/toolchain/node.tar.gz | cut -d ' ' -f 1)"
  [ "$ZUTRADE_ACTUAL" = "$ZUTRADE_SHA" ] || { echo 'Node checksum mismatch.' >&2; exit 1; }
  tar -xzf .local/toolchain/node.tar.gz -C .local/toolchain
fi
export PATH="$PWD/.local/toolchain/$ZUTRADE_DIST/bin:$PATH"
ZUTRADE_PNPM_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json')).packageManager.split('@')[1]")"
if [ ! -f .local/toolchain/pnpm/node_modules/pnpm/bin/pnpm.mjs ]; then
  npm install --prefix .local/toolchain/pnpm --no-audit --no-fund "pnpm@$ZUTRADE_PNPM_VERSION"
fi
node scripts/configure.mjs
node scripts/a1-configure.mjs
./scripts/zu install --frozen-lockfile
echo 'Local setup complete. Start Docker, then ./scripts/zu infra:up and ./scripts/zu dev.'
