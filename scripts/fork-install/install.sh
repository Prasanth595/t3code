#!/usr/bin/env bash
# Install or update T3 Code from the Yarden-zamir/t3code fork. See docs/fork.md "Install the fork".
#
#   curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --join <code>
#
# Linux: Fork Release has no Linux build yet, so the script builds the fork from source, like the
#   VPS does. It installs the command `t3` in ~/.local/bin and a systemd user service that runs the
#   server on loopback. Run it again to update.
# macOS: the script installs the newest nightly app from the fork releases. --from-source builds
#   the server from source instead, without a service.
set -euo pipefail

readonly REPO=Yarden-zamir/t3code
readonly REPO_URL="https://github.com/$REPO.git"
readonly RELEASES_API="https://api.github.com/repos/$REPO/releases?per_page=20"
readonly SERVICE=t3code-fork.service

dir="${XDG_DATA_HOME:-$HOME/.local/share}/t3code-fork"
port=3773
join_code=""
service=true
force=false
from_source=false

usage() {
  cat <<EOF
Usage: install.sh [--join <code>] [--from-source] [--dir <path>] [--port <port>] [--no-service] [--force]

  --join <code>   Join the machine map with this one-time code after the install.
  --from-source   Build the server from a fork checkout. Linux always does this for now.
  --dir <path>    From source: the fork checkout. Default: $dir
  --port <port>   From source: the loopback port of the server. Default: $port
  --no-service    From source: do not install or restart the systemd user service.
  --force         macOS app: replace an installed app. Without it, an installed app stays,
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
  curl -fsSL -H "Accept: application/vnd.github+json" "$RELEASES_API" |
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
  open "/Applications/$name"
  if [[ -n "$join_code" ]]; then
    printf '%s' "$join_code" | pbcopy
    log "the join code is on the clipboard. In T3 Code, open Settings > Machines and paste it."
  else
    log "next: in T3 Code, open Settings > Machines and paste the join code from the portal."
  fi
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
  (cd "$dir" && CI=1 pnpm install --frozen-lockfile && pnpm exec vp run --filter t3 build)
}

install_command() {
  local bin="$HOME/.local/bin"
  mkdir -p "$bin"
  # The absolute node path keeps the command working from shells without the nvm setup.
  cat >"$bin/t3" <<EOF
#!/usr/bin/env bash
# Installed by the T3 Code fork installer. Run the installer again to update.
exec "$(command -v node)" "$dir/apps/server/dist/bin.mjs" "\$@"
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
    log "no systemd user session; start the server yourself: t3 --mode web --host 127.0.0.1 --port $port --no-browser"
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
ExecStart=$(command -v node) $dir/apps/server/dist/bin.mjs --mode web --host 127.0.0.1 --port $port --no-browser %h
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --quiet "$SERVICE"
  # A restart stops running agent turns of this server.
  systemctl --user restart "$SERVICE"
  log "the server runs as the systemd user service $SERVICE on http://127.0.0.1:$port"
  log "to keep it running after you log out, run: loginctl enable-linger $(id -un)"
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
  # When Fork Release publishes a Linux build, download it here unless --from-source is set.
  Linux) install_from_source ;;
  Darwin) if [[ "$from_source" == true ]]; then install_from_source; else install_mac; fi ;;
  *) die "use install.ps1 on Windows: https://raw.githubusercontent.com/$REPO/main/scripts/fork-install/install.ps1" ;;
esac
