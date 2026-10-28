#!/bin/sh
# Reinstalls the T3 Code desktop app from the newest GitHub Release. It runs no
# T3 Code code, so it works however broken the installed app is. Needs only sh,
# curl or wget, and openssl or sha512sum.
#
#   curl -fsSL https://t3.codes/fix.sh | sh
#
# Environment:
#   T3CODE_CHANNEL           stable or nightly (default: each installed app's own
#                            channel, or stable when none is installed)
#   T3CODE_VERSION           exact version to install (overrides the newest release)
#   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
set -eu

repo="pingdotgg/t3code"
base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"

fail() {
  printf '\nt3 fix: %s\n' "$1" >&2
  exit 1
}
step() { printf '  %s\n' "$1" >&2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H "Accept: ${3:-*/*}" "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --header="Accept: ${3:-*/*}" "$1" -O "$2"
  else
    fail "curl or wget is required"
  fi
}

sha512_base64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n'
  elif command -v sha512sum >/dev/null 2>&1 && command -v xxd >/dev/null 2>&1; then
    sha512sum "$1" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n'
  else
    fail "openssl, or sha512sum and xxd, is required to verify the download"
  fi
}

case "$(uname -s)" in
  Darwin) platform="mac" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); on Windows run: irm https://t3.codes/fix.ps1 | iex" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
# A shell under Rosetta reports x86_64 on Apple silicon.
if [ "$platform" = mac ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
  arch="arm64"
fi

newest_version() {
  if [ -n "${T3CODE_VERSION:-}" ]; then
    printf '%s\n' "$T3CODE_VERSION"
    return
  fi
  index="${work}/releases.json"
  found=
  if [ "$1" = stable ]; then
    # release.yml marks only plain stable releases latest.
    fetch "https://github.com/${repo}/releases/latest" "$index" application/json || fail "could not reach GitHub"
    found="$(sed -n 's/.*"tag_name": *"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$index" | head -n 1)"
  else
    page=1
    while [ -z "$found" ] && [ "$page" -le 10 ]; do
      fetch "https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}" "$index" || fail "could not reach GitHub"
      found="$(sed -n 's/.*"tag_name": *"v\([0-9][^"]*-nightly\.[0-9]*\.[0-9]*\)".*/\1/p' "$index" | head -n 1)"
      grep -q '"tag_name"' "$index" || break
      page=$((page + 1))
    done
  fi
  [ -n "$found" ] || fail "could not find a ${1} release"
  printf '%s\n' "$found"
}

channel_of() {
  case "$1" in
    *-nightly.* | *Nightly* | *nightly*) printf 'nightly\n' ;;
    *) printf 'stable\n' ;;
  esac
}

# Downloads a release asset into $work and checks it against electron-builder's update manifest.
download_asset() { # channel version asset
  manifest_prefix=latest
  [ "$1" = stable ] || manifest_prefix=nightly
  case "$platform-$arch" in
    mac-*) manifest="${manifest_prefix}-mac.yml" ;;
    linux-x64) manifest="${manifest_prefix}-linux.yml" ;;
    linux-arm64) manifest="${manifest_prefix}-linux-arm64.yml" ;;
  esac
  step "Downloading $3..."
  fetch "${base_url}/v${2}/${manifest}" "${work}/${manifest}" || fail "could not download ${manifest} for ${2}"
  fetch "${base_url}/v${2}/${3}" "${work}/${3}" || fail "could not download ${3}"
  expected="$(awk -v want="$3" '$1 == "-" && $2 == "url:" { url = $3 } $1 == "sha512:" && url == want { print $2; exit }' "${work}/${manifest}")"
  [ -n "$expected" ] || fail "${3} is not listed in ${manifest}"
  [ "$(sha512_base64 "${work}/${3}")" = "$expected" ] || fail "checksum mismatch for ${3}"
}

# Writes into $dir with sudo only when the user cannot.
as_owner_of() {
  dir="$1"
  shift
  if [ -w "$dir" ]; then "$@"; else sudo "$@"; fi
}

wait_for_exit() {
  n=0
  while [ "$n" -lt 20 ] && [ -n "$("$@")" ]; do
    sleep 0.5
    n=$((n + 1))
  done
}

