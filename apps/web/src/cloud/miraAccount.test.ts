import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasMiraEnvironment, miraPiInstance, withMiraEnvironment } from "./miraAccount";

const key = { apiKey: "mira_new", baseUrl: "https://relay.test/v1/llm" };

describe("Mira account on the Pi instance", () => {
  it("replaces an earlier Mira key and keeps the user's other variables", () => {
    const environment = withMiraEnvironment(
      [
        { name: "HTTPS_PROXY", value: "http://proxy", sensitive: false },
        { name: "MIRA_API_KEY", value: "", sensitive: true, valueRedacted: true },
      ],
      key,
    );
    expect(environment).toEqual([
      { name: "HTTPS_PROXY", value: "http://proxy", sensitive: false },
      { name: "MIRA_BASE_URL", value: key.baseUrl, sensitive: false },
      { name: "MIRA_API_KEY", value: "mira_new", sensitive: true },
    ]);
  });

  it("reads a saved key as connected even when the server redacts its value", () => {
    const pi = ProviderInstanceId.make("pi");
    const instance = miraPiInstance({ providerInstances: {} }, key);
    expect(instance.driver).toBe(ProviderDriverKind.make("pi"));
    expect(hasMiraEnvironment({ providerInstances: {} })).toBe(false);
    expect(
      hasMiraEnvironment({
        providerInstances: {
          [pi]: {
            driver: ProviderDriverKind.make("pi"),
            environment: [
              { name: "MIRA_BASE_URL", value: key.baseUrl, sensitive: false },
              { name: "MIRA_API_KEY", value: "", sensitive: true, valueRedacted: true },
            ],
          },
        },
      }),
    ).toBe(true);
  });
});
