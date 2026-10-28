# Experimental Apple Watch companion

The companion is a local-development feature, not a verified App Store release.
Enable its native target explicitly with `T3_WATCH_COMPANION=1`. Keep this flag
consistent when generating, building and installing the iOS development client.
Do not interpret successful JavaScript tests, Swift parsing or Xcode-project
generation as proof of an installable or functioning Watch app.

## Current scope

- Watch captures new ideas and thread-bound voice replies without the iPhone
  nearby. Audio is retained locally until durable iPhone receipt or explicit
  deletion; recording is limited to three minutes and 32 retained captures.
- The iPhone inbox offers local transcription and an explicit handoff into the
  existing new-thread or reply composer. The user still selects the destination
  and sends. Titling follows the existing thread flow after submission; the
  Watch does not independently generate a title.
- Opt-in snapshots expose up to 20 cached thread titles, project names, statuses
  and pending-request types. They deliberately omit message bodies and secrets.
- Mark-done and reopen requests require iPhone confirmation and use existing
  guarded server commands. Questions and permissions open full iPhone review;
  no Watch action directly authorizes a tool or answers a request.
  Unlike audio captures, these requests currently require T3 open on a reachable
  iPhone. Once accepted, they are persisted natively before acknowledgement and
  imported into the durable review inbox when React Native is ready.
- The Watch uses the paired iPhone as its bridge. The iPhone uses its existing
  environment connection, including T3 Connect where configured. The Watch has
  no separate server credential or direct Mac connection.

This is not yet the full automatic capture-to-agent workflow. Transcription runs
on the iPhone, not offline on the Watch, and handoff is not proof of submission.
No Watch delivery acknowledgement promises that an agent has started work.

## Contribution and next stages

This prototype is local and opt-in. Follow the repository's contribution process
and obtain maintainer approval for the feature before proposing an upstream PR.
Keep generated Xcode projects, signing material and private device evidence out
of the contribution.

1. Pass the paired Ultra 2 acceptance gate below and validate clean signed
   iOS/watchOS builds, accessibility and lifecycle recovery.
2. Add an explicit destination/model selection and durable submission receipt
   before replacing composer handoff with a confirmed create-and-start action.
   Preserve command IDs across lost acknowledgements and distinguish received,
   transcribed, awaiting review, submitted and failed states.
3. Only then consider per-destination opt-in automatic submission. Respect iOS
   background execution constraints, revocation and sign-out; retain audio and
   surface a retryable inbox state when processing cannot run.
4. Expand supported Watch sizes and versions after physical Ultra 2 evidence.
   Broader device support must not weaken the same ownership and review guards.

## Ultra 2 first-device gate

Use a paired physical iPhone and Apple Watch Ultra 2 before widening device
support. Record their actual iOS/watchOS versions with the evidence. The first
offline-capture check does not need a running T3 environment, but transcription
needs an iPhone supported by the existing local transcriber and its language
assets. If unavailable, keep the recording rather than substituting a cloud
transcriber or sending an empty message.

Use full Xcode with the appropriate iOS/watchOS SDKs and a signing team that can
install both apps. The Command Line Tools installation alone cannot build this
target. On Ultra 2 running watchOS 26 or later, use standard architectures, not a
hard-coded `arm64_32` architecture. Store submission additionally requires the
applicable current Apple SDK and signing requirements.

```sh
xcodebuild -version
xcodebuild -showsdks
vp i
cd apps/mobile
T3_WATCH_COMPANION=1 APP_VARIANT=development vp exec expo prebuild --clean --platform ios --no-install
```

Open the generated iOS workspace in Xcode and select the paired Ultra 2 run
destination and the companion scheme. Resolve signing for the iPhone and Watch
targets without changing the production bundle IDs or committing provisioning
profiles. A changed native fingerprint requires a rebuilt development client;
a Metro refresh or over-the-air update cannot install a Watch target or a new
native module. Follow the [mobile test workflow](../../.agents/skills/test-t3-mobile/SKILL.md)
for supported device tooling and isolated T3 state.

Test the generated project after a clean prebuild too: the plugin, not manual
edits to the generated Xcode project, must recreate the target and embed phase.
Keep the existing app variant's bundle ID, team and deployment settings intact.
Disabling the flag also requires a clean prebuild: skipping the plugin cannot
remove a Watch target left in a previously generated native directory.

## Background receipt is not background execution

The iPhone's native WatchConnectivity delegate owns receipt even when React
Native has not mounted. Incoming files have temporary URLs: persist audio and
metadata synchronously before the receive callback returns. Acknowledge only
after durable storage. Watch audio may then be released, but iPhone audio must
remain available until review or deliberate deletion.

Transcription, navigation and guarded T3 commands are separate stages. The
first slice uses iPhone review; it does not promise autonomous agent launch
while iOS has suspended or force-quit the app. A Watch action received by the
phone is not evidence that a thread was resolved, a response delivered or a tool
approved. Permission requests requiring full context must open the established
iPhone review flow, never approve from a truncated Watch notification.

Snapshots contain bounded thread context, not credentials. Reply recordings
retain their original environment and thread IDs across reconnects. Account
switches must clear published snapshots and must not claim another account's
pending replies or decisions. A cached Watch screen is not authoritative live
state. The host remains responsible for permissions and current-state guards.

## Physical acceptance checklist

Before device testing, run the focused checks from the repository root:

```sh
vp test run apps/mobile/src/features/watch-companion/inbox.test.ts
sh apps/mobile/modules/t3-watch-bridge/tests/run-native-tests.sh
node --test apps/mobile/plugins/lib/watchCompanionTarget.test.cjs
vp run check:changed
```

The native script exercises Foundation storage and wire contracts on macOS and
parses the platform sources; it does not typecheck against Apple Watch SDKs.
The Watch and bridge sources are included in the mobile SwiftLint configuration.
The full `vp run lint:mobile` also requires the tools in `apps/mobile/Brewfile`.

- Start recording with the phone unavailable, lower the wrist, stop and relaunch
  the Watch app. Confirm the audio is retained and pending status is accurate.
- Reconnect with the iPhone locked, then compare foreground, suspended and
  force-quit app behavior. Confirm eventual durable receipt without claiming a
  processing deadline that iOS does not guarantee.
- Interrupt delivery and restart each app around receipt/acknowledgement. Confirm
  one inbox item, no early deletion and no overwritten conflicting recording.
- Transcribe and review a new idea. Open the existing creation flow, choose its
  destination and send explicitly. Confirm one thread and the normal title flow.
- Record a reply from a cached thread. Confirm it remains bound to that thread,
  and does not silently send to the active/default thread after reconnection.
- Request mark-done while the thread acquires new work. Confirm server rejection
  leaves the agent running and queued work untouched.
- Request mark-done from an older cached Watch snapshot after the thread changes
  to a newer idle state. Confirm the original Watch version is retained through
  native receipt and cold-start import, and iPhone confirmation rejects it as
  stale rather than substituting the import-time thread version.
- Answer or approve on desktop while the Watch still shows the older request.
  Confirm stale Watch actions cannot answer or authorize a replacement request.
- Sign out/switch account, revoke environment access and remove a destination.
  Confirm cached context is cleared and pending work is not silently reassigned.
- Exercise microphone denial, interrupted recording, unsupported language,
  transcription failure, storage limits, VoiceOver and large text on Ultra 2.

WatchConnectivity file transfer needs physical paired-device evidence; Simulator
screenshots do not establish delivery reliability. Keep device-test evidence
outside the repository, and state exactly which conditions were verified.
