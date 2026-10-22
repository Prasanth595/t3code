Synthetic projection fixture for sidebar navigation evidence. No provider starts,
event history, copied user data, or auth values are included. `plain.json` is the
plain generated fixture; regenerate it with:

```sh
python3 scripts/fixtures/issue-16534/seed.py --output /tmp/sidebar-seed
```

Use `--variant` for spacers (40 additional stopped threads), pinned, snoozed,
settled (16 settled A threads, beyond the ten-row tail), lineage, archived, or
orphan. Add `--legacy` to select the legacy sidebar. Generated timestamps and
hashes are deterministic. JSON payloads use OrchestrationV2AppThreadJson.

Only after the isolated server owner stops it, apply the generated files in
order: reset-threads.sql, hide-unrelated-projects.sql, projects.sql, threads.sql.
Use `node apps/server/scripts/t3-sqlite-state.ts exec --base-dir <isolated-home>
--file <file>`, once per file. The helper backs up each mutation. Never use the
live home. Restart through the owner. These writes intentionally do not create
event history and cannot prove backend behavior.

Client settings and UI reset inputs are in fixture.json. Environment-scoped keys,
project order, initial route/history, shelf/list expansion, search, scroll offsets,
and keyboard bindings must be measured and recorded for each scenario before
capture. The generated empty scoped-key maps are starting inputs, not a claim
that all matrix scenarios are initialized. UI interactions establish those states.

Working/status/grouping and delayed protocol replay variants are not implemented
here. Record those segments as blocked until valid fixtures exist. `bootstrap.js`
is a proposed capture-tab document reboot for pre-module clock/storage setup;
validate it in the real app before accepting any frozen-clock evidence. It does
not change the served source or any timer API. Server clock is not frozen.
