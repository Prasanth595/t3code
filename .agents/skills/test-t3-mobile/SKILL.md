---
name: test-t3-mobile
description: Test T3 Code's native iOS and Android app through its Device panel and returned AgentDevice command. Use for mobile verification, native-client builds, Metro launch, and mobile pairing against isolated development state.
---

# Test T3 Mobile

## Open the device

Call `device_list`, then `device_open` with both `hostId` and `deviceId`.
Prefer a device on `local`; otherwise use a host whose platform is
`available`, preferring a booted device. `device_open` boots the one you pick. A `ready` host with a `detail` warning is usable, and
a null agent `runningVersion` before `device_open` is normal.

Follow the returned `quickStart`. Store `agentDevice.command` in
`agent_device_command` and `targetArgs` in the Bash array
`agent_device_target_args`, and pass both on every AgentDevice call. Shell
variables do not persist between tool calls, so set both at the top of each
command that uses them. Later
steps use the `device.id` that `device_open` returns: an Android AVD name
becomes an `emulator-NNNN` serial when it boots.

AgentDevice runs on this machine and carries each operation to the device
host: `install` uploads a local file and `screenshot` writes a local file.
T3 owns the SSH connection to device hosts, and a host id is a T3 name, not an
SSH target. All work on a remote device goes through AgentDevice.

If a `local` device fails to boot, run the printed emulator command once under
`timeout 30` to read the cause. Report the cause in one line and open a device on another host. Host fixes
such as `/dev/kvm` access are the user's call. Report the blocker and stop
only when no host can open a device. Use only T3's device tools for automation.

## Pick the layout

The **layout** is where the device runs relative to this checkout:

- **Same machine:** the device host is `local`. The device reaches this
  machine's backend and Metro through loopback.
- **Split:** the device host is another machine (SSH or EAS). On the device,
  `127.0.0.1` and `10.0.2.2` point at that host, not here. T3 forwards device
  control only, never Metro or the backend. The Tailscale addresses below
  assume an SSH host on this tailnet; an EAS cloud device needs public Metro
  and backend URLs, so report that blocker when none exist.

## Start an isolated backend

Reuse this task's healthy backend. Otherwise start one from the repository
root with `vp run dev`, adding `--share` for split. Start
each long-running process as its own process group, recorded in a file, and
read ports and URLs from its log. This works on Linux and macOS:

```bash
bash -c 'mkdir -p "$0"; set -m; vp run dev < /dev/null > "$0/backend.log" 2>&1 & echo $! > "$0/backend.pgid"' "$PWD/.t3/mobile-test"
```

The server port and base dir are on the `[dev-runner]` line (`serverPort=`,
`baseDir=`). For split, the backend origin is
the `shared on tailnet:` URL; the printed `pairingUrl` belongs to the user. Use
the worktree's ignored `.t3` state. Never run against `~/.t3/userdata`. The
Browser panel is not required for this workflow.

Test with meaningful project and thread data. Read the shared
[SQLite fixture reference](../test-t3-app/references/sqlite-fixtures.md) only
when inspecting or seeding SQLite. Stop the test server before fixture writes.

## Install T3 Code Dev

Authorized mobile verification includes this step unless the user prohibits it.

**Same machine.** From the repository root, run:

```bash
vp run mobile:install <ios|android> <device-id>
```

This installs the dev client for the checkout's native fingerprint: from the
device, the local cache, or the shared cache in seconds, building once only
when no machine has that fingerprint yet (5-15 minutes, logged to the file it
names). It prints one JSON line; on failure it names the next command.

**Split.** For Android, run AgentDevice `apps`. If it lists
`com.t3tools.t3code.dev` and the change touches no native code, reuse it and
report that its native fingerprint is unverified. Otherwise fetch or build the
client file here, as a background task when it may build, then upload it:

```bash
vp run mobile:install android --artifact --abi arm64-v8a
"$agent_device_command" install com.t3tools.t3code.dev <artifact> "${agent_device_target_args[@]}"
```

`<artifact>` is the `artifact` path in the JSON line. Use `arm64-v8a` for a
`physical: true` phone or an emulator on a host that lists iOS `available` (a
Mac), and `x86_64` for an emulator on a Linux host. If install fails with
`NO_MATCHING_ABIS`, use the other ABI. `install` replaces an existing client and
keeps its pairings; on `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, uninstall it first,
which clears them. iOS works the same way with
`vp run mobile:install ios --artifact` when the local or shared cache has this
fingerprint, or builds it as a background task on an Apple silicon Mac;
otherwise it names the next step.

## Start Metro

Reuse a healthy Metro belonging to this checkout, or start one from the
repository root the same way as the backend:

```bash
bash -c 'mkdir -p "$0"; set -m; (cd apps/mobile && exec vp run dev:client < /dev/null) > "$0/metro.log" 2>&1 & echo $! > "$0/metro.pgid"' "$PWD/.t3/mobile-test"
```

When another process owns port 8081, use a free port and leave that process
running. For split, Metro must advertise this machine's `tailscale ip -4`:

```bash
REACT_NATIVE_PACKAGER_HOSTNAME=<tailscale-ip> bash -c 'mkdir -p "$0"; set -m; (cd apps/mobile && exec vp run dev:client --port <free-port> < /dev/null) > "$0/metro.log" 2>&1 & echo $! > "$0/metro.pgid"' "$PWD/.t3/mobile-test"
```

Open the development client with AgentDevice
`open com.t3tools.t3code.dev <url>` and all target arguments, where the URL is
`t3code-dev://expo-development-client/?url=<encoded Metro URL>&disableAutoLaunch=1&disableFab=1`.
The Metro URL is `http://127.0.0.1:<metro-port>` on a same-machine iOS
Simulator, `http://10.0.2.2:<metro-port>` on a same-machine Android emulator,
and `http://<tailscale-ip>:<metro-port>` for split. The last two parameters
hide developer chrome that blocks screenshots and taps. For a USB Android phone
on this machine, run `adb -s <device-id> reverse tcp:<port> tcp:<port>`
(`adb` is in the Android SDK's `platform-tools`) for the Metro and
server ports, then use `http://127.0.0.1:<port>` for both.

## Pair and verify

Use the helper from the repository root:

```bash
.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  <server-port> <base-dir> <device-reachable-backend-origin> \
  "$agent_device_command" "${agent_device_target_args[@]}"
```

It mints a fresh credential locally and opens T3 Code Dev's existing pairing
route. For same machine, the origin is `http://127.0.0.1:<server-port>` on iOS
and `http://10.0.2.2:<server-port>` on an Android emulator. For split, it is
the `--share` origin.

Confirm the intended projects appear, exercise the affected flow, and capture
evidence. Verify with `snapshot -i` and `wait text "<expected label>"`. If `device_screenshot` fails, run
AgentDevice `screenshot <file>` and read that file.

## Teardown

Keep the app, Metro, and backend running while the user inspects or iterates.
The end of a turn is not teardown. At teardown:

1. Remove the connection you added, the row whose URL is the origin you
   paired: Settings, Environments, `Manage <label>`,
   `Expand details for <label>`, `Remove environment`, then confirm `Remove`.
   On iOS it is the trash button at the end of the expanded row. Leave T3 Code Dev installed for the next run.
2. Run AgentDevice `close` with all target arguments, then call
   `device_close`. Pass `shutdown: true` on EAS hosts, or for a device you
   booted when the user wants it off.
3. Stop each process group you started with
   `kill -TERM -$(cat .t3/mobile-test/<name>.pgid)`, then confirm its ports
   are free.
