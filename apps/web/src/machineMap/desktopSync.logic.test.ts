import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  MachineId,
  type MachineMapClientState,
  type MachineMapReachablePeer,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clientSettingsPatchFromDesired,
  clientSettingsReportKey,
  planMachineSync,
  sameRequestHeaders,
  type SavedEnvironment,
  tokenRequestHeaders,
} from "./desktopSync.logic";

const TOKEN = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" };
const VPS = "https://vps.example.com";
const WINDOWS = "https://windows.example.com";

function peer(origin: string): MachineMapReachablePeer {
  const hostname = origin.replace("https://", "");
  return {
    machine: {
      id: MachineId.make(hostname),
      name: hostname,
      kind: "server",
      hostname,
      tokenClientId: `${hostname}.access`,
    },
    level: "standard",
    agentTools: false,
    origin,
  };
}

function state(
  patch: Partial<Pick<MachineMapClientState, "enabled" | "joined" | "reachable" | "tokenHeaders">>,
) {
  return { enabled: true, joined: true, reachable: [], tokenHeaders: TOKEN, ...patch };
}

function saved(origin: string, phase: SavedEnvironment["phase"] = "connected"): SavedEnvironment {
  return { environmentId: EnvironmentId.make(origin), origin, phase };
}

const none = new Set<string>();

describe("planMachineSync", () => {
  it("adds and pairs each reachable machine that is not saved", () => {
    const plan = planMachineSync({
      state: state({ reachable: [peer(VPS), peer(WINDOWS)] }),
      managedOrigins: none,
      environments: [],
      repairAttempted: none,
    });
    expect(plan).toEqual({ keep: [VPS, WINDOWS], pair: [VPS, WINDOWS], remove: [] });
  });

  it("does not pair a managed machine again while it connects", () => {
    const plan = planMachineSync({
      state: state({ reachable: [peer(VPS)] }),
      managedOrigins: new Set([VPS]),
      environments: [saved(VPS)],
      repairAttempted: none,
    });
    expect(plan).toEqual({ keep: [VPS], pair: [], remove: [] });
  });

  it("leaves an environment that the user saved by hand alone", () => {
    const plan = planMachineSync({
      state: state({ reachable: [peer(VPS)] }),
      managedOrigins: none,
      environments: [saved(VPS)],
      repairAttempted: none,
    });
    expect(plan).toEqual({ keep: [], pair: [], remove: [] });
  });

  it("gives the token headers only to exact https machine origins", () => {
    const plan = planMachineSync({
      state: state({
        reachable: [
          peer(VPS),
          { ...peer(WINDOWS), origin: "http://windows.example.com" },
          { ...peer(WINDOWS), origin: `${WINDOWS}/path` },
        ],
      }),
      managedOrigins: none,
      environments: [],
      repairAttempted: none,
    });
    expect(plan.keep).toEqual([VPS]);
    expect(plan.pair).toEqual([VPS]);
  });

  it("removes a managed machine when it leaves reachable", () => {
    const plan = planMachineSync({
      state: state({ reachable: [peer(VPS)] }),
      managedOrigins: new Set([VPS, WINDOWS]),
      environments: [saved(VPS), saved(WINDOWS)],
      repairAttempted: none,
    });
    expect(plan.remove).toEqual([{ origin: WINDOWS, environmentId: EnvironmentId.make(WINDOWS) }]);
  });

  it("removes every managed machine after leaving the map, saved or not", () => {
    const plan = planMachineSync({
      state: state({ joined: false, tokenHeaders: null, reachable: [] }),
      managedOrigins: new Set([VPS, WINDOWS]),
      environments: [saved(VPS)],
      repairAttempted: none,
    });
    expect(plan).toEqual({
      keep: [],
      pair: [],
      remove: [
        { origin: VPS, environmentId: EnvironmentId.make(VPS) },
        { origin: WINDOWS, environmentId: null },
      ],
    });
  });

  it("changes nothing for a joined session without token headers", () => {
    const plan = planMachineSync({
      state: state({ tokenHeaders: null, reachable: [peer(VPS)] }),
      managedOrigins: new Set([WINDOWS]),
      environments: [],
      repairAttempted: none,
    });
    expect(plan).toEqual({ keep: [], pair: [], remove: [] });
  });

  it("pairs a failing managed machine again once per failure", () => {
    const input = {
      state: state({ reachable: [peer(VPS)] }),
      managedOrigins: new Set([VPS]),
      environments: [saved(VPS, "error")],
    };
    expect(planMachineSync({ ...input, repairAttempted: none }).pair).toEqual([VPS]);
    expect(planMachineSync({ ...input, repairAttempted: new Set([VPS]) }).pair).toEqual([]);
  });
});

describe("token request headers", () => {
  it("compare by header name without case and ignore order", () => {
    const headers = tokenRequestHeaders(TOKEN);
    expect(
      sameRequestHeaders(headers, [
        { name: "cf-access-client-secret", value: "secret" },
        { name: "CF-ACCESS-CLIENT-ID", value: "id.access" },
      ]),
    ).toBe(true);
    expect(sameRequestHeaders(headers, [{ name: "CF-Access-Client-Id", value: "id.access" }])).toBe(
      false,
    );
  });
});

describe("clientSettingsPatchFromDesired", () => {
  it("writes nothing when the desired values are already current", () => {
    const current = { ...DEFAULT_CLIENT_SETTINGS, chatWidth: "wide" as const };
    const result = clientSettingsPatchFromDesired({ chatWidth: "wide" }, current);
    expect(result).toEqual({ patch: {}, skipped: [] });
  });

  it("keeps changed values and skips unknown keys and invalid values", () => {
    const result = clientSettingsPatchFromDesired(
      { chatWidth: "full", notAClientSetting: true, inAppNotificationsEnabled: "yes" },
      DEFAULT_CLIENT_SETTINGS,
    );
    expect(result.patch).toEqual({ chatWidth: "full" });
    expect(result.skipped).toEqual(["notAClientSetting", "inAppNotificationsEnabled"]);
  });

  it("gives the same report key after the map's own write is applied again", () => {
    const applied = { ...DEFAULT_CLIENT_SETTINGS, chatWidth: "full" as const };
    const { patch } = clientSettingsPatchFromDesired({ chatWidth: "full" }, applied);
    expect(clientSettingsReportKey({ ...applied, ...patch })).toBe(
      clientSettingsReportKey(applied),
    );
  });
});
