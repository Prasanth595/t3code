#!/usr/bin/env bash
# Builds the fork into release/t3fac-<version>-darwin-arm64.tar.gz with upstream's own
# build scripts, then smoke-tests the archive. `build.sh --print-version` only prints the version.
set -euo pipefail

root=${T3FAC_REPO_ROOT:-$(git rev-parse --show-toplevel)}
cd "$root"

read -r tag _sha < factory/UPSTREAM
if [[ $tag =~ ^v[^\ ]*-nightly\. ]]; then
  upstream=${tag#v}
else
  upstream=$(node -p 'require("./apps/server/package.json").version')
fi
version="${upstream}+fac.$(git rev-parse --short HEAD)"

if [[ ${1:-} == --print-version ]]; then
  echo "$version"
  exit 0
fi

stage=""
smoke=""
server_pid=""

cleanup() {
  if [[ -n $server_pid ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$server_pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$server_pid" 2>/dev/null || true
  fi
  [[ -z $smoke ]] || rm -rf "$smoke"
  [[ -z $stage ]] || rm -rf "$stage"
}
trap cleanup EXIT

# The SEA build needs the Node version upstream pins in the server's vite config.
sea_node=$(sed -n 's/^const SEA_NODE_VERSION = "\([^"]*\)";.*/\1/p' apps/server/vite.config.ts)
if [[ -z $sea_node ]]; then
  echo "could not read SEA_NODE_VERSION from apps/server/vite.config.ts" >&2
  exit 1
fi

echo "build: version $version (SEA node $sea_node)"

vp i
vp run --filter t3 build
# Cargo reads .cargo/config.toml from every parent of the cwd and from CARGO_HOME, so a
# build under $HOME would inherit a host-level crates.io replacement. The lockfile pins
# crates.io, so build from / with a CARGO_HOME of its own under the gitignored target/.
cargo_home="$root/native/resource-monitor/target/cargo-home"
mkdir -p "$cargo_home"
(cd / && CARGO_HOME="$cargo_home" cargo build --locked --release --manifest-path "$root/native/resource-monitor/Cargo.toml")
VP_NODE_VERSION="$sea_node" vp node apps/server/scripts/cli.ts build-exe

stage=$(mktemp -d)
mkdir -p "$stage/monitor/darwin-arm64" "$stage/out"
cp native/resource-monitor/target/release/t3-resource-monitor "$stage/monitor/darwin-arm64/t3-resource-monitor"
VP_NODE_VERSION="$sea_node" vp node scripts/build-cli-archive.ts \
  --platform mac --arch arm64 --version "$version" \
  --resource-monitor-dir "$stage/monitor" --output-dir "$stage/out"

mkdir -p release
archive="release/t3fac-${version}-darwin-arm64.tar.gz"
mv "$stage/out/t3-${version}-darwin-arm64.tar.gz" "$archive"

# Smoke test: start the built server on a free port with a throwaway HOME and base dir.
smoke=$(mktemp -d)
mkdir -p "$smoke/pkg" "$smoke/home"
tar -xzf "$archive" -C "$smoke/pkg"
pkg=$(find "$smoke/pkg" -mindepth 1 -maxdepth 1 -type d | head -n 1)
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')

fail() {
  echo "smoke: FAILED: $1" >&2
  tail -n 40 "$smoke/server.log" >&2 || true
  exit 1
}

echo "smoke: serve on 127.0.0.1:$port"
HOME="$smoke/home" "$pkg/t3" serve --base-dir "$smoke/base" --host 127.0.0.1 --port "$port" \
  > "$smoke/server.log" 2>&1 &
server_pid=$!

ok=""
start=$SECONDS
for _ in $(seq 1 120); do
  kill -0 "$server_pid" 2>/dev/null || fail "server exited early"
  code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/.well-known/t3/environment" || true)
  if [[ $code == 200 ]]; then
    ok=1
    break
  fi
  (( SECONDS - start >= 60 )) && break
  sleep 0.5
done
[[ -n $ok ]] || fail "/.well-known/t3/environment did not answer 200 within 60s"
echo "smoke: /.well-known/t3/environment -> 200 after $((SECONDS - start))s"

grep -q 'factory started' "$smoke/server.log" || fail 'server log does not hold "factory started"'
echo 'smoke: log holds "factory started"'

cleanup
smoke=""
server_pid=""
echo "smoke: server stopped, temp dir removed"

echo "$root/$archive"