can_launch() {
  [ "$(id -u)" != 0 ] && { [ "$platform" = mac ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; }
}

mac_app_name() {
  if [ "$1" = nightly ]; then printf 'T3 Code (Nightly)\n'; else printf 'T3 Code (Beta)\n'; fi
}

# pgrep takes a regex; app names contain parentheses.
mac_pids() { pgrep -f "$(printf '%s' "$1/Contents/" | sed 's/[][().*^$+?{}|\\]/\\&/g')" || true; }

fix_mac() { # channel app_path
  name="$(basename "$2" .app)"
  version="$(newest_version "$1")"
  asset="T3-Code-${version}-${arch}.zip"
  download_asset "$1" "$version" "$asset"
  step "Unpacking..."
  mkdir -p "${work}/unpacked"
  ditto -x -k "${work}/${asset}" "${work}/unpacked"
  [ -d "${work}/unpacked/${name}.app" ] || fail "${asset} does not contain ${name}.app"

  if [ -n "$(mac_pids "$2")" ]; then
    step "Quitting ${name}..."
    osascript -e "tell application \"${name}\" to quit" >/dev/null 2>&1 || true
    wait_for_exit mac_pids "$2"
    mac_pids "$2" | xargs kill 2>/dev/null || true
    wait_for_exit mac_pids "$2"
    mac_pids "$2" | xargs kill -9 2>/dev/null || true
  fi

  step "Installing ${name} ${version}..."
  parent="$(dirname "$2")"
  as_owner_of "$parent" mkdir -p "$parent"
  if [ -e "$2" ]; then
    as_owner_of "$parent" mv "$2" "${2}.old-$$"
  fi
  as_owner_of "$parent" ditto "${work}/unpacked/${name}.app" "$2"
  as_owner_of "$parent" rm -rf "${2}.old-$$"
  rm -rf "${work}/unpacked" "${work:?}/${asset}"

  if can_launch; then open "$2" || true; fi
  printf '  Reinstalled %s %s\n' "$name" "$version" >&2
}

appimage_pids() {
  for environ in /proc/[0-9]*/environ; do
    [ -O "$environ" ] || continue
    if tr '\0' '\n' 2>/dev/null < "$environ" | grep -qxF "APPIMAGE=$1"; then
      pid="${environ#/proc/}"
      printf '%s\n' "${pid%/environ}"
    fi
  done
}

stop_pids() { # description pid_lister args...
  description="$1"
  shift
  [ -n "$("$@")" ] || return 0
  step "Quitting ${description}..."
  "$@" | xargs kill 2>/dev/null || true
  wait_for_exit "$@"
  "$@" | xargs kill -9 2>/dev/null || true
}

fix_appimage() { # channel path
  version="$(newest_version "$1")"
  asset="T3-Code-${version}-$([ "$arch" = x64 ] && echo x86_64 || echo arm64).AppImage"
  download_asset "$1" "$version" "$asset"
  stop_pids "T3 Code" appimage_pids "$2"

  dir="$(dirname "$2")"
  # Keep the user's own filename; refresh ours so it names the version inside.
  case "$(basename "$2")" in
    T3-Code-*.AppImage) target="${dir}/${asset}" ;;
    *) target="$2" ;;
  esac
  step "Installing ${target}..."
  mkdir -p "$dir"
  chmod +x "${work}/${asset}"
  mv "${work}/${asset}" "${target}.part-$$"
  mv "${target}.part-$$" "$target"
  [ "$target" = "$2" ] || rm -f "$2"

  if can_launch; then nohup "$target" >/dev/null 2>&1 & fi
  printf '  Reinstalled T3 Code %s at %s\n' "$version" "$target" >&2
}

deb_pids() { pgrep -f "/opt/T3 Code" || true; }

fix_deb() { # channel
  version="$(newest_version "$1")"
  asset="T3-Code-${version}-$([ "$arch" = x64 ] && echo amd64 || echo arm64).deb"
  download_asset "$1" "$version" "$asset"
  stop_pids "T3 Code" deb_pids
  step "Installing ${asset} (needs sudo)..."
  chmod a+r "${work}/${asset}"
  chmod a+rx "$work"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y --allow-downgrades "${work}/${asset}"
  else
    sudo dpkg -i "${work}/${asset}"
  fi
  if can_launch && command -v t3code >/dev/null 2>&1; then nohup t3code >/dev/null 2>&1 & fi
  printf '  Reinstalled T3 Code %s\n' "$version" >&2
}

# The app records its AppImage path in a desktop entry each time it starts.
recorded_appimage() {
  entry="${XDG_DATA_HOME:-$HOME/.local/share}/applications/com.t3tools.T3Code.desktop"
  [ -f "$entry" ] || return 0
  path="$(sed -n 's/^Exec=\(.*\) %U$/\1/p' "$entry" | head -n 1)"
  path="${path#\"}"
  path="${path%\"}"
  case "$path" in *.AppImage) [ -f "$path" ] && printf '%s\n' "$path" ;; esac
  return 0
}

