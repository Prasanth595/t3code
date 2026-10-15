import { assert, it } from "@effect/vitest";

import { APPROVAL_QUERY, isUtcSecond } from "./approvalHistory.ts";

it("the approval query asks for label events and the edit history", () => {
  for (const part of [
    "timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT], last: 100)",
    "totalCount",
    "... on LabeledEvent { createdAt actor { __typename login } label { name } }",
    "... on UnlabeledEvent { createdAt actor { __typename login } label { name } }",
    "... on RenamedTitleEvent { createdAt actor { __typename login } }",
    "lastEditedAt",
    "editor { __typename login }",
    "userContentEdits(first: 100) { totalCount nodes { editedAt editor { __typename login } } }",
    "$owner",
    "$name",
    "$number",
  ]) {
    assert.include(APPROVAL_QUERY, part);
  }
  assert.notInclude(APPROVAL_QUERY, "comments");
  // Titles are attacker-influenced text and are never asked for.
  assert.notInclude(APPROVAL_QUERY, "Title {");
  assert.notInclude(APPROVAL_QUERY, "currentTitle");
  assert.notInclude(APPROVAL_QUERY, "previousTitle");
});

it("the approval query is softfac's, byte for byte", () => {
  assert.strictEqual(
    APPROVAL_QUERY,
    "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT], last: 100) { totalCount nodes { __typename ... on LabeledEvent { createdAt actor { __typename login } label { name } } ... on UnlabeledEvent { createdAt actor { __typename login } label { name } } ... on RenamedTitleEvent { createdAt actor { __typename login } } } } lastEditedAt editor { __typename login } userContentEdits(first: 100) { totalCount nodes { editedAt editor { __typename login } } } } } }",
  );
});

it("a UTC second is exactly YYYY-MM-DDTHH:MM:SSZ", () => {
  assert.isTrue(isUtcSecond("2026-10-04T10:00:00Z"));
  for (const text of [
    "",
    "2026-10-04 10:00:00Z",
    "2026-10-04T10:00:00",
    "2026-10-04T10:00:00.5Z",
    "2026-10-04T10:00:00+10:00",
    " 2026-10-04T10:00:00Z",
    "2026-10-04T10:00:00Z\n",
    "2026-1a-04T10:00:00Z",
  ]) {
    assert.isFalse(isUtcSecond(text), JSON.stringify(text));
  }
});
