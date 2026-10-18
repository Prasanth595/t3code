// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";

type RequestListener = (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
) => void;

/**
 * The HTTP server listens as soon as its layer is built, but the router only
 * registers its "request" listener after every runtime layer is up. A request
 * that arrives in between, such as the desktop readiness probe, would otherwise
 * get no response and hang until the client gives up. Hold those requests and
 * hand them to the first "request" listener added after this one. A request
 * whose client disconnects first is dropped, so a stalled startup only keeps
 * live connections.
 */
export function holdRequestsUntilServed<T extends NodeHttp.Server>(server: T): T {
  const held = new Map<NodeHttp.ServerResponse, NodeHttp.IncomingMessage>();
  const hold: RequestListener = (request, response) => {
    held.set(response, request);
    response.once("close", () => held.delete(response));
  };
  const onNewListener = (event: string | symbol, listener: RequestListener) => {
    if (event !== "request" || listener === hold) return;
    server.off("newListener", onNewListener);
    server.off("request", hold);
    // "newListener" fires before the listener is registered.
    queueMicrotask(() => {
      const pending = [...held];
      held.clear();
      for (const [response, request] of pending) listener(request, response);
    });
  };
  server.on("request", hold);
  server.on("newListener", onNewListener);
  return server;
}
