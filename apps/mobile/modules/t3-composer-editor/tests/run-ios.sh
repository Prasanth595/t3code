#!/bin/bash
set -euo pipefail
module_dir=$(cd "$(dirname "$0")/.." && pwd)
sdk=$(xcrun --sdk macosx --show-sdk-path)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
compiler=$(xcrun --find swiftc)
flags=(-target "$(uname -m)-apple-ios16.1-macabi" -sdk "$sdk"
  -F "$sdk/System/iOSSupport/System/Library/Frameworks")
"$compiler" "${flags[@]}" -emit-library -emit-module -module-name ExpoModulesCore \
  "$module_dir/tests/ios/ExpoModulesCore.swift" \
  -emit-module-path "$output/ExpoModulesCore.swiftmodule" -o "$output/libExpoModulesCore.dylib"
"$compiler" "${flags[@]}" -I "$output" -L "$output" -lExpoModulesCore \
  -Xlinker -rpath -Xlinker "$output" \
  "${1:-$module_dir/ios/T3ComposerEditorView.swift}" "$module_dir/tests/ios/main.swift" \
  -o "$output/composer-tests"
"$output/composer-tests"
