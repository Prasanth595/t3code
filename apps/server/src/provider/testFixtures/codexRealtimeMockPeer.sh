#!/usr/bin/env bash
# The provider always passes "app-server" first; drop it and run the mock peer on the rest.
shift
exec node "$(dirname "$0")/codexRealtimeMockPeer.mjs" "$@"
