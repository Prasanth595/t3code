#!/usr/bin/env bash
# Install or update T3 Code from the Yarden-zamir/t3code fork. See docs/fork.md "Install the fork".
#
#   curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --join <code>
#
# Linux with a display: the script installs the newest nightly AppImage from the fork releases.
# Linux without a display: the script installs the newest server archive from the fork releases,
#   the command `t3` in ~/.local/bin and a systemd user service that runs the server on loopback.
#   Run it again to update.
# macOS: the script installs the newest nightly app from the fork releases.
# --from-source builds the server from a fork checkout instead. On macOS it installs no service.
set -euo pipefail

readonly REPO=Yarden-zamir/t3code
readonly REPO_URL="https://github.com/$REPO.git"
readonly RELEASES_API="https://api.github.com/repos/$REPO/releases?per_page=20"
readonly SERVICE=t3code-fork.service
readonly DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
readonly SERVER_DIR="$DATA_DIR/t3code-fork-server"
readonly LINUX_APP="$HOME/Applications/T3-Code.AppImage"
# Minimal server images can lack these packages.
# libatomic1: the server binary needs it, and minimal arm64 images lack it.
readonly APT_HINT="sudo apt-get update && sudo apt-get install -y curl tar ca-certificates libatomic1"

dir="$DATA_DIR/t3code-fork"
# The program and first arguments that run the server CLI. Each install path sets it.
server=()
port=3773
join_code=""
service=true
force=false
from_source=false

usage() {
  cat <<EOF
Usage: install.sh [--join <code>] [--from-source] [--dir <path>] [--port <port>] [--no-service] [--force]

  --join <code>   Join the machine map with this one-time code. The server joins at once;
                  the app joins when it starts.
  --from-source   Build the server from a fork checkout instead of a release.
  --dir <path>    From source: the fork checkout. Default: $dir
  --port <port>   Server: the loopback port of the server. Default: $port
  --no-service    Server: do not install or restart the systemd user service.
  --force         App: replace an installed app. Without it, an installed app stays,
                  because the app updates itself.
EOF
}

log() { printf '\033[1mt3 install:\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31mt3 install:\033[0m %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --join) join_code="${2:?--join needs a code}"; shift 2 ;;
    --dir) dir="${2:?--dir needs a path}"; shift 2 ;;
    --port) port="${2:?--port needs a number}"; shift 2 ;;
    --no-service) service=false; shift ;;
    --from-source) from_source=true; shift ;;
    --force) force=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is missing. $2"
}

# macOS ------------------------------------------------------------------------------------------

# Prints the download URL of the first asset whose name ends with $1, in the newest release that
# has one. The API lists releases newest first and includes pre-releases. A plain text search
# keeps the script free of a JSON tool; each URL sits on its own line of the API response.
newest_asset_url() {
  local releases
  releases="$(curl -fsSL -H "Accept: application/vnd.github+json" "$RELEASES_API")" ||
    die "cannot read $RELEASES_API. Check the network and the CA certificates, for example: $APT_HINT"
  printf '%s\n' "$releases" |
    tr ',' '\n' |
    grep -F '"browser_download_url"' |
    grep -F -- "$1\"" |
    head -n 1 |
    cut -d '"' -f 4
}

install_mac() {
  [[ "$(uname -m)" == arm64 ]] || die "the fork publishes the macOS app for Apple silicon only."
  local url mount app name
  url="$(newest_asset_url "-arm64.dmg")"
  [[ -n "$url" ]] || die "no macOS release found. Open https://github.com/$REPO/releases"
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # Expand $tmp now: it is local.
  trap "hdiutil detach -quiet '$tmp/mount' 2>/dev/null || true; rm -rf '$tmp'" EXIT
  log "downloading $url"
  curl -fL --progress-bar -o "$tmp/t3.dmg" "$url"
  mount="$tmp/mount"
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$tmp/t3.dmg"
  app="$(find "$mount" -maxdepth 1 -name '*.app' -print -quit)"
  [[ -n "$app" ]] || die "the disk image holds no app."
  name="$(basename "$app")"
  if [[ -d "/Applications/$name" && "$force" != true ]]; then
    log "/Applications/$name is already installed. It updates itself. Use --force to replace it."
  else
    log "copying $name to /Applications"
    rm -rf "/Applications/$name"
    ditto "$app" "/Applications/$name"
  fi
  leave_join_code
  open "/Applications/$name"
}

