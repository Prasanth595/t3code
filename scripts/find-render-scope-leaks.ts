// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off preferSchemaOverJson:off - Host-side browser automation drives a dev client and reads raw heap snapshots.
/**
 * Finds closures that pile up in the web client as it updates: the sign of a
 * render-scope leak (see apps/web/src/hooks/useStableCallback.ts).
 *
 * Opens a running dev client in headless Chromium, takes a heap snapshot,
 * drives updates, takes another, and lists the source locations whose
 * closure count grew with the number of updates. A bounded app ends near
 * where it started; a leak grows by about one copy per update.
 *
 *   node scripts/find-render-scope-leaks.ts --url <pairing URL> [--rounds 20]
 *     [--base-dir <dev home>] [--thread <sidebar title>] [--stream]
 *
 * --url        The dev runner's pairing URL on the first run; the bare origin
 *              after that, since the browser profile keeps the session.
 * --base-dir   The dev server's home (a worktree's .t3). Toggles a harmless
 *              server setting each round, which updates server config.
 * --thread     Opens this thread first, so ChatView is mounted.
 * --stream     Sends a one-word agent turn each round. Uses a real provider.
 *
 * Every round also types into the composer and toggles the open thread's pin.
 * Never point --base-dir at the live ~/.t3; use a dev server's own state.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type Page } from "playwright-core";

const { values: args } = NodeUtil.parseArgs({
  options: {
    url: { type: "string" },
    rounds: { type: "string", default: "20" },
    "base-dir": { type: "string" },
    thread: { type: "string" },
    stream: { type: "boolean", default: false },
  },
});
if (!args.url) throw new Error("--url is required (the dev runner's pairing URL)");
const rounds = Number(args.rounds);
const workDir = NodePath.join(NodeOS.tmpdir(), "t3-render-scope-leaks");
NodeFS.mkdirSync(workDir, { recursive: true });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launchPersistentContext(NodePath.join(workDir, "profile"), {
  headless: true,
  viewport: { width: 1400, height: 900 },
});
const page = browser.pages()[0] ?? (await browser.newPage());
await page.goto(args.url);
const composer = page.locator("[contenteditable=true]").first();
await composer.waitFor({ timeout: 60_000 });
if (args.thread) await page.getByText(args.thread, { exact: true }).first().click();
await sleep(5000);
const cdp = await browser.newCDPSession(page);
await cdp.send("HeapProfiler.enable");

/** Takes a heap snapshot after a full GC and writes it to the work dir. */
const takeSnapshot = async (name: string) => {
  await cdp.send("HeapProfiler.collectGarbage");
  const file = NodePath.join(workDir, `${name}.heapsnapshot`);
  const out = NodeFS.createWriteStream(file);
  const onChunk = ({ chunk }: { chunk: string }) => out.write(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await new Promise((resolve) => out.end(resolve));
  return file;
};

/** One round of updates: server config, composer input, thread state, agent turn. */
const update = async (page: Page, round: number) => {
  if (args["base-dir"]) {
    const settingsPath = NodePath.join(args["base-dir"], "userdata", "settings.json");
    const settings = NodeFS.existsSync(settingsPath)
      ? JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"))
      : {};
    settings.continueThreadsAfterServerUpdate = round % 2 === 0;
    NodeFS.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    await sleep(1500);
  }
  await composer.click();
  await page.keyboard.type(round % 2 === 0 ? "x" : "y");
  await sleep(800);
  await page.keyboard.press("ControlOrMeta+Shift+KeyP");
  await sleep(1500);
  if (args.stream) {
    await composer.click();
    await page.keyboard.press("ControlOrMeta+KeyA");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(`Reply with exactly the word ok${round}. Do not use any tools.`);
    await page.keyboard.press("Enter");
    await page.getByText(`ok${round}`, { exact: true }).first().waitFor({ timeout: 90_000 });
    await sleep(2000);
  }
};

const before = await takeSnapshot("before");
for (let round = 0; round < rounds; round++) await update(page, round);
await sleep(3000);
const after = await takeSnapshot("after");
await browser.close();

const countsBefore = countClosures(before);
const countsAfter = countClosures(after);
const growing = [...countsAfter]
  .map(([location, count]) => ({ location, growth: count - (countsBefore.get(location) ?? 0) }))
  .filter(({ growth }) => growth >= Math.max(3, rounds / 2))
  .sort((a, b) => b.growth - a.growth);
const total = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`App closures after ${rounds} rounds: ${total(countsBefore)} -> ${total(countsAfter)}`);
for (const { location, growth } of growing) console.log(`  +${growth}  ${location}`);
console.log(growing.length ? "Possible render-scope leaks above." : "No closure grows per update.");
process.exitCode = growing.length ? 1 : 0;

