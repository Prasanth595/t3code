# Machine map

Fork feature. One portal shows all T3 machines on a map. It controls what each machine can do on the other machines, and their settings. Changes apply at once on online machines and wait in a queue for offline machines. Every action in the portal is also a tool for agents.

The portal is a Cloudflare Worker with one Durable Object, at `t3.yarden-zamir.com`. Each T3 server connects to it when the server setting `machineMap` is on. The setting is off by default.

Requirements have stable numbers. Do not renumber them. Mark a removed requirement "Removed" and keep its number.

## Terms

- **Owner:** the person who signs in to the portal with an allowed email through Cloudflare Access.
- **Machine:** one T3 server (environment) that joined the map, for example Mac, VPS, Windows.
- **Device:** a browser or phone that the owner signs in with. A device is the owner, not a machine.
- **Machine token:** the Cloudflare Access service token of one machine. Cloudflare signs each request of a machine with the token's client id.
- **Arrow:** what one machine can do on another machine: a level and options. An arrow has a direction: "from can use to".
- **Level:** `none`, `read`, `standard` or `admin`. Each level maps to a fixed set of T3 auth scopes.
- **Map role:** what agents on a machine can do on the map itself: `none`, `read`, `propose` or `edit`.
- **Revision:** one numbered, saved change of the map.
- **Desired state:** the part of the map that one machine must apply: its settings, the arrows into it and the arrows out of it.
- **Command:** a one-time action on one machine, for example "restart the server".
- **Queue:** the commands and the desired state that a machine did not apply yet.

## 1. Portal and sign-in

- **MM-101** The portal runs as one Cloudflare Worker with one Durable Object that holds the whole map.
- **MM-102** Cloudflare Access protects the portal. Only the owner email opens the portal pages and the portal API.
- **MM-103** A device signs in once with Cloudflare Access. The session lasts 30 days, like the machine hostnames.
- **MM-104** Machines connect on the path `/connect` only. A separate Access app on that path accepts only machine tokens.
- **MM-105** The portal works when every machine is offline. It shows the last known state of each machine.
- **MM-106** The portal page keeps one WebSocket to the Durable Object. Every change from any source appears on every open page within one second.

## 2. Machines and enrollment

- **MM-201** "Add machine" asks for a name and a kind: laptop, desktop or server. The portal creates a machine token named `t3-machine-<name>`. It adds the token to the Access policies of the machine hostnames and of `/connect`.
- **MM-202** "Add machine" shows a one-time join code. The code expires after 10 minutes and works once. The portal never shows the token secret.
- **MM-203** A machine joins with the code in one of three ways: in T3 Settings > Machines, with `t3 machine-map join <code>`, or with the agent tool `machines_join`.
- **MM-204** The join exchanges the code at `/enroll`, which a bypass Access app leaves open. The response holds the token id and secret. The machine keeps the secret in its server secret store and turns on `machineMap`.
- **MM-205** A new machine shows on the map as "waiting" until its first connection. Then it shows as online.
- **MM-206** The owner can rename a machine, change its kind and icon, and move it on the map. Positions are part of the map and sync to every page.
- **MM-207** "Rotate token" makes a new secret for a machine token. An online machine gets the new secret on its connection, saves it, and confirms. Then the old secret stops working. An offline machine gets the rotation as a queued command.
- **MM-208** "Remove machine" deletes the machine token, removes its arrows and its settings overrides, and drops its queue. A removed machine cannot connect again with its old secret.
- **MM-209** Each machine reports its tunnel hostname. Arrows out of other machines use it to connect.
- **MM-210** Without the Cloudflare API token of MM-1205, "Add machine" takes the client id and secret of an existing machine token, instead of creating one. The join code then delivers that secret.

## 3. Arrows

