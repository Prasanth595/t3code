import { SecretRequestError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
} from "./secretRequest.ts";

describe("secretRequestDisplay", () => {
  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Se așteaptă răspunsul în conversația originală",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe(
      "Stocat în siguranță, nu e arătat niciodată agentului",
    );
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Nu am putut răspunde la cerere. Încearcă din nou.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe(
      "Nu am putut răspunde la cerere. Încearcă din nou.",
    );
  });
});
