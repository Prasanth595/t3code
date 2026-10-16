#!/usr/bin/env bash
# Asks the factory to stop a building run: stop-run.sh <run id>
#
# Checks that the run exists and is building, then leaves a request for it in
# `$T3FAC_DATA/stop-requests/<run id>` (default data dir: ~/.config/t3fac/factory). The next pass
# takes the request into the run's ledger, archives the session and sends the issue to
# `factory:stuck` as stopped by hand. This script never writes the ledger and never prints it.
# Exits 1 with the reason on stderr when the run cannot be stopped this way.
set -euo pipefail

data=${T3FAC_DATA:-$HOME/.config/t3fac/factory}

if [[ $# -ne 1 || -z $1 ]]; then
  echo "usage: stop-run.sh <run id>" >&2
  exit 1
fi
id=$1

# A run id is one file name: it never names a path.
if [[ $id == */* ]]; then
  echo "invalid run id $id: it names a path" >&2
  exit 1
fi

ledger=$data/runs/$id.jsonl
if [[ ! -f $ledger ]]; then
  echo "run $id has no ledger under $data" >&2
  exit 1
fi

not_building() {
  echo "run $id is not building: $1. Only a building run is stopped this way; to end one in another state, close its issue." >&2
  exit 1
}

# A line's event name sits in the file's own quoting, so no text inside a line can spell it.
if grep -q '"event":"finished"' "$ledger"; then
  not_building "it is finished"
fi

state=$({ grep '"event":"state_changed"' "$ledger" || true; } |
  tail -n 1 |
  sed -n 's/.*"data":{"from":"[^"]*","to":"\([^"]*\)"}.*/\1/p')
case $state in
  building) ;;
  "") not_building "it has no state yet" ;;
  *) not_building "its state is $state" ;;
esac

mkdir -p "$data/stop-requests"
printf 'operator\n' >"$data/stop-requests/$id"
echo "stop requested: $id; the issue goes to factory:stuck on the next pass"
