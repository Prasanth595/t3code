import { withEnvironmentNickname } from "@t3tools/client-runtime/state/environment-label";
import {
  BearerConnectionTarget,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "../connection/desktopLocal";
import { projectEnvironmentPresentation } from "./environments";

const environmentId = EnvironmentId.make("environment-wsl");

const base: BaseEnvironmentPresentation = {
  entry: {
    target: new BearerConnectionTarget({
      connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
      environmentId,
      label: "SwerveStation",
    }),
    profile: Option.none(),
    enabled: true,
  },
  connection: { phase: "available", error: null, traceId: null },
  serverConfig: null,
};

describe("projectEnvironmentPresentation nicknames", () => {
  it("shows the server-reported name without a nickname", () => {
    const presentation = projectEnvironmentPresentation(environmentId, base, {});
    expect(presentation).toMatchObject({
      label: "SwerveStation",
      serverLabel: "SwerveStation",
      nickname: null,
      wsl: true,
      platformOs: null,
    });
  });

  it("replaces the label with this device's nickname, and clearing restores the server name", () => {
    const nicknames = withEnvironmentNickname({}, environmentId, "Ubuntu box");
    expect(projectEnvironmentPresentation(environmentId, base, nicknames)).toMatchObject({
      label: "Ubuntu box",
      serverLabel: "SwerveStation",
      nickname: "Ubuntu box",
    });

    const cleared = withEnvironmentNickname(nicknames, environmentId, null);
    expect(projectEnvironmentPresentation(environmentId, base, cleared).label).toBe(
      "SwerveStation",
    );
  });

  it("ignores nicknames saved for other environments", () => {
    const nicknames = { [EnvironmentId.make("other")]: "Laptop" };
    expect(projectEnvironmentPresentation(environmentId, base, nicknames).label).toBe(
      "SwerveStation",
    );
  });
});
