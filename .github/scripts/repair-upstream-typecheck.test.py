import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(os.environ.get(
    "REPAIR_SCRIPT", Path(__file__).with_name("repair-upstream-typecheck.sh")
)).resolve()


class RepairUpstreamTypecheckTests(unittest.TestCase):
    def run_repair(self, fix_on=2, codex_exit=0, conflict=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            repo.mkdir()
            tools = root / "bin"
            tools.mkdir()
            temp = root / "temp"
            temp.mkdir()
            env = dict(os.environ, PATH=f"{tools}:{os.environ['PATH']}",
                       HOME=str(root), RUNNER_TEMP=str(temp), MODEL="fixture",
                       PROMPT="Repair typecheck", CODEX_AUTH_JSON="{}",
                       FIX_ON=str(fix_on), CODEX_EXIT=str(codex_exit),
                       CONFLICT="1" if conflict else "0")

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=repo, env=env, text=True)

            git("init", "-q")
            git("config", "user.email", "test@example.com")
            git("config", "user.name", "Test")
            (repo / "source.ts").write_text("broken\n")
            git("add", ".")
            git("commit", "-qm", "fixture")
            before = git("rev-parse", "HEAD")
            (temp / "sync-upstream-typecheck.log").write_text("original error TS2345\n")
            fixtures = {
                "timeout": '#!/bin/bash\nshift\nexec "$@"\n',
                "npx": '''#!/bin/bash
set -eu
count_file="$RUNNER_TEMP/attempts"
count=0
if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
count=$((count + 1))
echo "$count" > "$count_file"
if [ "$count" -gt 1 ] && ! grep -q '^fixed' source.ts; then
  grep -q 'fresh error TS2345' "$RUNNER_TEMP/sync-upstream-typecheck.log"
fi
if [ "$count" -ge "$FIX_ON" ]; then
  echo fixed > source.ts
  echo helper > helper.ts
  if [ "$CONFLICT" = 1 ]; then echo '<<<<<<< unresolved' >> source.ts; fi
fi
# Like the failed run, an unfinished agent can exit zero.
exit "$CODEX_EXIT"
''',
                "vpr": '''#!/bin/bash
if grep -q '^fixed' source.ts; then exit 0; fi
echo 'fresh error TS2345'
exit 2
''',
            }
            for name, source in fixtures.items():
                path = tools / name
                path.write_text(source)
                path.chmod(0o755)
            result = subprocess.run(["bash", "-eo", "pipefail", str(SCRIPT)],
                                    cwd=repo, env=env, text=True, capture_output=True, timeout=10)
            attempts = int((temp / "attempts").read_text())
            self.assertEqual(git("rev-parse", "HEAD"), before)
            return result, attempts, git("diff", "--cached", "--name-only")

    def test_retries_successful_codex_exit_when_typecheck_still_fails(self):
        result, attempts, staged = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(attempts, 2)
        self.assertEqual(set(staged.splitlines()), {"source.ts", "helper.ts"})

    def test_exhaustion_fails_without_staging(self):
        result, attempts, staged = self.run_repair(fix_on=99)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(attempts, 3)
        self.assertEqual(staged, "")

    def test_retries_codex_process_failure(self):
        result, attempts, _ = self.run_repair(codex_exit=1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(attempts, 2)

    def test_retries_timed_out_codex(self):
        result, attempts, _ = self.run_repair(codex_exit=124)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(attempts, 2)

    def test_stops_after_first_verified_repair(self):
        result, attempts, _ = self.run_repair(fix_on=1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(attempts, 1)

    def test_conflict_markers_block_success_even_when_typecheck_passes(self):
        result, _, staged = self.run_repair(fix_on=1, conflict=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(staged, "")


if __name__ == "__main__":
    unittest.main()
