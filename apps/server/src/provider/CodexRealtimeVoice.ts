import {
  CODEX_REALTIME_VOICE_NAMES,
  isRealtimeVoiceError,
  RealtimeVoiceError,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type {
  ProviderRealtimeVoice,
  RealtimeVoiceThread,
} from "@t3tools/provider-core/server/driver";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import { withCodexAppServerClient } from "./CodexProvider.ts";

// Experimental app-server API: `realtime_conversation` gates thread/realtime/*, and forcing the
// ChatGPT login keeps a stray API key from silently turning a subscription call into metered usage.
const REALTIME_LAUNCH_ARGS = "--enable realtime_conversation -c forced_login_method=chatgpt";
const ANSWER_TIMEOUT = Duration.seconds(30);
const STOP_TIMEOUT = Duration.seconds(2);
const MAX_CALL_DURATION = Duration.hours(1);
// Every call is a Codex process with its MCP servers; bound them per instance.
const MAX_CONCURRENT_CALLS = 2;

// T3's wait tools can block for an hour; keep Codex's MCP timeout above that.
const T3_MCP_TOOL_TIMEOUT_SEC = 65 * 60;

// Without a person to approve them, tool calls fail under approvalPolicy "never" unless pre-approved.
const t3McpServer = ({ mcp, tools }: RealtimeVoiceThread) => ({
  url: mcp.endpoint,
  tool_timeout_sec: T3_MCP_TOOL_TIMEOUT_SEC,
  http_headers: { Authorization: mcp.authorizationHeader },
  tools: Object.fromEntries(tools.map((tool) => [tool, { approval_mode: "approve" }])),
});

/** Realtime voice is bundled with the ChatGPT subscription; API-key accounts are metered elsewhere. */
export const codexSupportsRealtimeVoice = ({ auth }: ServerProvider) =>
  auth.status === "authenticated" && auth.type === "chatgpt";

interface Session {
  readonly scope: Scope.Closeable;
  readonly done: Deferred.Deferred<void>;
}

type AppServerLaunch = Parameters<typeof withCodexAppServerClient>[0];

/**
 * Each call owns one app-server process and one ephemeral read-only thread. The browser's WebRTC
 * peer talks to OpenAI directly; this only relays the SDP offer and answer, then keeps the process
 * alive until the call ends, the provider closes it, or the duration cap is reached.
 */
export const makeCodexRealtimeVoice = Effect.fn("CodexRealtimeVoice.make")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly launch: Omit<AppServerLaunch, "cwd" | "launchArgs">;
  readonly launchArgs: string;
  /** This instance's voice settings: whether it offers calls, its voice, and extra instructions. */
  readonly enabled: boolean;
  readonly voice: string;
  readonly instructions: string;
}) {
  const crypto = yield* Crypto.Crypto;
  const services =
    yield* Effect.context<
      Exclude<Effect.Services<ReturnType<typeof withCodexAppServerClient>>, Scope.Scope>
    >();
  const sessions = yield* Ref.make(new Map<string, Session>());
  const fail = (reason: RealtimeVoiceError["reason"], cause?: unknown) =>
    new RealtimeVoiceError({ instanceId: input.instanceId, reason, cause });

  const endSession = (session: Session) => Deferred.succeed(session.done, undefined);

  yield* Effect.addFinalizer(() =>
    Ref.get(sessions).pipe(
      Effect.flatMap((all) =>
        Effect.forEach([...all.values()], (s) => Scope.close(s.scope, Exit.void), {
          discard: true,
        }),
      ),
    ),
  );

  const negotiate = Effect.fn("CodexRealtimeVoice.negotiate")(function* (
    session: Session,
    request: Parameters<ProviderRealtimeVoice["start"]>[0],
  ) {
    if (request.thread) yield* Scope.addFinalizer(session.scope, request.thread.release);
    const { client } = yield* withCodexAppServerClient({
      ...input.launch,
      launchArgs: `${input.launchArgs} ${REALTIME_LAUNCH_ARGS}`.trim(),
      cwd: request.cwd ?? process.cwd(),
    }).pipe(Scope.provide(session.scope), Effect.provideContext(services));

    // A process that dies without saying so would otherwise hold its slot until the duration cap.
    yield* client.awaitTermination.pipe(
      Effect.catch(() => endSession(session)),
      Effect.forkIn(session.scope),
    );

    const { account } = yield* client.request("account/read", {});
    if (account?.type !== "chatgpt") return yield* fail("notSignedIn");

    const answer = yield* Deferred.make<string, RealtimeVoiceError>();
    yield* client.handleServerNotification("thread/realtime/sdp", ({ sdp }) =>
      Deferred.succeed(answer, sdp).pipe(Effect.asVoid),
    );
    yield* client.handleServerNotification("thread/realtime/error", ({ message }) =>
      Effect.logWarning("Codex realtime call rejected.", { message }).pipe(
        Effect.andThen(Deferred.fail(answer, fail("rejected", message))),
        Effect.andThen(endSession(session)),
      ),
    );
    const transcribe = (final: boolean) => (line: { role: string; text: string }) =>
      request.thread?.transcript({
        role: line.role === "user" ? "user" : "assistant",
        text: line.text,
        final,
      }) ?? Effect.void;
    yield* client.handleServerNotification("thread/realtime/transcript/delta", ({ role, delta }) =>
      transcribe(false)({ role, text: delta }),
    );
    yield* client.handleServerNotification("thread/realtime/transcript/done", transcribe(true));
    yield* client.handleServerNotification("thread/realtime/closed", () => endSession(session));

    const { thread } = yield* client.request("thread/start", {
      ephemeral: true,
      cwd: request.cwd ?? null,
      sandbox: "read-only",
      approvalPolicy: "never",
      ...(request.thread && { config: { "mcp_servers.t3-code": t3McpServer(request.thread) } }),
    });
    yield* Scope.addFinalizer(
      session.scope,
      client.raw.request("thread/realtime/stop", { threadId: thread.id }).pipe(
        Effect.timeout(STOP_TIMEOUT),
        Effect.catch((error) => Effect.logDebug("Codex realtime stop failed.", error)),
      ),
    );
    const instructions = [request.thread?.instructions, input.instructions]
      .filter(Boolean)
      .join("\n\n");
    const voice = request.voice ?? input.voice;
    yield* client.raw.request("thread/realtime/start", {
      threadId: thread.id,
      outputModality: "audio",
      version: "v3",
      ...(voice && { voice }),
      ...(instructions && { realtimeStartInstructions: instructions }),
      transport: { type: "webrtc", sdp: request.sdp },
    });
    return yield* Deferred.await(answer);
  });

  /** Claims a slot atomically so concurrent starts cannot exceed the cap. */
  const register = (sessionId: string, session: Session) =>
    Ref.modify(sessions, (all) =>
      all.size >= MAX_CONCURRENT_CALLS
        ? ([false, all] as const)
        : ([true, new Map(all).set(sessionId, session)] as const),
    );

  const unregister = (sessionId: string) =>
    Ref.update(sessions, (all) => new Map([...all].filter(([id]) => id !== sessionId)));

  const start: ProviderRealtimeVoice["start"] = Effect.fn("CodexRealtimeVoice.start")(
    function* (request) {
      if (!input.enabled) return yield* fail("disabled");
      const sessionId = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => fail("failed", cause)));
      const session: Session = { scope: yield* Scope.make(), done: yield* Deferred.make<void>() };
      // Detached so a closing scope never interrupts the fiber that is closing it.
      const reap = Deferred.await(session.done).pipe(
        Effect.timeoutOption(MAX_CALL_DURATION),
        Effect.andThen(Scope.close(session.scope, Exit.void)),
        Effect.ensuring(unregister(sessionId)),
        Effect.forkDetach,
      );
      yield* reap;
      if (!(yield* register(sessionId, session))) {
        yield* endSession(session);
        return yield* fail("busy");
      }
      const answerSdp = yield* negotiate(session, request).pipe(
        // Bounds the whole handshake: an unresponsive app-server must not hold the slot.
        Effect.timeoutOrElse({
          duration: ANSWER_TIMEOUT,
          orElse: () => Effect.fail(fail("timeout")),
        }),
        Effect.mapError((error) => (isRealtimeVoiceError(error) ? error : fail("failed", error))),
        Effect.onError(() => endSession(session)),
      );
      return { sessionId, answerSdp };
    },
  );

  const stop: ProviderRealtimeVoice["stop"] = (sessionId) =>
    Ref.get(sessions).pipe(
      Effect.flatMap((all) => {
        const session = all.get(sessionId);
        return session ? endSession(session) : Effect.void;
      }),
      Effect.asVoid,
    );

  return {
    supports: (provider) => input.enabled && codexSupportsRealtimeVoice(provider),
    voices: CODEX_REALTIME_VOICE_NAMES,
    start,
    stop,
  } satisfies ProviderRealtimeVoice;
});
