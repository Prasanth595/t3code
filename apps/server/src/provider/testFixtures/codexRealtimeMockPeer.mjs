// Minimal Codex app-server peer for the realtime voice handshake. T3_CODEX_REALTIME_LOG records
// the requests it receives; T3_CODEX_REALTIME_ACCOUNT picks the account type.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (entry) =>
  NodeFS.appendFileSync(process.env.T3_CODEX_REALTIME_LOG, `${JSON.stringify(entry)}\n`);
const accountType = process.env.T3_CODEX_REALTIME_ACCOUNT ?? "chatgpt";

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === undefined) return;
  log({ method, params, args: process.argv.slice(2) });
  const reply = (result) => write({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    reply({
      userAgent: "mock/0.0.0",
      codexHome: "/tmp",
      platformFamily: "unix",
      platformOs: "linux",
    });
  } else if (method === "account/read") {
    reply({
      account: { type: accountType, email: null, planType: "plus" },
      requiresOpenaiAuth: false,
    });
  } else if (method === "thread/start") {
    reply({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: "/tmp",
      model: "mock",
      modelProvider: "openai",
      sandbox: { type: "readOnly" },
      thread: {
        id: "voice-thread",
        sessionId: "voice-thread",
        cliVersion: "0.0.0",
        createdAt: 0,
        updatedAt: 0,
        cwd: "/tmp",
        ephemeral: true,
        modelProvider: "openai",
        preview: "",
        projectId: null,
        source: "appServer",
        status: { type: "idle" },
        turns: [],
      },
    });
  } else if (method === "thread/realtime/start") {
    reply({});
    write({
      jsonrpc: "2.0",
      method: "thread/realtime/started",
      params: { threadId: params.threadId, version: "v3" },
    });
    write({
      jsonrpc: "2.0",
      method: "thread/realtime/sdp",
      params: { threadId: params.threadId, sdp: `answer-for:${params.transport.sdp}` },
    });
    for (const [method, role, text] of [
      ["delta", "user", "hel"],
      ["delta", "user", "lo"],
      ["done", "user", "hello"],
      ["done", "assistant", "hi there"],
    ]) {
      write({
        jsonrpc: "2.0",
        method: `thread/realtime/transcript/${method}`,
        params: { threadId: params.threadId, role, [method === "done" ? "text" : "delta"]: text },
      });
    }
  } else if (method === "thread/realtime/stop") {
    reply({});
    write({
      jsonrpc: "2.0",
      method: "thread/realtime/closed",
      params: { threadId: params.threadId, reason: "requested" },
    });
  } else if (id !== undefined) {
    reply({});
  }
});
