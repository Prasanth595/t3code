import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickVoiceProvider, voiceCapableProviders } from "./VoiceCallButton.logic";

const provider = (id: string, patch: Partial<ServerProvider> = {}) =>
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
