// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { holdRequestsUntilServed } from "./httpEarlyRequests.ts";

const servers: NodeHttp.Server[] = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

function fetchStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => reject(new Error("request timed out")));
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe("holdRequestsUntilServed", () => {
  it("hands requests that arrive before the router to it once, then steps aside", async () => {
    const server = NodeHttp.createServer();
    // Registered before the hold, like the response error guard, so it sees
    // each arrival without counting as the router.
    const arrived = Promise.withResolvers<void>();
    let arrivals = 0;
    server.on("request", () => {
      arrivals += 1;
      if (arrivals === 2) arrived.resolve();
    });
    holdRequestsUntilServed(server);
    const port = await listen(server);

    const early = [fetchStatus(port, "/first"), fetchStatus(port, "/second")];
    await arrived.promise;

    const routed: Array<string | undefined> = [];
    server.on("request", (request, response) => {
      routed.push(request.url);
      response.writeHead(204).end();
    });

    expect(await Promise.all(early)).toEqual([204, 204]);
    expect(await fetchStatus(port, "/third")).toBe(204);
    expect(routed.toSorted()).toEqual(["/first", "/second", "/third"]);
  });

  it("drops a held request whose client disconnects before the router is up", async () => {
    const server = NodeHttp.createServer();
    const arrived = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    server.on("request", (_request, response) => {
      response.once("close", () => closed.resolve());
      arrived.resolve();
    });
    holdRequestsUntilServed(server);
    const port = await listen(server);

    const client = NodeNet.connect(port, "127.0.0.1", () => {
      client.write("GET /gone HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    client.on("error", () => {});
    await arrived.promise;
    client.destroy();
    await closed.promise;

    const routed: Array<string | undefined> = [];
    server.on("request", (request, response) => {
      routed.push(request.url);
      response.writeHead(204).end();
    });

    expect(await fetchStatus(port, "/live")).toBe(204);
    expect(routed).toEqual(["/live"]);
  });
});
