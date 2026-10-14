/**
 * Shown in place of success when a checkout is kept where it was rather than on the pull
 * request's head, by both the pull request panel and the branch picker's checkout dialog.
 */
export const OFF_HEAD_PULL_REQUEST_CHECKOUT_TOAST = {
  type: "warning",
  title: "Checked out, but not on the pull request's commit",
  description:
    "The checkout is not on the pull request's latest commit, so the code there differs from the pull request. Uncommitted work or local commits keep it where it is.",
} as const;
