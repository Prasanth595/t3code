// @effect-diagnostics nodeBuiltinImport:off -- The checked connector must pump the same Unix descriptor through a Node Duplex.
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { NodeWS } from "@effect/platform-node-shared/NodeSocket";
import { NativeSessionError, ThreadId, type NativeSessionBinding } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexAppServerMessageTransport } from "effect-codex-app-server/protocol";
import * as CodexError from "effect-codex-app-server/errors";

// Python verifies and pumps one descriptor because Node exposes no SO_PEERCRED.
const connector = String.raw`import ctypes,fcntl,hashlib,json,os,select,signal,socket,stat,struct,sys
claim=json.loads(sys.argv[1]);binding=claim['binding'];proof=binding['transport']['proof'];parent=os.getppid()
def fail(code):
 print(code,file=sys.stderr,flush=True);sys.exit(1)
if ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)!=0 or os.getppid()!=parent:fail('connector-parent-changed')
def identity(value):return str(value.st_dev)+':'+str(value.st_ino)+':'+str(value.st_rdev)
def check():
 process=proof['process'];pid=process['pid'];raw=open('/proc/'+str(pid)+'/stat').read();fields=raw[raw.rfind(')')+2:].split()
 if fields[19]!=process['start'] or open('/proc/sys/kernel/random/boot_id').read().strip()!=process['boot']:fail('daemon-process-changed')
 if os.path.realpath('/proc/'+str(pid)+'/exe')!=proof['executable'] or identity(os.stat(proof['executable']))!=proof['codexIdentity']:fail('daemon-executable-changed')
 args=open('/proc/'+str(pid)+'/cmdline','rb').read().split(b'\0')
 env=dict(v.split(b'=',1) for v in open('/proc/'+str(pid)+'/environ','rb').read().split(b'\0') if b'=' in v)
 home=env.get(b'CODEX_HOME',env.get(b'HOME',b'')+b'/.codex').decode()
 if b'app-server' not in args or os.path.realpath(home)!=binding['home']:fail('daemon-home-changed')
 if proof['uid']!=os.getuid():fail('daemon-uid-changed')
 if identity(os.lstat(proof['rendezvous']))!=proof['rendezvousIdentity'] or os.path.realpath(proof['rendezvous'])!=proof['socket']:fail('daemon-rendezvous-changed')
 for path,key in [(proof['socket'],'socketIdentity'),(os.path.dirname(proof['socket']),'controlIdentity')]:
  actual=os.lstat(path)
  if os.path.realpath(path)!=path or actual.st_uid!=proof['uid'] or identity(actual)!=proof[key]:fail('daemon-socket-changed')
 if not stat.S_ISSOCK(os.lstat(proof['socket']).st_mode) or os.lstat(os.path.dirname(proof['socket'])).st_mode&0o077:fail('daemon-socket-not-private')
 for suffix,key in [('sessions','sessionStore'),('thread-writer-locks','writerLockStore')]:
  path=binding['nativeStores'][key];actual=os.lstat(path)
  if os.path.realpath(os.path.join(binding['home'],suffix))!=path or not stat.S_ISDIR(actual.st_mode) or actual.st_uid!=proof['uid'] or identity(actual)!=binding['nativeStores'][key+'Identity']:fail('native-stores-changed')
check()
authority=claim['authority'];database=os.path.realpath(authority['databasePath'])
if database!=authority['databasePath'] or not stat.S_ISREG(os.lstat(database).st_mode):fail('authority-database-unavailable')
directory=os.path.join(binding['home'],'.t3-native-authority')
if not os.path.exists(directory) and not claim.get('allowCreateAuthority',False):fail('authority-record-missing')
try:os.mkdir(directory,0o700)
except FileExistsError:pass
actual=os.lstat(directory)
if not stat.S_ISDIR(actual.st_mode) or actual.st_uid!=os.getuid() or actual.st_mode&0o077 or os.path.realpath(directory)!=directory:fail('authority-store-not-private')
key=hashlib.sha256((binding['nativeStores']['sessionStore']+'\0'+binding['nativeId']).encode()).hexdigest()
fd=os.open(os.path.join(directory,key+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
if not claim.get('readOnly',False):
 try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:fail('conversation-guard-held')
record=dict(environmentId=authority['environmentId'],databasePath=database,databaseIdentity=identity(os.stat(database)))
recordPath=os.path.join(directory,key+'.json')
try:
 recordFd=os.open(recordPath,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(recordFd) as f:previous=json.load(f)
 if previous!=record:fail('foreign-authority-database')
except FileNotFoundError:
 if not claim.get('allowCreateAuthority',False):fail('authority-record-missing')
 recordFd=os.open(recordPath,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(recordFd,'w') as f:json.dump(record,f);f.flush();os.fsync(f.fileno())
 d=os.open(directory,os.O_RDONLY|os.O_DIRECTORY);os.fsync(d);os.close(d)
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.connect(proof['socket'])
pid,uid,gid=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
if pid!=proof['process']['pid'] or uid!=proof['uid']:fail('connected-peer-changed')
check()
while True:
 readable,_,_=select.select([0,s],[],[])
 for source in readable:
  data=os.read(0,65536) if source==0 else s.recv(65536)
  if not data:check();sys.exit(0)
  if source==0:check();s.sendall(data)
  else:
   while data:
    count=os.write(1,data);data=data[count:]
`;

