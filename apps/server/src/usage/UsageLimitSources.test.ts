import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect.each([
  { scenario: "multiple windows", expected: "2099-01-01T02:00:00.000Z" },
  { scenario: "base model for 1m", expected: "2099-01-01T02:00:00.000Z" },
  { scenario: "suffixed model", expected: "2099-01-01T02:00:00.000Z" },
  { scenario: "unknown suffix", expected: null },
  { scenario: "model scopes", expected: "2099-01-01T04:00:00.000Z" },
  { scenario: "disabled account", expected: "2099-01-01T03:00:00.000Z" },
  { scenario: "model list unavailable", expected: "2099-01-01T03:00:00.000Z" },
  { scenario: "missing resets", expected: null },
  { scenario: "hub unavailable", expected: null },
  { scenario: "disabled source", expected: null },
])("resolves only the matching hub and model: $scenario", ({ scenario, expected }) =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const unrelated = yield* sources.resolveResetAt({
      endpoint: "https://other.test",
      model: "claude-opus-4-6",
    });
    expect(unrelated).toBeNull();
    const reset = yield* sources.resolveResetAt({
      endpoint: "https://hub.test/v1",
      model:
        scenario === "base model for 1m" || scenario === "suffixed model"
          ? "claude-opus-4-6[1m]"
          : scenario === "unknown suffix"
            ? "claude-opus-4-6[2m]"
            : "claude-opus-4-6",
    });
    expect(reset).toBe(expected);
    const unlisted = yield* sources.resolveResetAt({
      endpoint: "https://hub.test/v1",
      model: "unlisted",
    });
    expect(unlisted).toBeNull();
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "https://hub.test",
            managementKey: "test",
            enabled: scenario !== "disabled source",
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const url = new URL(request.url);
            if (
              scenario === "hub unavailable" ||
              (scenario === "model list unavailable" && url.searchParams.get("name") === "fast")
            ) {
              return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
            }
            const files = ["slow", "fast", "wrong-model"];
            const body = url.pathname.endsWith("/auth-files")
              ? {
                  files: files.map((id) => ({
                    id,
                    auth_index: id,
                    provider: "claude",
                    disabled: scenario === "disabled account" && id === "fast",
                  })),
                }
              : url.pathname.endsWith("/auth-files/models")
                ? {
                    models: [
                      {
                        id:
                          url.searchParams.get("name") === "wrong-model"
                            ? "claude-sonnet-4-6"
                            : scenario === "suffixed model"
                              ? "claude-opus-4-6[1m]"
                              : "claude-opus-4-6",
                      },
                    ],
                  }
                : (() => {
                    const input = JSON.parse(
                      request.body._tag === "Uint8Array"
                        ? new TextDecoder().decode(request.body.body)
                        : "{}",
                    );
                    const hour =
                      input.auth_index === "slow"
                        ? "03"
                        : input.auth_index === "fast"
                          ? "02"
                          : "01";
                    return {
                      status_code: 200,
                      body: JSON.stringify({
                        five_hour: {
                          utilization: 100,
                          resets_at: scenario === "missing resets" ? null : "2099-01-01T01:00:00Z",
                        },
                        seven_day: { utilization: 100, resets_at: `2099-01-01T${hour}:00:00Z` },
                        ...(scenario === "model scopes"
                          ? {
                              limits: [
                                {
                                  kind: "weekly_scoped",
                                  percent: 100,
                                  resets_at: "2099-01-01T04:00:00Z",
                                  scope: { model: { display_name: "Opus 4.6" } },
                                },
                                {
                                  kind: "weekly_scoped",
                                  percent: 100,
                                  resets_at: "2099-01-01T05:00:00Z",
                                  scope: { model: { display_name: "Sonnet" } },
                                },
                              ],
                            }
                          : {}),
                      }),
                    };
                  })();
            return HttpClientResponse.fromWeb(request, Response.json(body));
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
