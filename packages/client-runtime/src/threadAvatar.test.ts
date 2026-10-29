import { describe, expect, it } from "vite-plus/test";

import { threadAvatar } from "./threadAvatar.ts";

describe("threadAvatar", () => {
  it("keeps colors stable per seed even when the title changes", () => {
    const before = threadAvatar("thread-1", "Plan lansare");
    const after = threadAvatar("thread-1", "Buget");
    expect(after.from).toBe(before.from);
    expect(after.to).toBe(before.to);
    expect(after.initial).toBe("B");
  });

  it("uppercases Romanian initials and falls back for symbols or empty titles", () => {
    expect(threadAvatar("a", "  ștergere").initial).toBe("Ș");
    expect(threadAvatar("a", "").initial).toBe("•");
    expect(threadAvatar("a", "🚀 lansare").initial).toBe("•");
  });
});