# MM-211: the app server joins the machine map with this file at its next start, then deletes it.
leave_join_code() {
  if [[ -z "$join_code" ]]; then
    log "next: in T3 Code, open Settings > Machines and paste the join code from the portal."
    return
  fi
  local file="${T3CODE_HOME:-$HOME/.t3}/userdata/machine-map-join-code"
  mkdir -p "$(dirname "$file")"
  (umask 077 && printf '%s\n' "$join_code" >"$file")
  log "T3 Code joins the machine map when it starts. If it was open already, quit it and open it again."
  log "if it does not join within 10 minutes, open Settings > Machines and paste $join_code"
}

# Linux ------------------------------------------------------------------------------------------

# Prints the arch part of the Linux asset names: x64 or arm64.
linux_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) die "the fork publishes Linux builds for x86_64 and aarch64 only, not $(uname -m)." ;;
  esac
}

# The AppImage updates itself in place, so its file name has no version.
install_linux_app() {
  need curl "Install it with your package manager, for example: sudo apt install curl"
  local suffix=-x86_64.AppImage url
  [[ "$(linux_arch)" == x64 ]] || suffix=-arm64.AppImage
  if [[ -f "$LINUX_APP" && "$force" != true ]]; then
    log "$LINUX_APP is already installed. It updates itself. Use --force to replace it."
  else
    url="$(newest_asset_url "$suffix")"
    [[ -n "$url" ]] || die "no Linux app found. Open https://github.com/$REPO/releases"
    mkdir -p "$(dirname "$LINUX_APP")" "$DATA_DIR/applications"
    log "downloading $url"
    curl -fL --progress-bar -o "$LINUX_APP.download" "$url"
    chmod +x "$LINUX_APP.download"
    mv -f "$LINUX_APP.download" "$LINUX_APP"
    cat >"$DATA_DIR/applications/t3code-fork.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=T3 Code
Exec=$LINUX_APP %U
Terminal=false
Categories=Development;
EOF
    log "installed $LINUX_APP and its menu entry"
  fi
  # AppImages need FUSE 2. Ubuntu 24.04 ships only FUSE 3 by default.
  if ! ldconfig -p 2>/dev/null | grep -qF libfuse.so.2; then
    log "if the app does not start, install FUSE 2, for example: sudo apt install libfuse2t64"
  fi
  leave_join_code
  nohup "$LINUX_APP" >/dev/null 2>&1 &
}

