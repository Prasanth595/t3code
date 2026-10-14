# Machine map portal

Fork feature. The portal shows every T3 machine on one map and controls what each machine can do on the others. [SPEC.md](SPEC.md) holds the numbered requirements (MM-xxx). The shared types live in `packages/contracts/src/machineMap.ts`.

The portal is one Cloudflare Worker with one Durable Object, at `t3.yarden-zamir.com`.

## Code

- `src/worker.ts`: routes, Cloudflare Access checks, request decoding.
- `src/MachineMapObject.ts`: the Durable Object. It stores the map in SQLite, keeps the sockets, runs the alarms and calls Cloudflare.
- `src/rules/`: pure rules with tests: changes and their inverse, desired state, map roles, self-escalation, queue, presets and lockdown.
- `src/api.ts`: request and response shapes of the HTTP API, shared by the Worker and the page.
- `src/ui/`: the React page.
- `src/sw/sw.ts`: the service worker of the installed app (MM-1801 to MM-1808). `vite.config.ts` builds it to `dist/sw.js` and writes the file list of the build into it.
- `src/push.ts`: Web Push with Web Crypto: the VAPID JWT and the `aes128gcm` encryption (MM-1807).
- `public/`: the favicon, the app icons, the web app manifest and the offline page. The PNG icons are `favicon.svg` rendered at each size; the full-bleed ones (`apple-touch-icon.png`, `icon-maskable-512.png`) put it on the canvas colour with a margin.

## Set up Cloudflare Access

Create these Access apps before the first deploy:

1. **Portal pages and API.** Self-hosted app for `t3.yarden-zamir.com`, session duration 30 days (MM-103). Allow only the owner email. Copy its audience tag into `PAGE_AUD` in `wrangler.jsonc`.
2. **Machine connections.** Self-hosted app for `t3.yarden-zamir.com/connect`. Give it no identity login. The portal adds a "Service Auth" policy named `t3 machine map tokens` for the machine tokens. Copy its audience tag into `CONNECT_AUD` and its app id into `CONNECT_ACCESS_APP_ID`.
3. **Enrollment.** Self-hosted app for `t3.yarden-zamir.com/enroll` with one Bypass policy for everyone. The join code is the credential (MM-204).

`MACHINE_ACCESS_APP_ID` is the Access app of the machine hostnames. The portal adds each new machine token to its `t3 machine map tokens` policy and edits no other policy. It also adds and removes the hostname of each machine tunnel (MM-213). That update sends back the whole app with its policies, and the portal checks that the app keeps each policy.

`MACHINE_DOMAIN` and `MACHINE_ZONE_ID` in `wrangler.jsonc` name the DNS zone of the machine hostnames. A new machine gets `t3-<slug>.<MACHINE_DOMAIN>`.

The Worker refuses every owner and machine request while a value in `wrangler.jsonc` starts with `REPLACE_`.

## Secrets

Set secrets with `wrangler secret put <NAME>` in this folder.

- `SECRET_KEY` (required for joins and rotations). The AES-GCM key that encrypts a token secret while it waits for its machine (MM-1201). Make it with `openssl rand -base64 32`. A new key makes waiting join codes and rotations unreadable. Make new join codes after you change it.
- `CF_API_TOKEN` (optional, MM-1205). A Cloudflare API token with "Access: Service Tokens Edit", "Access: Apps and Policies Edit" and "Cloudflare Tunnel: Edit" on the account, and "DNS: Edit" on the zone of `MACHINE_ZONE_ID`. With it, "Add machine" creates the machine token and its tunnel (MM-213), "Rotate token" works, "Remove machine" deletes what "Add machine" made, and the Clients view lists Access sessions. Without the tunnel and DNS permissions, "Add machine" makes no tunnel and the join dialog says why. Without the token, "Add machine" takes the client id and secret of an existing machine token (MM-210). Then delete removed tokens in the Zero Trust dashboard yourself.
- `MACHINE_ACCESS_SUBJECTS` (optional, MM-213). Access subjects that a joined machine allows next to the owner emails, comma separated, for example the client id of the desktop service token. A secret keeps the client id out of the repository.

- `VAPID_JWK` (optional, MM-1807). The P-256 private key that signs push messages, as a JSON Web Key. Without it, push is off and the Clients view says so. Make it and set it in one step:

  ```sh
  node -e 'const { generateKeyPairSync } = require("node:crypto"); console.log(JSON.stringify(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" })))' | ./node_modules/.bin/wrangler secret put VAPID_JWK
  ```

  A new key turns off the push subscription of every device. Turn notifications on again in the Clients view of each device.

## Deploy

1. Run `vp i` at the repository root.
2. Run `vp run deploy` in this folder. It builds the page into `dist` and runs `wrangler deploy`.

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
