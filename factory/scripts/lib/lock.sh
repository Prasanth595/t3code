# Sourced by lib/t3fac.sh and by autodeploy.sh, which runs from the copy install.sh puts in
# ~/.local/share/t3fac with this file beside it in lib/.

# Takes lock $1, a symlink to this process's pid, so it is never seen half made. Takes over one
# whose holder has gone. Returns 1 when another live process has it, printing a line that names
# $2 and the holder.
take_lock() {
  local lock=$1 holder aside="$1.$$"
  ln -s "$$" "$lock" 2> /dev/null && return 0
  holder=$(readlink "$lock" 2> /dev/null || true)
  if [[ -n $holder ]] && kill -0 "$holder" 2> /dev/null; then
    echo "another $2 is running (pid $holder)"
    return 1
  fi
  # Two processes can find the same dead holder. Deleting the lock could then delete the one the
  # other has just taken, so rename it aside (only one rename gets it) and put back a lock that
  # is not the dead holder's.
  if mv "$lock" "$aside" 2> /dev/null; then
    if [[ $(readlink "$aside" 2> /dev/null || true) != "$holder" ]]; then
      mv -n "$aside" "$lock" 2> /dev/null || true
    fi
    rm -f "$aside"
  fi
  if ! ln -s "$$" "$lock" 2> /dev/null; then
    echo "another $2 is running"
    return 1
  fi
}

# Removes lock $1 when this process holds it.
release_lock() {
  if [[ $(readlink "$1" 2> /dev/null || true) == "$$" ]]; then rm -f "$1"; fi
}
