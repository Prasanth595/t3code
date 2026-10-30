import { describe, expect, it } from "vite-plus/test";

import { openCodeClient } from "./client.ts";

describe("OpenCode client setup", () => {
  it("exposes the NVIDIA Build key as a sensitive per-instance environment field", () => {
    const fields = openCodeClient.environmentFields.filter(
      (field) => field.name === "NVIDIA_API_KEY",
    );

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      label: "NVIDIA Build API key",
      sensitive: true,
    });
  });
});
