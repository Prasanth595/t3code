#!/bin/sh
set -eu
MODULE_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t3-watch-tests.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT
xcrun swiftc "$MODULE_ROOT"/ios/Shared/*.swift "$MODULE_ROOT/tests/NativeStoreTests.swift" -o "$BUILD_DIR/native-tests"
"$BUILD_DIR/native-tests"
for SOURCE in "$MODULE_ROOT"/ios/*.swift "$MODULE_ROOT"/../../watch/*.swift; do
  xcrun swiftc -frontend -parse "$SOURCE"
done
