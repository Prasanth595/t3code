# Machine map portal

Fork feature. The portal shows every T3 machine on one map and controls what each machine can do on the others. [SPEC.md](SPEC.md) holds the numbered requirements (MM-xxx). The shared types live in `packages/contracts/src/machineMap.ts`.

The portal is one Cloudflare Worker with one Durable Object, at `t3.yarden-zamir.com`.

## First-time setup

Do these steps once, in this order.

### 1. Create the API token

In the Cloudflare dashboard, go to **My Profile** > **API Tokens** > **Create Token** > **Create Custom Token**. Add these permissions:

| Permission                                                 | Scope                     | What the portal does with it                                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access: Service Tokens Edit                                | Account                   | "Add machine" creates the machine token, "Rotate token" works, and "Remove machine" deletes the token (MM-1205).                                                                                                                                                       |
| Access: Apps and Policies Edit                             | Account                   | The portal adds machine and app tokens to the policies of the Access apps. "Set up approvals" creates the approval app, the `/client` app and the App Launcher app.                                                                                                    |
| Access: Organizations, Identity Providers, and Groups Edit | Account                   | Approvals read the Zero Trust organization (MM-1207). "Set up approvals" allows the passkey MFA methods. Edit includes Read. Edit can also change every other organization setting, such as login design and session lengths. With only Read, do the MFA step by hand. |
| Access: Organizations Revoke                               | Account                   | "Sign out everywhere" ends Access sessions (MM-903). Without it, it ends only T3 sessions, and "Set up approvals" names the missing permission.                                                                                                                        |
| Cloudflare Tunnel: Edit                                    | Account                   | "Add machine" creates the machine tunnel (MM-213).                                                                                                                                                                                                                     |
| DNS: Edit                                                  | Zone of `MACHINE_ZONE_ID` | "Add machine" adds the CNAME of the tunnel.                                                                                                                                                                                                                            |

Without the tunnel and DNS permissions, "Add machine" makes no tunnel and the join dialog says why. With the token, the Clients view lists Access sessions. Without the token, "Add machine" takes the client id and secret of an existing machine token (MM-210). Then delete removed tokens in the Zero Trust dashboard yourself. When the token lacks a permission for a step, the portal shows the manual step with links and the name of the permission (MM-1209).

### 2. Set the secrets

Sign in once with `./node_modules/.bin/wrangler login` in this folder. Set each secret with `./node_modules/.bin/wrangler secret put <NAME>`, and paste the value when it asks.

- `SECRET_KEY` (required for joins and rotations). The AES-GCM key that encrypts a token secret while it waits for its machine (MM-1201). Make it and set it in one step:

  ```sh
  openssl rand -base64 32 | ./node_modules/.bin/wrangler secret put SECRET_KEY
  ```

  A new key makes waiting join codes and rotations unreadable. Make new join codes after you change it.

- `VAPID_JWK` (optional, MM-1807). The P-256 private key that signs push messages, as a JSON Web Key. Without it, push is off and the Clients view says so. Make it and set it in one step:

  ```sh
  node -e 'const { generateKeyPairSync } = require("node:crypto"); console.log(JSON.stringify(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" })))' | ./node_modules/.bin/wrangler secret put VAPID_JWK
  ```

  A new key turns off the push subscription of every device. Turn notifications on again in the Clients view of each device.

- `CF_API_TOKEN` (optional, MM-1205). The token of step 1.
- `MACHINE_ACCESS_SUBJECTS` (optional, MM-213). Access subjects that a joined machine allows next to the owner emails, comma separated, for example the client id of the desktop service token. A secret keeps the client id out of the repository.

### 3. Create the Access apps

In Zero Trust, go to **Access controls** > **Applications** and create these self-hosted apps:

1. **Portal pages and API.** For `t3.yarden-zamir.com`, session duration 30 days (MM-103). Allow only the owner email. Copy its audience tag into `PAGE_AUD` in `wrangler.jsonc`.
2. **Machine connections.** For `t3.yarden-zamir.com/connect`. Give it no identity login. The portal adds a "Service Auth" policy named `t3 machine map tokens` for the machine tokens. Copy its audience tag into `CONNECT_AUD` and its app id into `CONNECT_ACCESS_APP_ID`.
3. **Enrollment.** For `t3.yarden-zamir.com/enroll`, with one Bypass policy for everyone. The join code is the credential (MM-204). This app also covers the app invite path `/enroll/client` (MM-913).

