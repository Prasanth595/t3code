#!/bin/bash
set -euo pipefail
mobile_dir=$(cd "$(dirname "$0")/../.." && pwd)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
cat > "$output/tests.gradle" <<'GRADLE'
gradle.projectsEvaluated {
  def renderer = gradle.rootProject.findProject(':react-native-enriched-markdown')
  if (renderer == null) return
  renderer.android.sourceSets.test.java.srcDir(new File(gradle.rootProject.projectDir, '../scripts/tests'))
}
GRADLE
cd "$mobile_dir/android"
./gradlew :react-native-enriched-markdown:testDebugUnitTest \
  --tests '*MarkdownDirectionTest' --init-script "$output/tests.gradle" --max-workers=2