- **MM-301** Each ordered pair of machines has one arrow. A new pair starts at level `none`.
- **MM-302** The levels map to T3 scopes:
  - `none`: no access.
  - `read`: `orchestration:read`, `filesystem:read`, `terminal:read`, `diagnostics:read`.
  - `standard`: `AuthStandardClientScopes`.
  - `admin`: `AuthAdministrativeScopes`.
- **MM-303** An arrow has the option "agent tools". With it on, agents on the source machine can call T3 tools on the target machine, within the scopes of the level.
- **MM-304** An arrow can expire. "For 1 hour", "for 1 day" and "until a time" set an expiry. At expiry the arrow returns to its earlier permanent level as a new revision made by the portal. A second temporary level keeps the first permanent level.
- **MM-305** The target machine enforces an arrow. A lower level ends the sessions of the source machine on the target at once, including open connections. The source then connects again with the new level, or not at all for `none`.
- **MM-306** The source machine uses an arrow. Its desktop app adds each machine it can reach, with its machine token as request headers. No pairing code is needed.
- **MM-307** "Test" on an arrow makes the source machine connect to the target and report the result: reachable or not, the round trip time, and the scopes it got.
- **MM-308** The owner always keeps full access to every machine through Cloudflare Access. No arrow, preset or lockdown removes it.

## 4. Settings

- **MM-401** The map holds shared values for T3 server settings and client settings. Each machine can override a shared value with its own value.
- **MM-402** A machine applies its settings through the T3 settings service, so they apply live like a change in T3 Settings.
- **MM-403** A desktop machine applies client settings in its desktop app. A closed app applies them at its next start.
- **MM-404** A change made on a machine in T3 Settings becomes an override of that machine in the map. The portal shows it as "changed on <machine>". "Make shared" copies it to all machines.
- **MM-405** The Settings view shows each managed setting as a row and each machine as a column. Values that differ from the shared value show as drift.
- **MM-406** The portal only manages settings that the owner added to the map. "Manage" adds a setting and takes the current value of a chosen machine as the shared value.
- **MM-407** The portal edits each setting with a control for its type: a switch, a choice, a number, text, or a JSON editor for objects. The schema comes from `@t3tools/contracts`.

## 5. Commands

- **MM-501** The portal and agents can send these commands to one machine:
  - **Restart server.** The server exits, and its supervisor starts it again.
  - **Install update.** Install the waiting update now, or "when idle" with the fork rule for running agents.
  - **Stop all agents.** Interrupt every running turn on the machine.
  - **Pause scheduled tasks** and **resume scheduled tasks.**
  - **Reload windows.** Reload the desktop app windows.
  - **Start thread.** Start a thread in a chosen project with a message, like `t3_thread_launch`.
  - **Revoke client.** End one client session on the machine.
  - **Collect diagnostics.** Send a short status bundle to the portal: versions, recent errors, process list and resource use.
  - **Rotate token.** See MM-207.
- **MM-502** Each machine reports which commands it supports. The portal offers only those.
- **MM-503** Each command shows its result in the portal and in the history: who sent it, when, and the outcome.
- **MM-504** Dangerous commands ask for confirmation in the portal: restart server, stop all agents, remove machine, lockdown.

## 6. Queue and offline machines

- **MM-601** A machine that is not connected is offline. The portal shows the time since its last connection.
- **MM-602** A change that touches an offline machine waits for it. The map shows the change at once, and marks the affected machine card, arrow or setting with a "queued" sticker and a count.
- **MM-603** Each machine reports the last revision that it applied. Its desired state is the current map. On connection, the machine applies the current desired state, not each queued revision one by one.
- **MM-604** An arrow with an online target and an offline source shows "applied on <target>, queued for <source>".
- **MM-605** A command for an offline machine waits in its queue. Each queued command has a delivery rule: "when online" or "when online and idle". It also has an expiry, by default 24 hours.
- **MM-606** The owner can cancel a queued command and see why a command expired or failed.
- **MM-607** On start, a machine applies its last saved desired state before it accepts connections from other machines. If the portal is not reachable, it keeps that saved state.
- **MM-608** The Queue view lists every queued change and command of every machine, oldest first.

