import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chatModelProviders,
  pickVoiceProvider,
  voiceCapableProviders,
} from "./VoiceCallButton.logic";

const provider = (id: string, patch: object = {}) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    enabled: true,
    supportsRealtimeVoice: true,
    ...patch,
  }) as ServerProvider;

describe("voice call account", () => {
  const plus = provider("codex");
  const pro = provider("codex_ol");

  it("offers only enabled accounts that can start a call", () => {
    const candidates = voiceCapableProviders([
      plus,
      provider("off", { enabled: false }),
      provider("api", { supportsRealtimeVoice: false }),
      pro,
    ]);
    expect(candidates).toEqual([plus, pro]);
  });

  it("prefers the pick, then the thread's account, then the first", () => {
    expect(pickVoiceProvider([plus, pro], pro.instanceId, plus.instanceId)).toBe(pro);
    expect(pickVoiceProvider([plus, pro], undefined, pro.instanceId)).toBe(pro);
    expect(pickVoiceProvider([plus, pro], undefined, ProviderInstanceId.make("claudeAgent"))).toBe(
      plus,
    );
    expect(pickVoiceProvider([], undefined, undefined)).toBeUndefined();
  });

  it("drops a pick whose account no longer offers calls", () => {
    expect(pickVoiceProvider([plus], pro.instanceId, undefined)).toBe(plus);
  });
});

describe("chat model choices", () => {
  const model = (slug: string, isLegacy = false) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
    isLegacy,
  });
  const ready = (id: string, patch: Partial<ServerProvider> = {}) =>
    provider(id, {
      status: "ready",
      installed: true,
      models: [model("current"), model("old", true)],
      ...patch,
    });

  it("lists only current models of enabled, installed, ready accounts", () => {
    const listed = chatModelProviders([
      ready("codex"),
      ready("off", { enabled: false }),
      ready("down", { status: "error" }),
      ready("missing", { installed: false }),
      ready("empty", { models: [model("old", true)] }),
    ]);
    expect(listed.map((entry) => [entry.instanceId, entry.models.map((m) => m.slug)])).toEqual([
      ["codex", ["current"]],
    ]);
  });
});
