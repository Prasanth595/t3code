import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ProjectSettingsOverrides } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadProjectRef } from "./projectGrouping.ts";

const mac = { environmentId: EnvironmentId.make("mac"), id: ProjectId.make("mac-project") };
const pad = { environmentId: EnvironmentId.make("pad"), id: ProjectId.make("pad-project") };
const macRef = { environmentId: mac.environmentId, projectId: mac.id };
const padRef = { environmentId: pad.environmentId, projectId: pad.id };
const connectedEnvironmentIds = new Set([mac.environmentId, pad.environmentId]);

function settings(
  macOverride: ProjectSettingsOverrides = {},
  padOverride: ProjectSettingsOverrides = {},
) {
  return new Map([
    [mac.environmentId, { projectSettingsOverrides: { [mac.id]: macOverride } }],
    [pad.environmentId, { projectSettingsOverrides: { [pad.id]: padOverride } }],
  ]);
}

const input = {
  members: [mac, pad],
  settingsByEnvironment: settings({ defaultEnvironmentId: pad.environmentId }),
  connectedEnvironmentIds,
  contextProjectRef: macRef,
  primaryEnvironmentId: mac.environmentId,
};

describe("new thread project environment", () => {
  it("uses the connected project default ahead of the active thread and primary environment", () => {
    expect(resolveNewThreadProjectRef(input)).toEqual({
      projectRef: padRef,
      environmentSelection: "project-default",
    });
  });

  it("keeps an explicit environment or checkout ahead of the project default", () => {
    expect(resolveNewThreadProjectRef({ ...input, manualProjectRef: macRef })).toEqual({
      projectRef: macRef,
      environmentSelection: "manual",
    });
  });

  it("allows automatic routing when the default is disconnected", () => {
    expect(
      resolveNewThreadProjectRef({
        ...input,
        connectedEnvironmentIds: new Set([mac.environmentId]),
      }),
    ).toEqual({
      projectRef: macRef,
      environmentSelection: "auto",
    });
  });

  it("allows automatic routing when the default has no project copy", () => {
    expect(resolveNewThreadProjectRef({ ...input, members: [mac] })).toEqual({
      projectRef: macRef,
      environmentSelection: "auto",
    });
  });

  it.each([{}, { defaultEnvironmentId: null }])(
    "preserves today's context fallback for Automatic %j",
    (override) => {
      expect(
        resolveNewThreadProjectRef({
          ...input,
          settingsByEnvironment: settings(override),
          contextProjectRef: padRef,
        }),
      ).toEqual({
        projectRef: padRef,
        environmentSelection: "auto",
      });
    },
  );

  it("falls back to the context machine for another project, then primary, then first member", () => {
    const automatic = { ...input, settingsByEnvironment: settings() };
    expect(
      resolveNewThreadProjectRef({
        ...automatic,
        contextProjectRef: { ...padRef, projectId: ProjectId.make("other") },
      }).projectRef,
    ).toEqual(padRef);
    expect(
      resolveNewThreadProjectRef({
        ...automatic,
        contextProjectRef: null,
        primaryEnvironmentId: pad.environmentId,
      }).projectRef,
    ).toEqual(padRef);
    expect(
      resolveNewThreadProjectRef({
        ...automatic,
        contextProjectRef: null,
        primaryEnvironmentId: null,
      }).projectRef,
    ).toEqual(macRef);
  });

  it("resolves disagreeing copies by the first explicit setting in environment/project key order", () => {
    const mixed = settings(
      { defaultEnvironmentId: mac.environmentId },
      { defaultEnvironmentId: pad.environmentId },
    );
    expect(
      resolveNewThreadProjectRef({ ...input, settingsByEnvironment: mixed }).projectRef,
    ).toEqual(macRef);
    expect(
      resolveNewThreadProjectRef({ ...input, members: [pad, mac], settingsByEnvironment: mixed })
        .projectRef,
    ).toEqual(macRef);
    expect(
      resolveNewThreadProjectRef({
        ...input,
        settingsByEnvironment: settings(
          { defaultEnvironmentId: null },
          { defaultEnvironmentId: pad.environmentId },
        ),
      }).environmentSelection,
    ).toBe("auto");
    expect(
      resolveNewThreadProjectRef({
        ...input,
        settingsByEnvironment: settings({}, { defaultEnvironmentId: pad.environmentId }),
      }).projectRef,
    ).toEqual(padRef);
  });

  it("retains the context checkout when it already lives on the default environment", () => {
    const checkout = { environmentId: pad.environmentId, id: ProjectId.make("pad-checkout") };
    const checkoutRef = { environmentId: checkout.environmentId, projectId: checkout.id };
    expect(
      resolveNewThreadProjectRef({
        ...input,
        members: [mac, pad, checkout],
        contextProjectRef: checkoutRef,
      }).projectRef,
    ).toEqual(checkoutRef);
  });
});
