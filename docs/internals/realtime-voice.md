# Realtime voice calls

A voice call is a WebRTC session between the client and the provider's realtime API. The T3 server
only brokers the SDP offer and answer, so audio never passes through it and every connection mode
(local, relay, tunnel) behaves the same.

## Shape

- [`RealtimeVoice`](../../apps/server/src/provider/RealtimeVoice.ts) is provider-agnostic. It
  resolves the provider instance and delegates to its optional `realtimeVoice`
  ([`ProviderRealtimeVoice`](../../packages/provider-core/src/server/driver.ts)): `supports`,
  `start`, `stop`. A new provider adds a call capability by implementing that interface on its
  driver; nothing else changes. The call's chat (the subagent thread, its tool access and its
  transcript) lives apart in
  [`RealtimeVoiceChat.ts`](../../apps/server/src/provider/RealtimeVoiceChat.ts).
- `ProviderRegistry` stamps `supportsRealtimeVoice` onto every snapshot from `supports`, so clients
  gate the button on the snapshot and never on a driver name or auth type.
- The call controller ([`call.ts`](../../packages/client-runtime/src/voice-call/call.ts)) lives in
  `client-runtime` and takes its platform (microphone, peer connection, playback) as a dependency.
  Web uses the browser globals; mobile needs a native WebRTC stack before it can supply one.

A call started from a saved thread opens its own chat as a subagent of that thread (`thread.create`
with the server-only `parentThreadId`, so the chat lists under its parent), and the voice agent does
the user's work there through T3's MCP tools; it reads the origin thread for context. `RealtimeVoice`
issues the call a credential for the chat and hands the provider the endpoint, instructions, and the
tools to pre-approve. The provider must run the credential's `release` when the call ends.

- The credential is issued with `call: true`. A thread's provider session revokes every credential
  for its thread when it starts a turn, which would otherwise kill the call the first time the voice
  agent sends the chat a message; only the call's own end revokes a call credential.
- A call credential also counts as a live caller for the tools that need one. The chat is idle (it
  has no run), yet the voice agent must message the origin thread; the credential's lifetime is the
  call, so liveness adds nothing.
- Spoken lines (`thread/realtime/transcript/delta` and `done` for Codex) reach the chat through the
  provider's `transcript` callback and the internal `voice_transcript.record` command: a message and
  turn item with no run, so nothing runs for them. Fragments accumulate per role in
  `RealtimeVoice`, and each command replaces the same message until the final text settles it.
- The call chat belongs to the call's account (its default Codex model unless one is chosen), not
  to the parent's provider: a subagent's provider is free, only lineage is shared. The thread's
  `voiceCall` marker, set only by the server, records the account and tells the voice agent which
  one it speaks through. The realtime session itself is not a thread and has no model of its own;
  the app-server has no way to inject typed text into it, so typing in the chat reaches the chat's
  agent only.
- One `AudioContext` analyser per stream feeds `VoiceCall.levels`, the per-band loudness of the
  microphone and the answering voice. Icons draw bars from it directly, outside React state, and
  the `speaking` flag derives from the same levels, so there is one signal for every icon.
- The live call is a module-level store in the web client, not component state, so it survives
  switching chats. Starting a call anywhere ends the one in progress, and the sidebar row of the
  thread it belongs to shows it.

Calls are deliberately not an MCP tool, command-palette action, or keybinding: they need a live
microphone owned by the client that is looking at the thread.

## Codex

[`CodexRealtimeVoice.ts`](../../apps/server/src/provider/CodexRealtimeVoice.ts) uses the
app-server's experimental `thread/realtime/*` methods, the only path that bills a ChatGPT
subscription instead of an API key. Traps:

- **One app-server per call.** Realtime is gated behind `--enable realtime_conversation` and the
  call lives as long as the process, so the process is the session scope. Calls per instance are
  capped because each spawns the user's MCP servers.
- **Force the ChatGPT login.** `forced_login_method=chatgpt` plus an `account/read` check stop an
  API key from silently turning the call into metered usage. The WebSocket transport rejects
  subscription auth; only `webrtc` works.
- **No trickle ICE.** The offer must already contain its candidates, so the client waits for ICE
  gathering before sending it.
- **The backing thread can run tools.** v3 delegates to a Codex thread and the public API cannot
  disable its tools. The thread is ephemeral, read-only, and never asks for approval.
- **Secure context.** `getUserMedia` needs HTTPS or localhost, so a plain `http://` LAN origin
  cannot start a call.
- **Don't send a model.** Overriding `session.model` is rejected for ChatGPT-authenticated sessions.
- **Managed Codex accounts** do not expose voice yet; only the standard driver does.

`thread/realtime/*` requests go through `client.raw` because the vendored schema generator
predates them.