Then check the other values in `wrangler.jsonc`:

- `TEAM_DOMAIN` is the team domain of the Zero Trust organization, `<team>.cloudflareaccess.com`. `OWNER_EMAILS` and `ACCOUNT_ID` name the owner and the account.
- `MACHINE_ACCESS_APP_ID` is the Access app of the machine hostnames. The portal adds each new machine token to its `t3 machine map tokens` policy, and each app token of a native client to its `t3 client tokens` policy (MM-911). It edits no other policy. It also adds and removes the hostname of each machine tunnel (MM-213). That update sends back the whole app with its policies, and the portal checks that the app keeps each policy.
- `MACHINE_DOMAIN` and `MACHINE_ZONE_ID` name the DNS zone of the machine hostnames. A new machine gets `t3-<slug>.<MACHINE_DOMAIN>`.

The Worker refuses every owner and machine request while a value in `wrangler.jsonc` starts with `REPLACE_`.

### 4. Deploy

Merge the `wrangler.jsonc` values to main. The workflow deploys the portal, see [Deploy](#deploy).

### 5. Set up approvals (MM-1207, MM-1208)

Open `https://t3.yarden-zamir.com`, go to Clients, and select "Invite an app". Select "Set up approvals" in the dialog. A waiting sign-in shows the same button. It does these steps itself, and skips each step that is done already:

- It allows "Biometrics" (a passkey such as Touch ID or Face ID) and "Security key" in **Access controls** > **Access settings** > **Allow multi-factor authentication (MFA)**. It keeps the other organization settings and does not turn on **Apply global MFA settings by default**.
- It creates the App Launcher app with an Allow policy for the owner emails. Cloudflare needs the App Launcher to register a passkey.
- It creates the Access app of `t3.yarden-zamir.com/api/grant` with the owner emails, a 10-minute session and independent MFA.
- It creates the Access app `t3 portal client tokens` for `t3.yarden-zamir.com/client` (MM-914). It lets in any service token of the account, and the Worker answers only for a token that a client holds.

Registering the passkey stays manual. The first approval asks for it. To register it before, open `https://super-bird-2876.cloudflareaccess.com/AddMfaDevice`. "Confirm with passkey" opens a Cloudflare page that asks for the passkey, not a browser prompt.

## Client access

The server setting `clientAccess` (MM-916) decides which browsers get in through Cloudflare Access. Turn it on in this order:

1. Update every machine to a build that knows `enforce`. An older machine skips the value, while the portal shows it as set.
2. Set `observe` on every machine.
3. In the Clients view, select "Sign out everywhere" (MM-903). Open sessions send no key, so they must sign in again.
4. Sign in once on each device. Approve each waiting key in the Clients view, and check its arrows.
5. Set `enforce` on one machine first. Open it from each device. Then set `enforce` on the other machines.

If `enforce` locks a browser out, use one of these ways back in:

- On a machine with a desktop app, the desktop app always gets in. In its Settings > Machines, set "Client access" to `observe` or `off`. The change reaches the portal also after a restart, and the portal sends a push message.
- On a headless machine, set `clientAccess` in the portal Settings view. Without the portal, connect with SSH. Then set `"clientAccess": "off"` in its `settings.json`, or run `t3 pair` and open the pairing link.
- Pairing links keep working on every machine.

## Keybinding sync

MM-414 holds the rule. These are the effects for the owner:

- The shared value replaces the whole `keybindings.json` on each machine, so rules that only one machine had go. To keep a rule on one machine only, save it there for one environment.
- A sync turned on from the portal, or in the same change as a `keybindings` value, makes the shared value win. A sync turned on in T3 Settings first reports the file of each machine. With a shared value present, those rules become the own value of that machine (MM-404). Clear that own value in the portal to follow the shared value.
- A machine writes only a value that differs from the previous desired state. A start or a change of another setting does not write. A default rule that an update adds at start thus stays in the file, and the machine reports it as its own value. Use "Make shared" to share it.
- A `keybindings.json` that is not a JSON array stays as it is, with a warning in the server log. Fix the file by hand.
- With the sync off on the primary environment, a save with "All environments" shares nothing and shows a notice.
- A machine skips rules with a command that it does not know, and shows the "Invalid keybindings configuration" notice. A keybinding saved on that machine drops them from its own file.
- A machine on a build without keybinding sync logs `keybindings` as a setting that does not apply, and does not change its file.

## Desktop app on the map

MM-1401 and MM-1402 hold the rules. The desktop app acts only while its own server is joined, because only then does the server send it the token headers.

- It pairs each machine environment through `/api/auth/cloudflare-access/pairing-credential`, with the machine token as request headers for that origin only. It pairs again once when the target ends the session after a level change.
- It reports its current client settings. The server leaves out values that equal the desired ones, so the map does not see its own writes as local changes.
- It reports the result of `reloadWindows` and `installUpdate` before it acts. `installUpdate` "when idle" uses the install-when-idle wait. It also reports the version of a waiting update.

## Code

- `src/worker.ts`: routes, Cloudflare Access checks, request decoding.
- `src/MachineMapObject.ts`: the Durable Object. It stores the map in SQLite, keeps the sockets, runs the alarms and calls Cloudflare.
- `src/rules/`: pure rules with tests: changes and their inverse, desired state, map roles, self-escalation, queue, presets and the changes of the emergency pause.
- `src/api.ts`: request and response shapes of the HTTP API, shared by the Worker and the page.
- `src/ui/`: the React page.
- `src/sw/sw.ts`: the service worker of the installed app (MM-1801 to MM-1808). `vite.config.ts` builds it to `dist/sw.js` and writes the file list of the build into it.
- `packages/shared/src/webPush.ts`: Web Push with Web Crypto: the VAPID JWT and the `aes128gcm` encryption (MM-1807). The T3 server uses it too.
- `public/`: the favicon, the app icons, the web app manifest and the offline page. The PNG icons are `favicon.svg` rendered at each size; the full-bleed ones (`apple-touch-icon.png`, `icon-maskable-512.png`) put it on the canvas colour with a margin.

## Deploy

Merge to main. The workflow "Machine map deploy" (`.github/workflows/fork-machine-map-deploy.yml`) tests and deploys the portal when `apps/machine-map` or the contracts it reads change. It needs the GitHub secret `CLOUDFLARE_DEPLOY_TOKEN`, a Cloudflare API token with "Workers Scripts: Edit" and "Workers Routes: Edit". Do not deploy by hand: a deploy from a branch rolls back main.

## Develop

1. Put `SECRET_KEY=<base64 key>` in `.dev.vars` in this folder. Git ignores the file.
2. Run `vp run dev` in this folder. Open `http://localhost:8787`.
3. To test push, also put `VAPID_JWK=<JSON Web Key>` in `.dev.vars`. `localhost` counts as a secure origin, so the service worker and push work there.

Local development skips the Access JWT: `DEV_FAKE_ACCESS=1` on a loopback hostname makes every page request the first owner email. A fake machine sends the header `X-Dev-Machine-Client-Id` with its token client id. Production never sets the variable.

## Machine protocol notes

The T3 server side follows `machineMap.ts`. These details are not in the types:

- Join: `POST /enroll` with `{ "code": "K7QM-2XPA" }`. The answer is `EnrollResponse` in `src/api.ts`. Its `tunnel` is `MachineTunnelGrant` from the contracts, or null. It holds the tunnel token: never log it. Each code works once. Ten attempts per address in 15 minutes.
- Connect: open a WebSocket to `wss://t3.yarden-zamir.com/connect` with the headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Send `hello` first. A new connection closes the older one of the same machine (code 4000). A removed machine gets code 4004.
- Liveness: send the text `ping`. The portal answers `pong` without waking the Durable Object (MM-1001).
- Tool calls: `toolResult.result` has the shape `MapToolResult` in `src/api.ts`. A write answers `applied` with a revision, or `proposed` with a proposal id.
- Emergency pause (MM-711): while the portal is paused, every `toolCall` gets `toolResult` with `ok: false` and an error that says so.
- Rotation: the old secret works until the machine sends `rotated`, or until the rotation expires after 24 hours. A machine that stays offline past that needs a new join code.

## Limits

- A page gets the newest 100 revisions. Queued counts come from those, so a machine that missed more shows at most 100. Revisit when one machine stays offline across more than 100 changes.
- The history links an agent change to the T3 app of its machine, not to the thread itself. The thread route needs the T3 environment id, which `MachineStatus` does not report yet.