# Installs the newest server archive into $SERVER_DIR/<version> and points $SERVER_DIR/current at
# it. The archive holds the `t3` single-executable, so the machine needs no Node.
install_linux_server() {
  need curl "Install it with your package manager, for example: $APT_HINT"
  need tar "Install it with your package manager, for example: $APT_HINT"
  need sha256sum "Install coreutils with your package manager."
  local arch url archive version
  arch="$(linux_arch)"
  url="$(newest_asset_url "-linux-$arch.tar.gz")"
  [[ -n "$url" ]] || die "no Linux server archive found. Open https://github.com/$REPO/releases"
  archive="$(basename "$url")"
  version="${archive#t3-}"
  version="${version%-linux-"$arch".tar.gz}"
  if [[ "$(cat "$SERVER_DIR/$version/.install-complete" 2>/dev/null)" == "$version" ]]; then
    log "the server $version is already downloaded"
  else
    mkdir -p "$SERVER_DIR"
    local staging
    staging="$(mktemp -d "$SERVER_DIR/.staging-XXXXXX")"
    # shellcheck disable=SC2064 # Expand $staging now: it is local.
    trap "rm -rf '$staging'" EXIT
    log "downloading $url"
    curl -fL --progress-bar -o "$staging/$archive" "$url"
    curl -fsSL -o "$staging/$archive.sha256" "$url.sha256"
    (cd "$staging" && sha256sum --check --quiet "$archive.sha256") ||
      die "the download of $archive is damaged. Run the installer again."
    tar -xzf "$staging/$archive" -C "$staging" --strip-components=1
    rm -f "$staging/$archive" "$staging/$archive.sha256"
    if ! "$staging/t3" --version >/dev/null; then
      local missing
      missing="$(ldd "$staging/t3" 2>/dev/null | awk '/not found/ {print $1}' | paste -sd ' ' -)"
      [[ -z "$missing" ]] || die "t3 needs these system libraries: $missing. For example: $APT_HINT"
      die "the downloaded t3 does not run on this machine."
    fi
    # The marker shows a complete extraction, like the pinned runtime of `t3 service install`.
    printf '%s\n' "$version" >"$staging/.install-complete"
    rm -rf "${SERVER_DIR:?}/$version"
    mv "$staging" "$SERVER_DIR/$version"
    trap - EXIT
  fi
  # Keep the version that ran before, because a server without the service can still run from it.
  local previous old
  previous="$(readlink "$SERVER_DIR/current" 2>/dev/null || true)"
  ln -sfn "$version" "$SERVER_DIR/current"
  for old in "$SERVER_DIR"/*/; do
    old="$(basename "$old")"
    [[ "$old" == current || "$old" == "$version" || "$old" == "$previous" ]] || rm -rf "${SERVER_DIR:?}/$old"
  done
  server=("$SERVER_DIR/current/t3")
  start_server
}

# From source ------------------------------------------------------------------------------------

check_source_prerequisites() {
  need git "Install it with your package manager, for example: sudo apt install git"
  need node "Install Node 24, for example with https://github.com/nvm-sh/nvm: nvm install 24"
  need pnpm "Install it with: corepack enable pnpm   (or: npm install -g pnpm@11)"
  need curl "Install it with your package manager, for example: sudo apt install curl"
}

# Fails unless node and pnpm match the root package.json of the checkout in $dir. Corepack picks
# the pnpm of packageManager only inside the checkout.
check_versions() {
  node - "$dir/package.json" "$(cd "$dir" && pnpm --version)" <<'EOF'
const [manifestPath, pnpmVersion] = process.argv.slice(2);
const manifest = require(manifestPath);
const parts = (version) => version.split(".").map(Number);
const wanted = manifest.engines.node.replace("^", "");
const [wantMajor, wantMinor, wantPatch] = parts(wanted);
const [major, minor, patch] = parts(process.versions.node);
const nodeOk =
  major === wantMajor && (minor > wantMinor || (minor === wantMinor && patch >= wantPatch));
const wantPnpm = manifest.packageManager.split("@")[1];
const pnpmOk = parts(pnpmVersion)[0] === parts(wantPnpm)[0];
if (!nodeOk) console.error(`Node ${process.versions.node} found; the fork needs Node ^${wanted}. Run: nvm install ${wantMajor}`);
if (!pnpmOk) console.error(`pnpm ${pnpmVersion} found; the fork needs pnpm ${wantPnpm}. Run: corepack enable pnpm   (or: npm install -g pnpm@${wantPnpm})`);
process.exit(nodeOk && pnpmOk ? 0 : 1);
EOF
}

checkout_fork() {
  if [[ -d "$dir/.git" ]]; then
    [[ "$(git -C "$dir" remote get-url origin)" == "$REPO_URL" ]] ||
      die "$dir is a checkout of another repository. Use --dir to pick another folder."
    [[ -z "$(git -C "$dir" status --porcelain)" ]] ||
      die "$dir has local changes. Commit or remove them, then run the installer again."
    log "updating $dir"
    git -C "$dir" fetch --quiet origin main
    git -C "$dir" checkout --quiet --detach FETCH_HEAD
  elif [[ -e "$dir" ]]; then
    die "$dir exists and is not a fork checkout. Use --dir to pick another folder."
  else
    log "cloning $REPO into $dir"
    mkdir -p "$(dirname "$dir")"
    git clone --quiet --branch main "$REPO_URL" "$dir"
  fi
}

build_fork() {
  log "building $(git -C "$dir" rev-parse --short HEAD); this takes a few CPU minutes"
  # Node limits its heap to a part of the memory, about 2 GB on a machine with 6 GB. The dependency
  # check of `pnpm exec` then runs out of heap. Revisit when the build needs more than 4 GB.
  (
    export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096"
    cd "$dir" && CI=1 pnpm install --frozen-lockfile && pnpm exec vp run --filter t3 build
  )
}

# The server -------------------------------------------------------------------------------------

install_command() {
  local bin="$HOME/.local/bin"
  mkdir -p "$bin"
  cat >"$bin/t3" <<EOF
#!/usr/bin/env bash
# Installed by the T3 Code fork installer. Run the installer again to update.
exec $(printf '%q ' "${server[@]}")"\$@"
EOF
  chmod +x "$bin/t3"
  log "installed $bin/t3"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) log "add $bin to your PATH, for example: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc" ;;
  esac
}

install_service() {
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    log "no systemd user session. Log in as this user over SSH, not with sudo or su, and run the installer again."
    log "or start the server yourself: t3 --mode web --host 127.0.0.1 --port $port --no-browser"
    return 1
  fi
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  # The server starts provider CLIs (claude, codex), so it gets the PATH of this shell.
  # Run the installer again after a PATH change.
  cat >"$unit_dir/$SERVICE" <<EOF
[Unit]
Description=T3 Code server (Yarden-zamir/t3code fork)
After=network-online.target

[Service]
Environment=PATH=$PATH
WorkingDirectory=%h
# Loopback only. Publish it with a tunnel, as docs/fork.md describes.
ExecStart=${server[*]} --mode web --host 127.0.0.1 --port $port --no-browser %h
# Always: the machine map restarts the server with a clean exit (restartServer, a new tunnel).
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --quiet "$SERVICE"
  # A restart stops running agent turns of this server.
  systemctl --user restart "$SERVICE"
  log "the server runs as the systemd user service $SERVICE on http://127.0.0.1:$port"
  enable_linger
}

# Without lingering, systemd stops the user service when the last session of the user ends.
# Same steps as upstream `t3 service install`: try without sudo, else print the admin command.
enable_linger() {
  local user
  user="$(id -un)"
  [[ "$(loginctl show-user "$user" --property=Linger --value 2>/dev/null)" == yes ]] && return 0
  if loginctl enable-linger "$user" 2>/dev/null; then
    log "turned on lingering for $user, so the server keeps running after you log out"
  else
    log "the server stops when you log out. To keep it running, run: sudo loginctl enable-linger $user"
  fi
}

wait_for_server() {
  local _
  for _ in $(seq 1 60); do
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/")" == 200 ]]; then
      return 0
    fi
    sleep 2
  done
  die "the server did not answer on port $port. Read its log: journalctl --user -u $SERVICE -n 50"
}

install_from_source() {
  check_source_prerequisites
  checkout_fork
  check_versions || die "fix the versions above, then run the installer again."
  build_fork
  # The absolute node path keeps the command working from shells without the nvm setup.
  server=("$(command -v node)" "$dir/apps/server/dist/bin.mjs")
  start_server
}

# Installs the command and the service for $server, then joins with the join code.
start_server() {
  install_command
  local running=false
  if [[ "$service" == true ]] && install_service; then
    running=true
  fi
  if [[ -z "$join_code" ]]; then
    log "next: t3 machine-map join <code>   (the code comes from Add machine in the portal)"
  elif [[ "$running" == true ]]; then
    wait_for_server
    "$HOME/.local/bin/t3" machine-map join "$join_code"
  else
    log "next: start the server, then run: t3 machine-map join $join_code"
  fi
}

case "$(uname -s)" in
  Linux)
    if [[ "$from_source" == true ]]; then
      install_from_source
    elif [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]]; then
      install_linux_app
    else
      install_linux_server
    fi
    ;;
  Darwin) if [[ "$from_source" == true ]]; then install_from_source; else install_mac; fi ;;
  *) die "use install.ps1 on Windows: https://raw.githubusercontent.com/$REPO/main/scripts/fork-install/install.ps1" ;;
esac
