# Move a fork server to the upstream service

This guide moves a headless fork server to the upstream background service (`t3 service install`). After the move, the server updates itself from the fork releases ([fork.md "Server updates"](fork.md#server-updates)). Move the Oracle machine first. Move the VPS only after the Oracle machine works for a day.

Each part has a way back. The data in `~/.t3` stays in place, so the way back needs no copy, except when the new version changed the database. The backup step covers that case.

## Before you start

1. Make sure that these pull requests are merged: "update servers from fork releases on every push" (#106) and "auto-update service servers when idle" (#107).
2. Make sure that a fork release has `SHA256SUMS`. This command prints a number above 0:

```sh
curl -fsSL "https://api.github.com/repos/Yarden-zamir/t3code/releases?per_page=5" | grep -c '"name": "SHA256SUMS"'
```

3. In the portal, check that no agent turn runs on the machine. If one runs, wait, or use "Stop all agents". The move restarts the server.

## Oracle machine

The Oracle machine runs the earlier fork installer: the user service `t3code-fork.service` and the release in `~/.local/share/t3code-fork-server`.

### Move

Run these steps over SSH as the normal user, for example `ubuntu`. Do not use `sudo` or `su`.

1. Record the current state:

```sh
mkdir -p ~/t3-migration && cd ~/t3-migration
systemctl --user cat t3code-fork.service > t3code-fork.service.txt
ls ~/.config/systemd/user/t3code-fork.service.d/ > drop-ins.txt 2>&1
readlink ~/.local/share/t3code-fork-server/current > old-version.txt
```

2. Stop the old server and back up the database and the settings:

```sh
systemctl --user stop t3code-fork.service
cp -a ~/.t3/userdata/*.sqlite* ~/.t3/userdata/settings.json ~/t3-migration/
```

3. If `drop-ins.txt` lists `tunnel.conf`, copy it to the new service:

```sh
mkdir -p ~/.config/systemd/user/t3code.service.d
cp ~/.config/systemd/user/t3code-fork.service.d/tunnel.conf ~/.config/systemd/user/t3code.service.d/
```

4. Run the installer without `--join`. The machine stays on the map, because its map state is in `~/.t3`. The installer turns off `t3code-fork.service` and starts `t3code.service`.

```sh
curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash
```

5. Check the server:

```sh
t3 service status
systemctl --user is-active t3code.service
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3773/
```

The last command prints `200`. Then check in the portal that the machine is online with the new version, and open `https://t3-oracle.yarden-zamir.com` on the phone.

6. Turn on automatic updates. In the portal Settings view, manage the setting `forkAutoUpdate` and set it to on for this machine (MM-406). Or ask an agent to call `machines_set_setting` with `key: "forkAutoUpdate"`, `value: true` and the machine id.

7. After the next fork release, check that the machine moved to it when no agent turn ran. The portal shows the version.

### Way back

1. Stop the new service and start the old one:

```sh
systemctl --user disable --now t3code.service
systemctl --user enable --now t3code-fork.service
```

2. If the old server does not start, the new version changed the database. Remove the journal files of the new server, restore the backup, then start it again:

```sh
systemctl --user stop t3code-fork.service
rm -f ~/.t3/userdata/*.sqlite-wal ~/.t3/userdata/*.sqlite-shm
cp -a ~/t3-migration/*.sqlite* ~/t3-migration/settings.json ~/.t3/userdata/
systemctl --user start t3code-fork.service
```

The old service runs `~/.local/share/t3code-fork-server/current/t3`, which the move did not change. Only `~/.local/bin/t3` now links to the new runtime. Use the full path for commands of the old version.

## VPS

The VPS runs a source build in `/opt/t3code-a` or `/opt/t3code-b` as the system unit `t3-server.service`, as root. The timer `t3-deploy.timer` builds main and switches the link `/opt/t3code`. The tunnel runs as `cloudflared-t3.service`, which the move does not change. The new server runs as the root user service `t3code.service` on the same `127.0.0.1:3773`.

### Move

Run these steps over SSH as root (`ssh yarden-zamir-vps-2`).

1. Stop the deploy timer, so that it does not restart the old server during the move:

```sh
systemctl disable --now t3-deploy.timer
```

2. Record the current state, and check that root has a systemd user session:

```sh
mkdir -p /root/t3-migration && cd /root/t3-migration
systemctl cat t3-server.service > t3-server.service.txt
readlink -f /opt/t3code > old-checkout.txt
systemctl --user show-environment > /dev/null && echo "user session ok"
```

If the last command does not print "user session ok", log in again over SSH as root, not through `su`.

3. Read `t3-server.service.txt`. Find the T3 home: `--home-dir <dir>` in `ExecStart`, or `T3CODE_HOME` in an `Environment=` line. If it is not `/root/.t3`, run `export T3CODE_HOME=<dir>` now, in the same shell as the next steps.

4. Copy the environment of the old unit into a drop-in file of the new service. It holds the tunnel URL, the trusted origins and the Cloudflare Access login. The file `vps.conf` comes after `fork.conf` of the installer, so its `PATH` wins. That keeps `/opt/node/bin` and the provider CLIs on the `PATH`.

```sh
mkdir -p /root/.config/systemd/user/t3code.service.d
{ echo '[Service]'; grep -E '^(Environment|EnvironmentFile)=' t3-server.service.txt; } \
  > /root/.config/systemd/user/t3code.service.d/vps.conf
cat /root/.config/systemd/user/t3code.service.d/vps.conf
```

Check that the file has `T3CODE_TUNNEL_PAIRING_URL`, `T3CODE_TRUSTED_BROWSER_ORIGINS` and the three `T3CODE_CLOUDFLARE_ACCESS_*` values. If `ExecStart` of the old unit sets `--port` or `--host`, add `Environment=T3CODE_PORT=<port>` or `Environment=T3CODE_HOST=<host>` to the file.

5. Stop the old server and back up the database and the settings:

```sh
systemctl disable --now t3-server.service
cp -a "${T3CODE_HOME:-/root/.t3}"/userdata/*.sqlite* "${T3CODE_HOME:-/root/.t3}"/userdata/settings.json /root/t3-migration/
```

6. Run the installer:

```sh
curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash
```

7. Check the server:

```sh
t3 service status
systemctl --user is-active t3code.service
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3773/
systemctl is-active cloudflared-t3.service
```

Then open `https://t3-vps.yarden-zamir.com` on the phone. Log in with Cloudflare Access, and check that the threads of the other machines appear.

8. Turn on `forkAutoUpdate` for the VPS, as in step 6 of the Oracle machine.

9. Keep `/opt/t3code-a`, `/opt/t3code-b`, `t3-server.service` and `t3-deploy.timer` until the owner confirms the move. The cleanup pull request removes them.

### Way back

1. Stop the new service and start the old one and the deploy timer:

```sh
systemctl --user disable --now t3code.service
systemctl enable --now t3-server.service t3-deploy.timer
```

2. If the old server does not start, the new version changed the database. Remove the journal files of the new server, restore the backup, then start it again:

```sh
systemctl stop t3-server.service
rm -f "${T3CODE_HOME:-/root/.t3}"/userdata/*.sqlite-wal "${T3CODE_HOME:-/root/.t3}"/userdata/*.sqlite-shm
cp -a /root/t3-migration/*.sqlite* /root/t3-migration/settings.json "${T3CODE_HOME:-/root/.t3}"/userdata/
systemctl start t3-server.service
```