/**
 * Counts closures per source location (file:line:column name) for app source
 * modules, streaming the snapshot because it is too large for JSON.parse.
 */
function countClosures(file: string): Map<string, number> {
  const fd = NodeFS.openSync(file, "r");
  const buf = Buffer.alloc(16 * 1024 * 1024);
  let pos = 0;
  let len = 0;
  let off = 0;
  const byte = () => {
    if (off >= len) {
      len = NodeFS.readSync(fd, buf, 0, buf.length, pos);
      pos += len;
      off = 0;
      if (len === 0) return -1;
    }
    return buf[off++]!;
  };
  const skipTo = (marker: string) => {
    const bytes = Buffer.from(marker);
    for (let matched = 0; matched < bytes.length;) {
      const c = byte();
      if (c === -1) throw new Error(`${marker} not found in ${file}`);
      matched = c === bytes[matched] ? matched + 1 : c === bytes[0] ? 1 : 0;
    }
  };
  // Reads comma-separated non-negative integers up to the closing "]".
  const readInts = (into: Uint32Array) => {
    let count = 0;
    let value = 0;
    let digits = false;
    for (;;) {
      const c = byte();
      if (c >= 48 && c <= 57) {
        value = value * 10 + (c - 48);
        digits = true;
        continue;
      }
      if (digits) into[count++] = value;
      value = 0;
      digits = false;
      if (c === 93 || c === -1) return count;
    }
  };
  let head = "";
  while (!head.endsWith('"nodes":[')) head += String.fromCharCode(byte());
  const { meta, node_count: nodeCount } = JSON.parse(
    `${head.slice(0, head.lastIndexOf('"nodes"')).replace(/,\s*$/, "")}}`,
  ).snapshot;
  const nodeWidth = meta.node_fields.length;
  const locationWidth = meta.location_fields.length;
  const nodes = new Uint32Array(nodeCount * nodeWidth);
  readInts(nodes);
  skipTo('"locations":[');
  const locations = new Uint32Array(nodeCount * locationWidth);
  const locationCount = readInts(locations);
  skipTo('"strings":[');
  const strings: string[] = [];
  for (;;) {
    let c = byte();
    while (c === 32 || c === 10 || c === 13 || c === 44) c = byte();
    if (c === 93 || c === -1) break;
    const bytes = [34];
    for (;;) {
      c = byte();
      bytes.push(c);
      if (c === 92) bytes.push(byte());
      else if (c === 34) break;
    }
    strings.push(JSON.parse(Buffer.from(bytes).toString("utf8")));
  }
  NodeFS.closeSync(fd);

  const typeField = meta.node_fields.indexOf("type");
  const nameField = meta.node_fields.indexOf("name");
  const closureType = meta.node_types[0].indexOf("closure");
  const nameOf = (node: number) => strings[nodes[node * nodeWidth + nameField]!] ?? "";
  const counts = new Map<string, number>();
  for (let i = 0; i + locationWidth <= locationCount; i += locationWidth) {
    const node = locations[i]! / nodeWidth;
    if (nodes[node * nodeWidth + typeField] !== closureType) continue;
    const script = nameOf(locations[i + 2]! / nodeWidth);
    if (!script.includes("/src/")) continue;
    const path = script.replace(/^.*?\/src\//, "src/").replace(/\?.*$/, "");
    const key = `${path}:${locations[i + 3]! + 1}:${locations[i + 4]! + 1} ${nameOf(node) || "(anonymous)"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
