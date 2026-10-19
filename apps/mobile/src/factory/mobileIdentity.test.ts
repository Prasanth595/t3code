// Resolves upstream's real app.config.ts for each APP_VARIANT and checks that the
// fork hook gave it the fork's identity and left nothing that ties it to upstream.
import type { ExpoConfig } from "expo/config";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const UPSTREAM_VALUES = [
  "com.t3tools",
  "pingdotgg",
  "ARK85ZXQ4Z",
  "d763fcb8-d37c-41ea-a773-b54a0ab4a454",
  "clerk.t3.codes",
];

const VARIANTS = [
  {
    variant: "production",
    name: "T3 Code Factory",
    scheme: "t3code-factory",
    id: "au.com.originalsolutions.t3codefactory",
  },
  {
    variant: "preview",
    name: "T3 Code Factory Preview",
    scheme: "t3code-factory-preview",
    id: "au.com.originalsolutions.t3codefactory.preview",
  },
  {
    variant: "development",
    name: "T3 Code Factory Dev",
    scheme: "t3code-factory-dev",
    id: "au.com.originalsolutions.t3codefactory.dev",
  },
] as const;

const ENV_KEYS = [
  "APP_VARIANT",
  "T3CODE_IOS_PERSONAL_TEAM",
  "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
] as const;
const savedEnv = { ...process.env };

async function resolveConfig(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  const module: { default: ExpoConfig } = await import("../../app.config.ts");
  return module.default;
}

function pluginOptions(config: ExpoConfig, name: string): Record<string, unknown> {
  const entry = config.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === name);
  if (!Array.isArray(entry)) throw new Error(`plugin ${name} is missing`);
  return entry[1] as Record<string, unknown>;
}

afterEach(() => {
  // app.config.ts copies the repo env into process.env; put it back as it was.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("fork mobile identity", () => {
  for (const expected of VARIANTS) {
    it(`gives the ${expected.variant} build the fork's identity`, async () => {
      const config = await resolveConfig({ APP_VARIANT: expected.variant });

      expect(config.name).toBe(expected.name);
      expect(config.scheme).toBe(expected.scheme);
      expect(config.ios?.bundleIdentifier).toBe(expected.id);
      expect(config.android?.package).toBe(expected.id);
      expect(config.ios?.appleTeamId).toBe("3TB6CJ6ZHV");
      expect(config.ios?.associatedDomains).toEqual([
        "applinks:originalsolutions.com.au",
        "webcredentials:originalsolutions.com.au",
      ]);
      expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
        `$(AppIdentifierPrefix)${expected.id}`,
      ]);

      const widgets = pluginOptions(config, "expo-widgets");
      expect(widgets.bundleIdentifier).toBe(`${expected.id}.widgets`);
      expect(widgets.groupIdentifier).toBe(`group.${expected.id}`);
      const sharing = pluginOptions(config, "expo-sharing").ios as Record<string, unknown>;
      expect(sharing.extensionBundleIdentifier).toBe(`${expected.id}.sharing`);
      expect(sharing.appGroupId).toBe(`group.${expected.id}`);

      expect(config.updates?.enabled).toBe(false);
      expect(config.updates?.url).toBeUndefined();
      expect(config.owner).toBeUndefined();
      expect(config.extra?.eas?.projectId).toBeUndefined();

      const serialized = JSON.stringify(config);
      for (const upstream of UPSTREAM_VALUES) expect(serialized).not.toContain(upstream);
    });
  }

  it("lets the personal-team bundle id win over the fork id", async () => {
    const config = await resolveConfig({
      APP_VARIANT: "development",
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.personal",
    });

    expect(config.ios?.bundleIdentifier).toBe("com.example.personal");
    expect(config.android?.package).toBe("au.com.originalsolutions.t3codefactory.dev");
    const sharing = pluginOptions(config, "expo-sharing").ios as Record<string, unknown>;
    expect(sharing.extensionBundleIdentifier).toBe("com.example.personal.sharing");
    expect(sharing.appGroupId).toBe("group.com.example.personal");
  });
});
