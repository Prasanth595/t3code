# Sourced by lib/t3fac.sh and by autodeploy.sh, which runs from the copy install.sh puts in
# ~/.local/share/t3fac with this file beside it in lib/.

# Takes lock $1, a symlink to this process's pid, so it is never seen half made. Takes over one
# whose holder has gone. Returns 1 when another live process has it, printing a line that names
# $2 and the holder.
take_lock() {
  local lock=$1 holder guard="$1.takeover" taken
  ln -s "$$" "$lock" 2> /dev/null && return 0
  holder=$(readlink "$lock" 2> /dev/null || true)
  if [[ -n $holder ]] && kill -0 "$holder" 2> /dev/null; then
    echo "another $2 is running (pid $holder)"
    return 1
  fi
  # A takeover reads the holder, removes the lock and links a new one. Two at once could each
  # remove the lock the other just linked, so a guard directory, which mkdir makes for one
  # process only, lets one through. A guard left by a takeover killed midway is cleared after a
  # minute.
  if ! mkdir "$guard" 2> /dev/null; then
    if [[ -n $(find "$guard" -maxdepth 0 -mmin +1 2> /dev/null) ]]; then rmdir "$guard" 2> /dev/null || true; fi
    if ! mkdir "$guard" 2> /dev/null; then
      echo "another $2 is running"
      return 1
    fi
  fi
  holder=$(readlink "$lock" 2> /dev/null || true)
  if [[ -n $holder ]] && kill -0 "$holder" 2> /dev/null; then
    rmdir "$guard"
    echo "another $2 is running (pid $holder)"
    return 1
  fi
  rm -f "$lock"
  taken=0
  ln -s "$$" "$lock" 2> /dev/null || taken=1
  rmdir "$guard"
  if ((taken != 0)); then
    echo "another $2 is running"
    return 1
  fi
}

# Removes lock $1 when this process holds it.
release_lock() {
  if [[ $(readlink "$1" 2> /dev/null || true) == "$$" ]]; then rm -f "$1"; fi
}
