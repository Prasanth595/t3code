import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as CodexClient from "effect-codex-app-server/client";
import { openCheckedNativeTransport } from "./NativeSessionTransport.ts";

it.effect("fails closed on unsupported platforms before starting a connector", () =>
  Effect.gen(function* () {
    const result = yield* Effect.flip(
      openCheckedNativeTransport({
        platform: "win32",
        binding: {} as never,
        authority: { environmentId: "environment", databasePath: "/private/state.sqlite" },
      }),
    );
    expect(result.code).toBe("unsupported-platform");
  }),
);

it.live(
  "uses the checked Unix connection for actual WebSocket framing and closes only that connection",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const fs = await import("node:fs/promises");
          const cp = await import("node:child_process");
          const path = await import("node:path");
          const os = await import("node:os");
          const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-native-peer-"));
          await fs.mkdir(path.join(dir, "sessions"), { mode: 0o700 });
          await fs.mkdir(path.join(dir, "thread-writer-locks"), { mode: 0o700 });
          await fs.writeFile(path.join(dir, "state.sqlite"), "fixture");
          const program = `import { createServer } from 'node:http'; import { NodeWS } from '@effect/platform-node-shared/NodeSocket';
const server=createServer();const wss=new NodeWS.WebSocketServer({server});wss.on('connection',ws=>{ws.on('message',bytes=>{const r=JSON.parse(String(bytes));if(r.method==='never'){process.stdout.write('waiting\\n');return;}const text=JSON.stringify({id:r.id,result:{text:'你好 🌱',nativeId:r.params.threadId}});ws.send(text.slice(0,12),{fin:false});ws.send(text.slice(12),{fin:true});ws.ping();});});server.listen(process.argv[2],()=>process.stdout.write('ready\\n'));process.stdin.on('data',()=>{for(const ws of wss.clients)ws.close();});process.stdin.on('end',()=>{for(const ws of wss.clients)ws.terminate();server.close();});`;
          const socket = path.join(dir, "control.sock");
          const child = cp.spawn(
            process.execPath,
            ["--input-type=module", "-e", program, "app-server", socket],
            {
              cwd: import.meta.dirname + "/../..",
              stdio: ["pipe", "pipe", "pipe"],
              env: { ...process.env, CODEX_HOME: dir },
            },
          );
          let pending = "";
          const lines: string[] = [];
          const waiters: Array<(value: string) => void> = [];
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            pending += chunk;
            for (;;) {
              const end = pending.indexOf("\n");
              if (end < 0) break;
              const line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              const waiting = waiters.shift();
              if (waiting) waiting(line);
              else lines.push(line);
            }
          });
          const next = () =>
            lines.length
              ? Promise.resolve(lines.shift()!)
              : new Promise<string>((resolve) => waiters.push(resolve));
          const failed = new Promise<never>((_, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => reject(new Error(`Peer exited ${code}`)));
          });
          await Promise.race([next(), failed]);
          const stamp = async (p: string) => {
            const st = await fs.lstat(p);
            return `${st.dev}:${st.ino}:${st.rdev}`;
          };
          const raw = await fs.readFile(`/proc/${child.pid}/stat`, "utf8");
          const executable = await fs.realpath(`/proc/${child.pid}/exe`);
          const binding = {
            home: dir,
            cwd: dir,
            nativeId: "019bd450-188a-7000-8000-000000000001",
            protocolVersion: "0.164.0" as const,
            nativeStores: {
              sessionStore: path.join(dir, "sessions"),
              sessionStoreIdentity: await stamp(path.join(dir, "sessions")),
              writerLockStore: path.join(dir, "thread-writer-locks"),
              writerLockStoreIdentity: await stamp(path.join(dir, "thread-writer-locks")),
            },
            transport: {
              kind: "shared-daemon" as const,
              proof: {
                process: {
                  pid: child.pid!,
                  start: raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]!,
                  boot: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
                },
                executable,
                codexIdentity: await stamp(executable),
                socket,
                socketIdentity: await stamp(socket),
                rendezvous: socket,
                rendezvousIdentity: await stamp(socket),
                controlIdentity: await stamp(dir),
                uid: process.getuid!(),
              },
            },
          };
          return {
            child,
            next,
            binding,
            dir,
            exit: new Promise<void>((resolve) => child.once("exit", () => resolve())),
          };
        }),
        (fixture) =>
          Effect.promise(async () => {
            fixture.child.stdin.end();
            await fixture.exit;
          }),
      );
      const transport = yield* openCheckedNativeTransport({
        binding: fixture.binding,
        allowCreateAuthority: true,
        authority: {
          environmentId: "fixture-environment",
          databasePath: fixture.dir + "/state.sqlite",
        },
      });
      const client = yield* CodexClient.make(undefined, { messages: transport });
      expect(
        yield* client.raw.request("thread/read", { threadId: fixture.binding.nativeId }),
      ).toEqual({ text: "你好 🌱", nativeId: fixture.binding.nativeId });
      const waiting = yield* client.raw.request("never", {}).pipe(Effect.forkScoped);
      yield* Effect.promise(fixture.next);
      fixture.child.stdin.write("close\n");
      const disconnected = yield* Effect.result(Fiber.join(waiting));
      expect(disconnected).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CodexAppServerInputStreamEndedError" },
      });
      expect(fixture.child.exitCode).toBe(null);
    }),
);
