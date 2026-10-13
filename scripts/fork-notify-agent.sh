#!/usr/bin/env bash
# Posts a failed fork workflow run to the repair agent webhook (a T3 scheduled task).
# Called by the notify_agent job of fork-ci.yml, fork-release.yml and fork-sync.yml. See docs/fork.md.
# Env: WEBHOOK_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, GH_TOKEN, NEEDS_JSON
# (the workflow's toJSON(needs)), plus the default GITHUB_* variables.
set -euo pipefail

if [[ -z "${WEBHOOK_URL:-}" ]]; then
  echo "T3_AGENT_WEBHOOK_URL is not set. No agent is notified."
  exit 0
fi

# A repair agent's push to main starts new runs that cannot pass notify_agent=false.
# So a failure right after a failure of the same workflow does not start another
# agent: the agent that the first failure started watches the next run and reports it.
previous="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$GITHUB_WORKFLOW" --status completed --limit 5 \
  --json databaseId,conclusion --jq "[.[] | select(.databaseId != ${GITHUB_RUN_ID}) | select(.conclusion != \"cancelled\" and .conclusion != \"skipped\")][0].conclusion // empty")"
if [[ "$previous" == "failure" ]]; then
  echo "The previous ${GITHUB_WORKFLOW} run failed too. No new agent is notified."
  exit 0
fi

payload="$(jq -n \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg branch "$GITHUB_REF_NAME" \
  --arg event "$GITHUB_EVENT_NAME" \
  --arg workflow "$GITHUB_WORKFLOW" \
  --arg run_url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
  --arg run_id "$GITHUB_RUN_ID" \
  --argjson needs "$NEEDS_JSON" \
  '{repository: $repository, branch: $branch, event: $event, workflow: $workflow,
    run_url: $run_url, run_id: $run_id, jobs: ($needs | map_values(.result))}')"
echo "$payload"
curl --fail-with-body --silent --show-error --retry 3 --retry-all-errors \
  -X POST "$WEBHOOK_URL" \
  -H "content-type: application/json" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  --data-binary "$payload"
