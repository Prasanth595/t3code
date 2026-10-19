import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { continuationProject, continuationPrompt } from "./threadContinuation.ts";

const pc = EnvironmentId.make("pc");
const vps = EnvironmentId.make("vps");
const laptop = EnvironmentId.make("laptop");

const project = (
  environmentId: EnvironmentId,
  title: string,
  canonicalKey: string | null,
  isScratch?: true,
) => ({
  environmentId,
  title,
  repositoryIdentity:
    canonicalKey === null
      ? null
      : {
          canonicalKey,
          locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: canonicalKey },
        },
  ...(isScratch ? { isScratch } : {}),
});

describe("continuationProject", () => {
  const projects = [
    project(pc, "t3code", "github.com/tomcohendev/t3code"),
    project(vps, "scratch", null, true),
    project(vps, "notes", null),
    project(vps, "t3", "github.com/tomcohendev/t3code"),
    project(laptop, "t3code", "github.com/tomcohendev/t3code"),
  ];

  it("picks the same repository on a reachable machine other than the source", () => {
    expect(
      continuationProject({
        sourceEnvironmentId: pc,
        repositoryKey: "github.com/tomcohendev/t3code",
        projectTitle: "t3code",
        projects,
        reachableEnvironmentIds: new Set([pc, vps]),
      }),
    ).toBe(projects[3]);
  });

  it("falls back to the same title, and never to a scratch project", () => {
    expect(
      continuationProject({
        sourceEnvironmentId: pc,
        repositoryKey: null,
        projectTitle: "notes",
        projects,
        reachableEnvironmentIds: new Set([vps]),
      }),
    ).toBe(projects[2]);
    expect(
      continuationProject({
        sourceEnvironmentId: pc,
        repositoryKey: null,
        projectTitle: "scratch",
        projects,
        reachableEnvironmentIds: new Set([vps]),
      }),
    ).toBeNull();
  });

  it("finds nothing while only the source machine is reachable", () => {
    expect(
      continuationProject({
        sourceEnvironmentId: pc,
        repositoryKey: "github.com/tomcohendev/t3code",
        projectTitle: "t3code",
        projects,
        reachableEnvironmentIds: new Set([pc]),
      }),
    ).toBeNull();
  });
});

describe("continuationPrompt", () => {
  it("names the source, the branch and what the attachment leaves out", () => {
    const prompt = continuationPrompt({
      title: "Fix login",
      sourceLabel: "Tom's PC",
      branch: "fix/login",
      omittedItems: 3,
    });
    expect(prompt).toContain('"Fix login" from Tom\'s PC');
    expect(prompt).toContain("`fix/login`");
    expect(prompt).toContain("3 older items are not included");
  });
});