## 7. History, undo and presets

- **MM-701** Every change makes one revision. A revision records the number, the time, the actor, a one-line summary and the change.
- **MM-702** The actor is the owner with a device name, an agent with its machine and thread, or the portal itself for expiry.
- **MM-703** "Undo" on any revision makes a new revision that reverses it. The history keeps both.
- **MM-704** The history has a time slider. Moving it shows the map at that revision, read only. "Restore" makes a new revision that returns the map to it.
- **MM-705** A preset is a named copy of all arrows. "Save as preset" stores the current arrows. "Apply" makes one revision.
- **MM-706** "Lockdown" is a built-in preset: every arrow becomes `none` and every map role becomes `none`. It is one click with a confirmation.
- **MM-707** "Hold changes" collects changes as a draft. "Apply" makes one revision from the draft. "Discard" drops it.
- **MM-708** "Emergency pause" is a big red button under a flip-up cover. Lifting the cover is the confirmation. One press then does MM-709 and MM-710 in one step. The command palette also opens the button.
- **MM-709** Emergency pause sends "stop all agents" to every machine, with delivery "when online" and an expiry of 7 days. An offline machine stops its agents when it connects again. The pause skips the check of MM-502: a machine without the command reports a failure.
- **MM-710** Emergency pause makes one revision with the summary "Emergency pause": every arrow and every map role becomes `none`, as in lockdown. The portal keeps the arrows and map roles from before the pause. If the map is already locked down, the pause makes no revision. Owner access through Cloudflare Access stays (MM-308).
- **MM-711** While paused, the portal refuses every agent tool call, `machines_read` too. It also refuses every change that raises an arrow or a map role, from any actor. Changes that lower access, settings and commands still work.
- **MM-712** "Resume" is for the owner only and asks for confirmation. It makes one revision that returns the arrows and map roles from before the pause, and ends the pause. It does not start agents again, and queued stop commands stay in the queue. A machine that joined during the pause keeps `none`.
- **MM-713** Every open page shows the pause at once: a hazard frame, the banner "Everything is paused" with who paused and when, and "Resume". The Durable Object stores the pause, so it survives a restart.

## 8. Agents

- **MM-801** Every action in the portal is also a T3 tool on each machine:
  - `machines_read`: the map, presence, arrows, settings, queue and history.
  - `machines_set_access`: set the level, agent tools and expiry of an arrow.
  - `machines_set_setting`: set or clear a shared value or a machine override.
  - `machines_command`: send a command, with a delivery rule and expiry.
  - `machines_queue_cancel`: cancel a queued command.
  - `machines_undo`: undo a revision.
  - `machines_preset`: save or apply a preset, or lock down.
  - `machines_join`: join this machine to the map with a join code.
  - `machine_tool_call`: call a T3 tool on another machine.
- **MM-802** A tool works when the machine that runs the agent has the map role for it:
  - `read`: `machines_read`.
  - `propose`: every change becomes a proposal for the owner. A proposal holds only map changes, so `machines_command` and `machines_queue_cancel` need `edit`.
  - `edit`: changes apply at once.
  - `machine_tool_call` needs an arrow with "agent tools" to the target machine.
- **MM-803** An agent can never raise access for its own machine. That change always becomes a proposal, whatever the map role.
- **MM-804** Proposals wait in the Inbox of the portal. The owner approves or rejects each one. A proposal expires after 24 hours.
- **MM-805** The machine runs each agent tool through its portal connection with its own machine token. The portal checks the map role on every call.
- **MM-806** Each agent change shows in the history with the machine, the thread title and a link to the thread.

## 9. Devices

- **MM-901** The Devices view lists the owner sign-ins from Cloudflare Access: device, browser, place and last use.
- **MM-902** The Devices view also lists the T3 client sessions on each machine, from the machine status.
- **MM-903** "Sign out" on a T3 session sends "revoke client" to its machine. "Sign out everywhere" ends all owner sign-ins in Cloudflare Access and all owner T3 sessions on online machines. Offline machines get it as a queued command.

