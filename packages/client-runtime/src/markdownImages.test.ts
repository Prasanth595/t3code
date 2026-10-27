import { describe, expect, it } from "vite-plus/test";

import { classifyMarkdownImageSource } from "./markdownImages.js";

describe("classifyMarkdownImageSource", () => {
  it.each([
    ["images/result.png", "/workspace/project", "/workspace/project/images/result.png"],
    [
      "images\\result.png",
      "C:\\Users\\dara\\project",
      "C:\\Users\\dara\\project\\images\\result.png",
    ],
    ["file:///workspace/project/image%20one.png", null, "/workspace/project/image one.png"],
    ["file://server/share/image.png", "\\\\server\\share", "\\\\server\\share\\image.png"],
    [
      "/home/me/.grok/sessions/%2Fhome%2Fme%2Fpet.projects%2Fapp/01a16f63-11b2-7911-89e6-d5f9a29acb90/images/1.jpg",
      null,
      "/home/me/.grok/sessions/%2Fhome%2Fme%2Fpet.projects%2Fapp/01a16f63-11b2-7911-89e6-d5f9a29acb90/images/1.jpg",
    ],
    [
      "file:///home/me/.grok/sessions/%2Fhome%2Fme%2FMy%20App/id/images/shot%20one.jpg",
      null,
      "/home/me/.grok/sessions/%2Fhome%2Fme%2FMy%20App/id/images/shot one.jpg",
    ],
    [
      "/opt/grok-data/sessions/%2Fhome%2Fme%2Fproj/id/images/1.jpg",
      null,
      "/opt/grok-data/sessions/%2Fhome%2Fme%2Fproj/id/images/1.jpg",
    ],
    [
      "/home/me/.grok/sessions/plain-project/images/shot%20one.jpg",
      null,
      "/home/me/.grok/sessions/plain-project/images/shot one.jpg",
    ],
    [
      "/home/me/project/sessions/a%2Fb/report.png",
      null,
      "/home/me/project/sessions/a/b/report.png",
    ],
  ])("maps %s to a workspace file", (source, workspaceRoot, path) => {
    expect(classifyMarkdownImageSource(source, workspaceRoot)).toEqual({
      _tag: "WorkspaceFile",
      path,
    });
  });

  it.each(["image.png", "javascript:alert(1)", "file://%"])(
    "blocks unsupported or unresolved source %s",
    (source) => {
      expect(classifyMarkdownImageSource(source)).toEqual({ _tag: "Blocked" });
    },
  );

  // Loading these makes Windows send the user's NTLM credentials to the named host.
  it.each([
    "file://attacker.test/share/cat.jpg",
    "\\\\attacker.test\\share\\cat.jpg",
    "/\\attacker.test\\share\\cat.jpg",
    "file:/%5Cattacker.test%5Cshare%5Ccat.jpg",
    "\\\\server\\other\\cat.jpg",
  ])("blocks network path %s outside the project", (source) => {
    expect(classifyMarkdownImageSource(source, "\\\\server\\share\\project")).toEqual({
      _tag: "Blocked",
    });
  });
});