export const openCheckedNativeTransport = Effect.fn("NativeSessionTransport.open")(
  function* (input: {
    readonly platform?: NodeJS.Platform;
    readonly binding: NativeSessionBinding;
    readonly authority: { readonly environmentId: string; readonly databasePath: string };
    readonly readOnly?: boolean;
    readonly allowCreateAuthority?: boolean;
  }): Effect.fn.Return<CodexAppServerMessageTransport, NativeSessionError, Scope.Scope> {
    const threadId = ThreadId.make(`native:${input.binding.nativeId ?? "unknown"}`);
    const platform = yield* HostProcess.Platform;
    if ((input.platform ?? platform) !== "linux")
      return yield* new NativeSessionError({ code: "unsupported-platform", threadId });
    const incoming = yield* Queue.unbounded<
      string,
      CodexError.CodexAppServerError | Cause.Done<void>
    >();
    const resource = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<{ socket: NodeWS.WebSocket; close: () => Promise<void> }>(
            (resolve, reject) => {
              const child = NodeChildProcess.spawn(
                "python3",
                ["-I", "-c", connector, JSON.stringify(input)],
                {
                  stdio: ["pipe", "pipe", "pipe"],
                  env: { ...process.env, PYTHONHOME: undefined, PYTHONPATH: undefined },
                },
              );
              const exited = new Promise<void>((done) => child.once("exit", () => done()));
              let diagnostic = "native-connection-failed";
              child.stderr.setEncoding("utf8");
              child.stderr.on("data", (bytes: string) => {
                const code = bytes.trim();
                if (/^[a-z][a-z-]{0,80}$/.test(code)) diagnostic = code;
              });
              const duplex = NodeStream.Duplex.from({
                readable: child.stdout,
                writable: child.stdin,
              });
              const socket = new NodeWS.WebSocket("ws://localhost/", {
                createConnection: () => duplex,
                maxPayload: 64 * 1024 * 1024,
                perMessageDeflate: false,
                skipUTF8Validation: false,
                handshakeTimeout: 5000,
              });
              const close = async () => {
                socket.terminate();
                duplex.destroy();
                child.stdin.destroy();
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
                await exited;
              };
              child.once("error", (error) => {
                void close().then(() => reject(error));
              });
              child.once("exit", () => {
                socket.terminate();
                reject(new Error(diagnostic));
              });
              socket.on("message", (bytes, binary) => {
                if (binary) {
                  socket.close(1003);
                  return;
                }
                Queue.offerUnsafe(incoming, String(bytes));
              });
              socket.once("close", () => {
                Queue.endUnsafe(incoming);
              });
              socket.on("error", (error) => {
                void close().then(() => reject(error));
              });
              socket.once("open", () =>
                resolve({
                  socket,
                  close: async () => {
                    socket.close();
                    await exited;
                    if (child.exitCode !== 0)
                      throw new Error("Checked native connection did not settle.");
                  },
                }),
              );
            },
          ),
        catch: (cause) =>
          new NativeSessionError({ code: "native-connection-unverified", threadId, cause }),
      }),
      (resource) => Effect.promise(resource.close),
    );
    return {
      incoming: Stream.fromQueue(incoming),
      write: (message) =>
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) =>
              resource.socket.send(message, (error) => (error ? reject(error) : resolve())),
            ),
          catch: (cause) =>
            new CodexError.CodexAppServerTransportError({ operation: "read-input-stream", cause }),
        }),
    };
  },
);
