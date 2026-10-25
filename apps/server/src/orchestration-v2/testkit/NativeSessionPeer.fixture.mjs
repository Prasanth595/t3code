import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import { NodeWS } from "@effect/platform-node-shared/NodeSocket";

const cfg = JSON.parse(process.argv[3]);
const turns = [
  {
    id: "old-turn",
    status: "completed",
    items: [
      {
        id: "old-user",
        type: "userMessage",
        content: [{ type: "text", text: "Existing native question" }],
      },
      {
        id: "old-answer",
        type: "agentMessage",
        text: "Existing native answer",
        phase: "final_answer",
      },
    ],
  },
];
let mcpName;
let mcpEnabled = true;
let activeSocket;
let chatInput;
const chatTurn = (status) => ({
  id: "chat-turn",
  status,
  items: [],
  error: null,
  startedAt: 0,
  completedAt: status === "completed" ? 1 : null,
  durationMs: null,
});
const send = (ws, frame) => {
  NodeFS.appendFileSync(cfg.log, JSON.stringify({ direction: "from-peer", ...frame }) + "\n");
  ws.send(JSON.stringify(frame));
};
const thread = () => ({
  id: cfg.nativeId,
  cwd: cfg.home,
  updatedAt: 0,
  createdAt: 0,
  cliVersion: "0.163.0",
  historyMode: "legacy",
  status: { type: "idle" },
  turns,
  modelProvider: "openai",
  ephemeral: false,
  preview: "",
  source: "cli",
  projectId: null,
  sessionId: "fixture",
});
const server = NodeHttp.createServer();
const wss = new NodeWS.WebSocketServer({ server });
wss.on("connection", (ws) => {
  activeSocket = ws;
  ws.on("message", (bytes) => {
    const r = JSON.parse(String(bytes));
    NodeFS.appendFileSync(cfg.log, JSON.stringify({ direction: "to-peer", ...r }) + "\n");
    if (r.id === undefined) return;
    if (r.method === undefined && r.id === "synthetic-approval") {
      if (r.result?.decision !== "accept") throw new Error("Expected one accepted approval");
      send(ws, {
        method: "serverRequest/resolved",
        params: { threadId: cfg.nativeId, requestId: r.id },
      });
      send(ws, {
        method: "item/started",
        params: {
          threadId: cfg.nativeId,
          turnId: "chat-turn",
          item: { id: "chat-answer", type: "agentMessage", text: "", phase: "final_answer" },
        },
      });
      send(ws, {
        method: "item/agentMessage/delta",
        params: {
          threadId: cfg.nativeId,
          turnId: "chat-turn",
          itemId: "chat-answer",
          delta: "Hello",
        },
      });
      return;
    }
    let result;
    switch (r.method) {
      case "initialize":
        result = {
          userAgent: "codex-tui/0.164.0 (Debian 12.0.0; x86_64)",
          codexHome: cfg.home,
          platformFamily: "unix",
          platformOs: "linux",
        };
        break;
      case "thread/resume": {
        const entry = Object.entries(r.params.config ?? {}).find(([key]) =>
          key.startsWith("mcp_servers."),
        );
        if (entry) {
          mcpName = entry[0].slice("mcp_servers.".length);
          mcpEnabled = entry[1].enabled !== false;
        }
        result = {
          thread: thread(),
          cwd: cfg.home,
          model: cfg.settings.model,
          modelProvider: "openai",
          reasoningEffort: cfg.settings.reasoningEffort,
          approvalPolicy: cfg.settings.approvalPolicy,
          sandbox: cfg.settings.sandboxPolicy,
          approvalsReviewer: "user",
        };
        break;
      }
      case "thread/read":
        result = { thread: thread() };
        break;
      case "thread/goal/get":
        result = { goal: null };
        break;
      case "mcpServerStatus/list":
        result = {
          data: [
            {
              name: mcpName,
              httpOrigin: "http://127.0.0.1:65530",
              runtimeStatus: mcpEnabled ? "connected" : "disabled",
              serverInfo: { name: "T3 Code", version: "fixture" },
            },
          ],
          nextCursor: null,
        };
        break;
      case "mcpResource/read":
        result = { contents: [{ text: JSON.stringify(cfg.authority) }] };
        break;
      case "thread/unsubscribe":
        result = { status: "unsubscribed" };
        break;
      case "turn/start":
        chatInput = r.params.input;
        result = { turn: chatTurn("inProgress") };
        break;
      default:
        throw new Error(`Unexpected native method ${r.method}`);
    }
    send(ws, { id: r.id, result });
  });
});
server.listen(cfg.socket, () => process.stdout.write("ready\n"));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data.trim() === "approve") {
    send(activeSocket, {
      id: "synthetic-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        startedAtMs: 0,
        environmentId: "local",
        threadId: cfg.nativeId,
        turnId: "chat-turn",
        itemId: "fixture-command",
        command: "fixture-only-no-execution",
        cwd: cfg.home,
        reason: "Synthetic approval, no command executes",
        commandActions: [],
        availableDecisions: ["accept", "cancel"],
      },
    });
  }
  if (data.trim() === "finish") {
    send(activeSocket, {
      method: "item/agentMessage/delta",
      params: {
        threadId: cfg.nativeId,
        turnId: "chat-turn",
        itemId: "chat-answer",
        delta: " from adopted chat",
      },
    });
    const item = {
      id: "chat-answer",
      type: "agentMessage",
      text: "Hello from adopted chat",
      phase: "final_answer",
    };
    turns.push({
      ...chatTurn("completed"),
      items: [
        {
          id: "chat-user",
          type: "userMessage",
          content: chatInput.filter((v) => v.type === "text"),
        },
        item,
      ],
    });
    send(activeSocket, {
      method: "item/completed",
      params: { threadId: cfg.nativeId, turnId: "chat-turn", item },
    });
    send(activeSocket, {
      method: "turn/completed",
      params: { threadId: cfg.nativeId, turn: chatTurn("completed") },
    });
  }
  if (data.trim() === "append") {
    turns.push({
      id: "external-turn",
      status: "completed",
      items: [
        {
          id: "external-answer",
          type: "agentMessage",
          text: "External appended answer",
          phase: "final_answer",
        },
      ],
    });
    process.stdout.write("appended\n");
  }
});
process.stdin.on("end", () => {
  for (const ws of wss.clients) ws.terminate();
  server.close();
});
