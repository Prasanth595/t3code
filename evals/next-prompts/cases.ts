import type { ThreadTitleMessage } from "@t3tools/provider-core/server/threadTitleContext";

interface NextPromptsCase {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly messages: ReadonlyArray<ThreadTitleMessage>;
  readonly failed: boolean;
  readonly failureMessage?: string;
  readonly rubric: string;
}

export const nextPromptsEvaluationCases: ReadonlyArray<NextPromptsCase> = [
  {
    id: "finished-untested",
    source: "https://github.com/pingdotgg/t3code/pull/27095",
    title: "Migrate users table to v4",
    messages: [
      { role: "user", text: "Migrate the users table to the v4 schema in db/migrations." },
      {
        role: "assistant",
        text: "Added db/migrations/0042_users_v4.sql and updated UserRepository. I did not run the test suite.",
      },
    ],
    failed: false,
    rubric:
      "The first prompt asks to run or fix the tests for this migration. No prompt asks to write the migration again.",
  },
  {
    id: "failed-with-error",
    source: "https://github.com/pingdotgg/t3code/pull/27095",
    title: "Migrate users table to v4",
    messages: [
      { role: "user", text: "Apply the users v4 migration to the dev database." },
      { role: "assistant", text: "Running the migration now." },
    ],
    failed: true,
    failureMessage: "relation users_v2 already exists",
    rubric:
      "The first prompt deals with the users_v2 relation that already exists, such as checking for it or making the migration skip it.",
  },
  {
    id: "failed-before-reply",
    source: "https://github.com/pingdotgg/t3code/pull/27095",
    title: "Fix flaky checkout test",
    messages: [{ role: "user", text: "Fix the flaky checkout total test in cart.test.ts." }],
    failed: true,
    failureMessage: "Provider process exited before the turn started: ENOENT pnpm",
    rubric:
      "The first prompt responds to the missing pnpm failure, for example by retrying with the repo's package manager. It still names the checkout test.",
  },
  {
    id: "finished-pr-open",
    source: "https://github.com/pingdotgg/t3code/pull/27095",
    title: "Stripe webhook retries",
    messages: [
      { role: "user", text: "Retry failed Stripe webhooks with backoff, then open a PR." },
      {
        role: "assistant",
        text: "Added exponential backoff in webhooks/retry.ts with tests, and opened PR #412. CI is green.",
      },
    ],
    failed: false,
    rubric:
      "Control: the work is done. Prompts suggest a next step such as watching review or merging PR #412, not rebuilding the retry logic.",
  },
];