## 10. Presence and status

- **MM-1001** Each machine reports its status on connection and on each change, at most once every 5 seconds. Liveness uses WebSocket ping and pong that does not wake the Durable Object.
- **MM-1002** The status holds: T3 version, build (live commit or release), uptime, running turns, threads that wait for the owner, scheduled tasks, waiting update, CPU and memory use, and supported commands.
- **MM-1003** A machine card shows online or offline, the build, and stickers for running agents, threads that wait for the owner, a waiting update, and queued items.
- **MM-1004** "Open" on a machine opens its T3 web app at its tunnel hostname.

## 11. Portal UI

- **MM-1101** The portal uses the tick3d style in light and dark mode, as in the `neo-brutalism` skill. It works on a phone and on a desktop.
- **MM-1102** Views: Map, Table, Settings, Queue, History, Inbox, Devices. The selected item opens in a side panel, or in a bottom sheet on a phone.
- **MM-1103** The Map view draws one line per pair of machines. A card on each line shows both directions in words, with arrows rounded to the four directions of the map. Tapping a machine focuses it and fades the lines that do not touch it.
- **MM-1104** Dragging from a machine to another machine opens their arrow.
- **MM-1105** The command palette, opened with Cmd+K or Ctrl+K, finds every action and every machine.
- **MM-1106** Each view and each selected item has its own link, so a link opens the same state.
- **MM-1107** The portal has no continuous animation. A change plays at most one short transition.

## 12. Security

- **MM-1201** The Durable Object stores no token secret at rest. During a join (MM-204) and a rotation (MM-207), it keeps the secret encrypted with a Worker secret. It deletes the secret when the machine takes it, or when the code or rotation expires.
- **MM-1202** A machine gets only its own desired state, its own queue and the public facts of other machines: name, kind, hostname, presence and the arrows that touch it.
- **MM-1203** Every write records its actor. The portal refuses writes from a machine without the map role for them.
- **MM-1204** `/enroll` limits attempts per address and refuses expired or used codes.
- **MM-1205** The Worker keeps one Cloudflare API token as a secret. The token can only edit Access service tokens and Access apps.
- **MM-1206** A machine trusts the Cloudflare Access JWT header only because its T3 server listens on loopback behind its tunnel, as the fork login already requires.

## 13. T3 server

- **MM-1301** The server setting `machineMap` holds `enabled` and the portal URL. It is off by default. Off means no connection and no change to auth.
- **MM-1302** The machine token secret lives in the server secret store, never in `settings.json`.
- **MM-1303** The server keeps one outbound WebSocket to `/connect`, with backoff after a failure.
- **MM-1304** The server saves the last desired state in its user data, so MM-607 works after a restart.
- **MM-1305** For a request with a valid Cloudflare Access JWT of a machine token, the server looks up the arrow from that machine. It issues the session with the scopes of the level and the subject `machine:<id>`. Level `none` refuses the request.
- **MM-1306** When the level of an arrow into the server changes, the server revokes every session with the subject of the source machine.
- **MM-1307** The server accepts T3 tool calls from a machine session only when its arrow has "agent tools".
- **MM-1308** Fork code lives in new files. Changes to upstream files are small hooks, and each hook has a test.

## 14. Desktop app

- **MM-1401** The desktop app gets the list of machines it can reach from its own server. It adds each one to its saved environments with the machine token headers, and removes it when the arrow drops to `none`.
- **MM-1402** The desktop app applies queued client settings and commands for windows when it starts.

## Later

These ideas are not in scope yet:

- Wake an offline laptop or desktop through another machine on the same network.
- Scheduled presets, for example "at night, Windows cannot use Mac".
- Push notifications from the portal to the phone: a machine went offline, a proposal waits, a command failed.
- Groups on the map, for example "home" and "cloud".
