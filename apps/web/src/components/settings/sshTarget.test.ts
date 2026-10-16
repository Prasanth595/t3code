import { describe, expect, it } from "vite-plus/test";
import { redactSshText } from "./sshTarget";

describe("SSH display redaction", () => {
  it.each([
    ["devbox", "devbox"],
    ["buildbox:2222", "buildbox:2222"],
    ["deploy@devbox", "•••@devbox"],
    ["deploy@buildbox:2222", "•••@buildbox:2222"],
    ["deploy@host.example.com", "•••@•••"],
    ["host.tail1234.ts.net", "•••"],
    ["203.0.113.42", "•••"],
    ["deploy@[2001:db8::1]:2222", "•••@[•••]:2222"],
  ])("redacts only sensitive parts of %s", (value, expected) => {
    expect(redactSshText(value)).toBe(expected);
  });

  it.each([
    ["deploy@actual.example.com: Permission denied", "•••@devbox: Permission denied"],
    ["deploy@buildbox: Permission denied", "•••@buildbox: Permission denied"],
    [
      "Could not resolve hostname actual.example.com: Name not known",
      "Could not resolve hostname devbox: Name not known",
    ],
    ["Connection to box.tail1234.ts.net port 22 closed", "Connection to devbox port 22 closed"],
    ["node.js exited at 12:34:56 with std::vector", "node.js exited at 12:34:56 with std::vector"],
    [
      "Warning: Permanently added 'actual.example.com' (ED25519) to the list of known hosts.",
      "Warning: Permanently added 'devbox' (ED25519) to the list of known hosts.",
    ],
    [
      "Warning: the ED25519 host key for 'actual.example.com' differs from the key for the IP address '203.0.113.42'",
      "Warning: the ED25519 host key for 'devbox' differs from the key for the IP address '•••'",
    ],
  ])("redacts resolved SSH details in %s", (message, expected) => {
    expect(redactSshText(message, "devbox")).toBe(expected);
  });

  it("uses the connection destination to redact passive error text", () => {
    expect(redactSshText("deploy@devbox: Permission denied", "deploy@devbox")).toBe(
      "•••@devbox: Permission denied",
    );
  });
});
