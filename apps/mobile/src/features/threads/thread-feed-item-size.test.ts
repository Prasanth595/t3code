import { expect, it } from "vite-plus/test";

import { THREAD_WORK_ROW_MIN_HEIGHT } from "../../lib/layout";
import { resolveThreadFeedFixedItemSize } from "./thread-feed-item-size";

it("measures wrapping turn folds while keeping single-line work toggles fixed", () => {
  expect(resolveThreadFeedFixedItemSize("run-fold")).toBeUndefined();
  expect(resolveThreadFeedFixedItemSize("work-toggle")).toBe(THREAD_WORK_ROW_MIN_HEIGHT);
  expect(resolveThreadFeedFixedItemSize("activity-group")).toBeUndefined();
  expect(resolveThreadFeedFixedItemSize("message")).toBeUndefined();
});