found_appimages() {
  recorded_appimage
  for dir in "$HOME/Applications" "$HOME/.local/bin" "$HOME/Downloads" "$HOME/Desktop" "$HOME/bin" /opt; do
    [ -d "$dir" ] || continue
    find "$dir" -maxdepth 1 -type f -name 'T3-Code-*.AppImage' 2>/dev/null
  done
}

# `curl | sh` puts this script on stdin, so questions go to the terminal; without one, take the default.
choose() { # question default choices...
  question="$1"
  default="$2"
  shift 2
  if ! (exec </dev/tty) 2>/dev/null; then
    printf '%s\n' "$default"
    return
  fi
  while :; do
    printf '  %s [%s] ' "$question" "$default" >/dev/tty
    read -r answer </dev/tty || answer=
    answer="${answer:-$default}"
    for choice in "$@"; do
      if [ "$answer" = "$choice" ]; then
        printf '%s\n' "$answer"
        return
      fi
    done
  done
}

# One line per installed desktop app: channel, kind, path.
list_installs() {
  if [ "$platform" = mac ]; then
    for channel in stable nightly; do
      name="$(mac_app_name "$channel")"
      for dir in /Applications "$HOME/Applications"; do
        [ ! -d "${dir}/${name}.app" ] || printf '%s\tmac\t%s\n' "$channel" "${dir}/${name}.app"
      done
    done
    return
  fi
  if command -v dpkg-query >/dev/null 2>&1 &&
    [ "$(dpkg-query -W -f='${Status}' t3code 2>/dev/null || true)" = "install ok installed" ]; then
    printf '%s\tdeb\t-\n' "$(channel_of "$(dpkg-query -W -f='${Version}' t3code)")"
  fi
  found_appimages | sort -u | while IFS= read -r path; do
    printf '%s\tappimage\t%s\n' "$(channel_of "$(basename "$path")")" "$path"
  done
}

fix_install() { # channel kind path
  case "$2" in
    mac) fix_mac "$1" "$3" ;;
    deb) fix_deb "$1" ;;
    appimage) fix_appimage "$1" "$3" ;;
  esac
}

fresh_install() { # channel
  if [ "$platform" = mac ]; then
    fix_mac "$1" "/Applications/$(mac_app_name "$1").app"
  else
    fix_appimage "$1" "$HOME/Applications/T3-Code-latest.AppImage"
  fi
}

main() {
  printf '\n  T3 Code fix: reinstalling the newest desktop app\n\n' >&2
  requested="${T3CODE_CHANNEL:-}"
  [ -n "$requested" ] || [ -z "${T3CODE_VERSION:-}" ] || requested="$(channel_of "$T3CODE_VERSION")"
  case "$requested" in
    "" | stable | nightly) ;;
    *) fail "T3CODE_CHANNEL must be stable or nightly" ;;
  esac
  if [ "$platform" = linux ] && command -v pacman >/dev/null 2>&1; then
    for package in t3code-bin t3code-nightly-bin; do
      if pacman -Q "$package" >/dev/null 2>&1; then
        fail "T3 Code is installed from the AUR package ${package}; update it with your AUR helper, for example: yay -S ${package}"
      fi
    done
  fi

  list_installs > "${work}/installs"
  channels="$(cut -f1 "${work}/installs" | sort -u | tr '\n' ' ')"
  if [ -z "$requested" ]; then
    case "$channels" in
      "") requested="$(choose "No T3 Code desktop app found. Install stable or nightly?" stable stable nightly)" ;;
      *nightly*stable* | *stable*nightly*)
        answer="$(choose "Both stable and nightly are installed. Reinstall stable, nightly, or both?" both stable nightly both)"
        [ "$answer" = both ] || requested="$answer"
        ;;
    esac
  fi

  fixed=0
  while IFS="$(printf '\t')" read -r channel kind path; do
    [ -z "$requested" ] || [ "$requested" = "$channel" ] || continue
    fix_install "$channel" "$kind" "$path" </dev/null
    fixed=$((fixed + 1))
  done < "${work}/installs"
  [ "$fixed" -gt 0 ] || fresh_install "${requested:-stable}"

  printf '\n  If T3 Code is still broken, run `npx t3@nightly unfuck` for a guided recovery, or share the logs in ~/.t3/userdata/logs on GitHub or Discord.\n\n' >&2
}

# Parse the whole script before running anything; `curl | sh` feeds it through stdin.
main
