#!/bin/bash
set -euo pipefail
mobile_dir=$(cd "$(dirname "$0")/../.." && pwd)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
xcrun clang -fobjc-arc -framework Foundation -framework AppKit \
  -I "$mobile_dir/node_modules/react-native-enriched-markdown/ios/utils" \
  "$mobile_dir/scripts/tests/markdown-direction.m" -o "$output/direction-tests"
"$output/direction-tests"
