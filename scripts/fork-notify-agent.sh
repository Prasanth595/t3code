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
# agent, when the notify job of that failure succeeded: the agent that it started
# watches the next run and reports it. A notify job that failed reached no agent.
# Limit: a skip also ends the job with success, so a chain of failures stays quiet
# after one delivered call. Pull request runs never notify, so they do not count.
previous="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$GITHUB_WORKFLOW" --status completed --limit 20 \
  --json databaseId,conclusion,event --jq "[.[] | select(.databaseId != ${GITHUB_RUN_ID} and .event != \"pull_request\")
    | select(.conclusion != \"cancelled\" and .conclusion != \"skipped\")][0] // empty | \"\\(.databaseId) \\(.conclusion)\"")"
if [[ "${previous#* }" == "failure" ]]; then
  notified="$(gh run view "${previous%% *}" --repo "$GITHUB_REPOSITORY" --json jobs \
    --jq '[.jobs[] | select(.name == "Notify repair agent")][0].conclusion // empty')"
  if [[ "$notified" == "success" ]]; then
    echo "The previous ${GITHUB_WORKFLOW} run failed too, and its call succeeded. No new agent is notified."
    exit 0
  fi
  echo "The previous ${GITHUB_WORKFLOW} run failed too, but its notify job ended with '${notified:-none}'. Notifying."
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
# The webhook server can restart, which takes minutes. So retry once a minute for 15 minutes.
# The notify jobs have timeout-minutes: 20 to cover the last attempt (up to 120 s).
curl --fail-with-body --silent --show-error \
  --retry 15 --retry-delay 60 --retry-max-time 900 --max-time 120 --retry-all-errors \
  -X POST "$WEBHOOK_URL" \
  -H "content-type: application/json" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  --data-binary "$payload"
