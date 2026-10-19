import { ClientId, MachineId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { enrollWithInvite } from "./clientEnrollSteps";

const invite = { enrollUrl: "https://portal.example.com/enroll/client", code: "code" };
const mac = { id: MachineId.make("mac"), name: "Mac", origin: "https://mac.example.com" };

function setup(input: {
  readonly machines: ReadonlyArray<typeof mac>;
  readonly failSave?: string;
}) {
  const saved: string[] = [];
  const undone: string[] = [];
  const clients: unknown[] = [];
  const deps = {
    redeem: async () => ({
      clientId: ClientId.make("client-phone"),
      name: "Phone",
      serviceToken: { clientId: "app.access", clientSecret: "secret" },
      machines: input.machines,
      machinesUrl: "https://portal.example.com/client/machines",
    }),
    origin: (url: string) => new URL(url).origin,
    saveToken: async (origin: string) => {
      if (origin === input.failSave) return { error: "Could not save the service token." };
      saved.push(origin);
      return {
        undo: async () => {
          undone.push(origin);
          return null;
        },
      };
    },
    saveClient: (client: unknown) => clients.push(client),
    pair: async () => {
      throw new Error("The machine refused this phone (403).");
    },
  };
  return { deps, saved, undone, clients };
}

describe("enrollWithInvite", () => {
  it("keeps the token and the client when no machine pairs", async () => {
    const { deps, saved, undone, clients } = setup({ machines: [mac] });
    const result = await enrollWithInvite(invite, deps);
    expect(result.failed).toHaveLength(1);
    expect(saved).toEqual(["https://portal.example.com", "https://mac.example.com"]);
    expect(undone).toEqual([]);
    expect(clients).toEqual([
      { machinesUrl: "https://portal.example.com/client/machines", clientId: "client-phone" },
    ]);
  });

  it("keeps the token for an invite with no machines yet", async () => {
    const { deps, undone, clients } = setup({ machines: [] });
    const result = await enrollWithInvite(invite, deps);
    expect(result.paired).toEqual([]);
    expect(undone).toEqual([]);
    expect(clients).toHaveLength(1);
  });

  it("rolls back the saved tokens when saving one fails", async () => {
    const { deps, undone, clients } = setup({
      machines: [mac],
      failSave: "https://mac.example.com",
    });
    await expect(enrollWithInvite(invite, deps)).rejects.toThrow(
      "Could not save the service token.",
    );
    expect(undone).toEqual(["https://portal.example.com"]);
    expect(clients).toEqual([]);
  });
});
