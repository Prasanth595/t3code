#!/usr/bin/env bash
set -euo pipefail

# The same installer supports a checkout or a privately transferred rollout payload.
source_dir="${T3_TASK_CACHE_SOURCE_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [[ $# -gt 0 ]]; then
  node "$source_dir/install.mjs" "$1"
else
  node "$source_dir/install.mjs"
fi

mkdir -p "$HOME/.config/t3-task-cache"
cat > "$HOME/.config/t3-task-cache/env" <<'EOF'
case "$PATH" in
  "$HOME/.local/share/t3-task-cache/bin:"*) ;;
  *) export PATH="$HOME/.local/share/t3-task-cache/bin:$PATH" ;;
esac
EOF

line='. "$HOME/.config/t3-task-cache/env"'
for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshenv" "$HOME/.zshrc"; do
  # Do not create a bash_profile: doing so would shadow an existing .profile.
  if [[ ! -f "$profile" && "$profile" == "$HOME/.bash_profile" ]]; then
    continue
  fi
  if ! grep -Fqx "$line" "$profile" 2>/dev/null; then
    printf '\n%s\n' "$line" >> "$profile"
  fi
done

. "$HOME/.config/t3-task-cache/env"
printf 'Installed task-cache launcher for %s\n' "$(cat "$HOME/.agents/MACHINE" 2>/dev/null || hostname)"
command -v vp
