import {
  EnvironmentId,
  SECRET_REDACTED,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSyncSetupSummary,
  formatProviderSyncStatusLine,
  joinDeviceLabels,
  mergeProviderInstanceForSync,
  planProviderInstanceRemoval,
  planProviderInstanceUpsert,
  planProviderInstancesSync,
  resolveProviderSyncSetupOffer,
  supportsProviderSync,
  toPortableProviderInstance,
} from "./providerSync.ts";

const linuxBox = EnvironmentId.make("env-linux-box");
const mainPc = EnvironmentId.make("env-main-pc");
const laptop = EnvironmentId.make("env-laptop");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const richCodex: ProviderInstanceConfig = {
  driver: codex,
  displayName: "Codex work",
  enabled: true,
  config: {
    binaryPath: "/usr/local/bin/codex",
    homePath: "~/.codex_work",
    shadowHomePath: "~/.codex-t3/work",
    launchArgs: "--profile work",
    apiKey: SECRET_REDACTED,
  },
  environment: [
    { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
    { name: "TERM", value: "xterm-256color", sensitive: false },
  ],
};

describe("supportsProviderSync", () => {
  it("requires a connected environment with a loaded server config", () => {
    expect(
      supportsProviderSync({
        connection: { phase: "connected" },
        serverConfig: { settings: {} },
      }),
    ).toBe(true);
    expect(
      supportsProviderSync({
        connection: { phase: "connected" },
        serverConfig: null,
      }),
    ).toBe(false);
    expect(
      supportsProviderSync({
        connection: { phase: "reconnecting" },
        serverConfig: { settings: {} },
      }),
    ).toBe(false);
  });
});

describe("joinDeviceLabels / formatProviderSyncStatusLine", () => {
  it("formats one, two, and many device names", () => {
    expect(joinDeviceLabels(["linux-box"])).toBe("linux-box");
    expect(joinDeviceLabels(["linux-box", "main-pc"])).toBe("linux-box and main-pc");
    expect(joinDeviceLabels(["linux-box", "main-pc", "laptop"])).toBe(
      "linux-box, main-pc and laptop",
    );
  });

  it("writes the status line from the mockup", () => {
    expect(formatProviderSyncStatusLine([])).toBe("On. Connect another device to sync providers.");
    expect(formatProviderSyncStatusLine(["linux-box", "main-pc", "laptop"])).toBe(
      "On for linux-box, main-pc and laptop.",
    );
  });
});

describe("toPortableProviderInstance", () => {
  it("drops host-local paths, redacted config values, and redacted env vars", () => {
    expect(toPortableProviderInstance(richCodex)).toEqual({
      driver: codex,
      displayName: "Codex work",
      enabled: true,
      config: { launchArgs: "--profile work" },
      environment: [{ name: "TERM", value: "xterm-256color", sensitive: false }],
    });
  });

  it("never forwards the redaction marker as a real secret value", () => {
    expect(
      toPortableProviderInstance({
        driver: ProviderDriverKind.make("antigravity"),
        config: { apiKey: SECRET_REDACTED, authMethod: "gemini-api-key" },
      }).config,
    ).toEqual({ authMethod: "gemini-api-key" });
  });
});

describe("mergeProviderInstanceForSync", () => {
  it("keeps the destination's secrets and host paths when upserting", () => {
    const existing: ProviderInstanceConfig = {
      driver: codex,
      enabled: false,
      config: {
        binaryPath: "C:\\codex.exe",
        homePath: "D:\\codex",
        apiKey: SECRET_REDACTED,
      },
      environment: [
        { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
      ],
    };

    expect(mergeProviderInstanceForSync(richCodex, existing)).toEqual({
      driver: codex,
      displayName: "Codex work",
      enabled: true,
      config: {
        launchArgs: "--profile work",
        binaryPath: "C:\\codex.exe",
        homePath: "D:\\codex",
        apiKey: SECRET_REDACTED,
      },
      environment: [
        { name: "TERM", value: "xterm-256color", sensitive: false },
        { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
      ],
    });
  });

  it("creates a portable instance when the peer has none", () => {
    expect(mergeProviderInstanceForSync(richCodex, undefined)).toEqual(
      toPortableProviderInstance(richCodex),
    );
  });

  it("re-attaches destination redaction markers when the portable payload omits them", () => {
    // Omitting a secret key on upsert deletes the stored secret on the server.
    // Sync must keep the marker so the peer's secret store entry survives.
    const sourceWithoutVisibleSecret: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Work",
      enabled: true,
      config: { authMethod: "gemini-api-key", gcpProject: "team" },
    };
    const existingWithSecret: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("antigravity"),
      enabled: true,
      config: {
        authMethod: "oauth-personal",
        apiKey: SECRET_REDACTED,
        binaryPath: "/opt/antigravity",
      },
      environment: [{ name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true }],
    };

    const merged = mergeProviderInstanceForSync(sourceWithoutVisibleSecret, existingWithSecret);
    expect(merged.config).toEqual({
      authMethod: "gemini-api-key",
      gcpProject: "team",
      apiKey: SECRET_REDACTED,
      binaryPath: "/opt/antigravity",
    });
    expect(merged.environment).toEqual([
      { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
    ]);
  });

  it("lets destination redaction markers win over empty portable secret placeholders", () => {
    const merged = mergeProviderInstanceForSync(
      {
        driver: ProviderDriverKind.make("antigravity"),
        config: { apiKey: "", authMethod: "gemini-api-key" },
      },
      {
        driver: ProviderDriverKind.make("antigravity"),
        config: { apiKey: SECRET_REDACTED },
      },
    );
    expect(merged.config).toEqual({
      authMethod: "gemini-api-key",
      apiKey: SECRET_REDACTED,
    });
  });
});

describe("planProviderInstanceUpsert / planProviderInstancesSync", () => {
  it("plans an upsert per target with merged payloads", () => {
    const plan = planProviderInstanceUpsert({
      instanceId: codexId,
      source: richCodex,
      targets: [
        { environmentId: mainPc, existing: undefined },
        {
          environmentId: laptop,
          existing: {
            driver: codex,
            config: { binaryPath: "/opt/codex" },
          },
        },
      ],
    });

    expect(plan).toHaveLength(2);
    expect(plan[0]).toEqual({
      environmentId: mainPc,
      mutation: {
        operation: "upsert",
        instanceId: codexId,
        instance: toPortableProviderInstance(richCodex),
      },
    });
    const laptopMutation = plan[1]?.mutation;
    expect(laptopMutation?.operation).toBe("upsert");
    if (laptopMutation?.operation === "upsert") {
      expect(laptopMutation.instance.config).toMatchObject({
        launchArgs: "--profile work",
        binaryPath: "/opt/codex",
      });
    }
  });

  it("fans a full source map out to every peer", () => {
    const plan = planProviderInstancesSync({
      sourceInstances: {
        [codexId]: { driver: codex, enabled: true },
        [claudeId]: { driver: claude, displayName: "Claude" },
      },
      targets: [
        { environmentId: mainPc, instances: {} },
        {
          environmentId: laptop,
          instances: { [codexId]: { driver: codex, enabled: false } },
        },
      ],
    });

    expect(plan.map((entry) => [entry.environmentId, entry.mutation.instanceId])).toEqual([
      [mainPc, codexId],
      [mainPc, claudeId],
      [laptop, codexId],
      [laptop, claudeId],
    ]);
    expect(
      plan.find((entry) => entry.environmentId === laptop && entry.mutation.instanceId === codexId)
        ?.mutation,
    ).toMatchObject({
      operation: "upsert",
      instance: { driver: codex, enabled: true },
    });
  });
});

describe("planProviderInstanceRemoval", () => {
  it("removes only from the source device when scoped to this device", () => {
    expect(
      planProviderInstanceRemoval({
        instanceId: claudeId,
        scope: "this-device",
        sourceEnvironmentId: linuxBox,
        peerEnvironmentIds: [mainPc, laptop],
      }),
    ).toEqual([
      {
        environmentId: linuxBox,
        mutation: { operation: "remove", instanceId: claudeId },
      },
    ]);
  });

  it("removes from the source and every peer when scoped to all devices", () => {
    expect(
      planProviderInstanceRemoval({
        instanceId: claudeId,
        scope: "all-devices",
        sourceEnvironmentId: linuxBox,
        peerEnvironmentIds: [mainPc, laptop, linuxBox],
      }),
    ).toEqual([
      {
        environmentId: linuxBox,
        mutation: { operation: "remove", instanceId: claudeId },
      },
      {
        environmentId: mainPc,
        mutation: { operation: "remove", instanceId: claudeId },
      },
      {
        environmentId: laptop,
        mutation: { operation: "remove", instanceId: claudeId },
      },
    ]);
  });
});

describe("resolveProviderSyncSetupOffer", () => {
  it("offers to set up an empty connected peer from the richest source", () => {
    expect(
      resolveProviderSyncSetupOffer({
        syncEnabled: true,
        dismissedEnvironmentIds: [],
        environments: [
          {
            environmentId: linuxBox,
            label: "linux-box",
            syncEligible: true,
            providerInstances: {
              [codexId]: { driver: codex },
              [claudeId]: { driver: claude },
            },
          },
          {
            environmentId: mainPc,
            label: "main-pc",
            syncEligible: true,
            providerInstances: {},
          },
        ],
      }),
    ).toEqual({
      targetEnvironmentId: mainPc,
      targetLabel: "main-pc",
      sourceEnvironmentId: linuxBox,
      sourceLabel: "linux-box",
      providerSummary: "Codex and Claude",
    });
  });

  it("treats an empty providerInstances map as a new device (defaults are not stored there)", () => {
    // Built-in defaults are registry-derived; settings.providerInstances stays {} until customized.
    const offer = resolveProviderSyncSetupOffer({
      syncEnabled: true,
      dismissedEnvironmentIds: [],
      environments: [
        {
          environmentId: linuxBox,
          label: "linux-box",
          syncEligible: true,
          providerInstances: { [codexId]: { driver: codex, displayName: "Work" } },
        },
        {
          environmentId: mainPc,
          label: "main-pc",
          syncEligible: true,
          providerInstances: {},
        },
      ],
    });
    expect(offer?.targetEnvironmentId).toBe(mainPc);
    expect(offer?.providerSummary).toBe("Work");
  });

  it("stays quiet when sync is off, the peer was dismissed, or nobody has providers", () => {
    const environments = [
      {
        environmentId: linuxBox,
        label: "linux-box",
        syncEligible: true,
        providerInstances: { [codexId]: { driver: codex } },
      },
      {
        environmentId: mainPc,
        label: "main-pc",
        syncEligible: true,
        providerInstances: {},
      },
    ];

    expect(
      resolveProviderSyncSetupOffer({
        syncEnabled: false,
        dismissedEnvironmentIds: [],
        environments,
      }),
    ).toBeNull();
    expect(
      resolveProviderSyncSetupOffer({
        syncEnabled: true,
        dismissedEnvironmentIds: [mainPc],
        environments,
      }),
    ).toBeNull();
    expect(
      resolveProviderSyncSetupOffer({
        syncEnabled: true,
        dismissedEnvironmentIds: [],
        environments: environments.map((environment) => ({
          ...environment,
          providerInstances: {},
        })),
      }),
    ).toBeNull();
  });
});

describe("formatProviderSyncSetupSummary", () => {
  it("joins provider display names", () => {
    expect(
      formatProviderSyncSetupSummary({
        [codexId]: { driver: codex },
        [claudeId]: { driver: claude, displayName: "Claude" },
      }),
    ).toBe("Codex and Claude");
  });
});
