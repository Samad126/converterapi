#!/usr/bin/env bash
# Run the converter backend locally.
#
#   ./run.sh            start from source (src/server.ts)
#   ./run.sh --watch    same, restarting whenever a source file changes
#   ./run.sh --build    compile to dist/ and run that
#   ./run.sh test       run the test suite
#
# Settings come from the environment, or from a .env file next to this script
# (loaded by node's --env-file-if-exists). Binary locations such as FFMPEG_BIN
# and YTDLP_BIN can be set there too. See README "Environment variables".
#
# The server checks every external tool at boot and refuses to start if one is
# missing. That error names the tool and how to install it.
set -euo pipefail

cd "$(dirname "$0")"

die() {
  echo "run.sh: $*" >&2
  exit 1
}

command -v node >/dev/null || die "node is not installed (needs Node 22 or newer)"
node_major=$(node -p 'process.versions.node.split(".")[0]')
if (( node_major < 22 )); then
  die "node $(node -v) is too old; this needs Node 22 or newer"
fi

if [[ ! -d node_modules ]]; then
  echo "run.sh: node_modules is missing, installing dependencies..."
  npm ci
fi

case "${1:-start}" in
  start)
    exec node --env-file-if-exists=.env --experimental-strip-types src/server.ts
    ;;
  --watch)
    exec node --env-file-if-exists=.env --watch --experimental-strip-types src/server.ts
    ;;
  --build)
    npm run build
    exec node --env-file-if-exists=.env dist/server.js
    ;;
  test)
    exec npm test
    ;;
  *)
    die "unknown option: $1 (use: start, --watch, --build or test)"
    ;;
esac
