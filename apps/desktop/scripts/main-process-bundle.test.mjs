import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { build } from "vite-plus/pack";
import { assert, it } from "vite-plus/test";

import desktopConfig from "../vite.config.ts";

it("keeps lazy Linux imports and worker bundles from executing desktop startup twice", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-bundle-"));
  try {
    const workerEntries = [
      "src/electron/WindowsForegroundFocusWorker.ts",
      "src/snapShot/GlobalShiftShortcutWorker.ts",
      "src/snapShot/RegionSnapShotWorker.ts",
      "src/snapShot/SnapShotAccessibilityWorker.ts",
    ];
    await Promise.all([
      NodeFSP.mkdir(NodePath.join(directory, "src/electron"), { recursive: true }),
      NodeFSP.mkdir(NodePath.join(directory, "src/snapShot"), { recursive: true }),
    ]);
    await Promise.all([
      NodeFSP.writeFile(
        NodePath.join(directory, "src/main.ts"),
        `import { shared } from "./shared.ts";
process.emit("startup", shared.value);
void import("./linux.ts").then(({ result }) => process.emit("ready", result));`,
      ),
      NodeFSP.writeFile(
        NodePath.join(directory, "src/shared.ts"),
        "export const shared = { value: 42 };",
      ),
      NodeFSP.writeFile(
        NodePath.join(directory, "src/linux.ts"),
        'import { shared } from "./shared.ts"; export const result = shared.value + 1;',
      ),
      ...workerEntries.map((entry) =>
        NodeFSP.writeFile(
          NodePath.join(directory, entry),
          'import { shared } from "../shared.ts"; process.emit("worker", shared.value);',
        ),
      ),
    ]);
    assert.ok(Array.isArray(desktopConfig.pack));
    const fixtureEntries = new Set(["src/main.ts", ...workerEntries]);
    for (const packConfig of desktopConfig.pack) {
      if (!Array.isArray(packConfig.entry)) continue;
      if (!packConfig.entry.some((entry) => fixtureEntries.has(entry))) continue;
      await build({
        ...packConfig,
        config: false,
        cwd: directory,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }

    const outputDirectory = NodePath.join(directory, "dist-electron");
    const filenames = (await NodeFSP.readdir(outputDirectory, { recursive: true })).filter(
      (filename) => filename.endsWith(".cjs"),
    );
    const sources = new Map(
      await Promise.all(
        filenames.map(async (filename) => {
          const path = NodePath.join(outputDirectory, filename);
          return [path, await NodeFSP.readFile(path, "utf8")];
        }),
      ),
    );
    const modules = new Map();
    const startups = [];
    const workers = [];
    const ready = Promise.withResolvers();
    const load = (filename, cacheModule = true) => {
      const cached = modules.get(filename);
      if (cached) return cached.exports;
      const module = { exports: {} };
      if (cacheModule) modules.set(filename, module);
      const source = sources.get(filename);
      assert.ok(source, `Missing bundle: ${filename}`);
      NodeVM.runInNewContext(source, {
        exports: module.exports,
        module,
        require: (specifier) => load(NodePath.resolve(NodePath.dirname(filename), specifier)),
        process: {
          emit: (event, value) => {
            if (event === "startup") startups.push(value);
            if (event === "worker") workers.push(value);
            if (event === "ready") ready.resolve(value);
          },
        },
      });
      return module.exports;
    };

    load(NodePath.join(outputDirectory, "main.cjs"), false);
    assert.equal(await ready.promise, 43);
    assert.deepEqual(startups, [42]);
    for (const entry of workerEntries) {
      load(NodePath.join(outputDirectory, entry.replace(/^src\//, "").replace(/\.ts$/, ".cjs")));
    }
    assert.deepEqual(workers, [42, 42, 42, 42]);
    assert.deepEqual(startups, [42]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("loads the emitted packaged boot entry and backend cache preload", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-boot-"));
  try {
    const entries = ["src/boot.ts", "src/compileCache.ts"];
    await NodeFSP.mkdir(NodePath.join(directory, "src"));
    await Promise.all(
      entries.map((entry) =>
        NodeFSP.copyFile(new URL(`../${entry}`, import.meta.url), NodePath.join(directory, entry)),
      ),
    );
    assert.ok(Array.isArray(desktopConfig.pack));
    for (const packConfig of desktopConfig.pack) {
      if (!Array.isArray(packConfig.entry)) continue;
      if (!packConfig.entry.some((entry) => entries.includes(entry))) continue;
      await build({
        ...packConfig,
        config: false,
        cwd: directory,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }
    const outputDirectory = NodePath.join(directory, "dist-electron");
    const fixture = `console.log(require('node:module').getCompileCacheDir() ? 'cached' : 'uncached');`;
    await NodeFSP.writeFile(NodePath.join(outputDirectory, "main.cjs"), fixture);
    await NodeFSP.writeFile(
      NodePath.join(outputDirectory, "backend.mjs"),
      `import { getCompileCacheDir } from 'node:module'; console.log(getCompileCacheDir() ? 'cached' : 'uncached');`,
    );
    for (const disabled of [false, true]) {
      for (const args of [
        [NodePath.join(outputDirectory, "boot.cjs")],
        [
          "--require",
          NodePath.join(outputDirectory, "compileCache.cjs"),
          NodePath.join(outputDirectory, "backend.mjs"),
        ],
      ]) {
        const child = NodeChildProcess.spawnSync(process.execPath, args, {
          encoding: "utf8",
          env: {
            ...process.env,
            APPIMAGE: "",
            NODE_COMPILE_CACHE: undefined,
            NODE_DISABLE_COMPILE_CACHE: disabled ? "1" : undefined,
            XDG_CACHE_HOME: directory,
            TMPDIR: directory,
            TEMP: directory,
            TMP: directory,
          },
        });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout.trim(), disabled ? "uncached" : "cached");
      }
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("under AppImage, reuses the shipped compile cache from a different mount path", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-appimage-"));
  try {
    const entries = ["src/boot.ts", "src/compileCache.ts"];
    const source = NodePath.join(directory, "source");
    await NodeFSP.mkdir(NodePath.join(source, "src"), { recursive: true });
    await Promise.all(
      entries.map((entry) =>
        NodeFSP.copyFile(new URL(`../${entry}`, import.meta.url), NodePath.join(source, entry)),
      ),
    );
    assert.ok(Array.isArray(desktopConfig.pack));
    for (const packConfig of desktopConfig.pack) {
      if (!Array.isArray(packConfig.entry)) continue;
      if (!packConfig.entry.some((entry) => entries.includes(entry))) continue;
      await build({
        ...packConfig,
        config: false,
        cwd: source,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }
    // Two launches of one AppImage see the same files under different mount
    // paths. The shipped cache sits beside app.asar, outside it.
    const mounts = ["mount-first", "mount-second"].map((name) => NodePath.join(directory, name));
    const cacheDirs = [];
    for (const mount of mounts) {
      const distElectron = NodePath.join(mount, "resources/app.asar/apps/desktop/dist-electron");
      await NodeFSP.mkdir(distElectron, { recursive: true });
      await NodeFSP.cp(NodePath.join(source, "dist-electron"), distElectron, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(distElectron, "main.cjs"),
        "console.log(require('node:module').getCompileCacheDir() ?? 'uncached');",
      );
      cacheDirs.push(NodePath.join(mount, "resources/compile-cache"));
    }
    const launch = (mount) =>
      NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(mount, "resources/app.asar/apps/desktop/dist-electron/boot.cjs")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            APPIMAGE: NodePath.join(mount, "t3code"),
            NODE_COMPILE_CACHE: undefined,
            NODE_DISABLE_COMPILE_CACHE: undefined,
            // A miss on a read-only cache looks like a hit from the outside;
            // Node's own log is what tells them apart.
            NODE_DEBUG_NATIVE: "COMPILE_CACHE",
            XDG_CACHE_HOME: directory,
          },
        },
      );
    const listEntries = async (cacheDir) =>
      (await NodeFSP.readdir(cacheDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => NodePath.relative(cacheDir, NodePath.join(entry.parentPath, entry.name)))
        .sort();

    // The build warms the cache at one path; a launch anywhere else must hit it.
    await NodeFSP.mkdir(cacheDirs[0], { recursive: true });
    const warm = launch(mounts[0]);
    assert.equal(warm.status, 0, warm.stderr);
    assert.ok(warm.stdout.trim().startsWith(cacheDirs[0]), warm.stdout);
    const warmed = await listEntries(cacheDirs[0]);
    assert.ok(warmed.length > 0);

    // The image is read-only, so the second launch must hit without writing.
    await NodeFSP.cp(cacheDirs[0], cacheDirs[1], { recursive: true });
    const statsBefore = await Promise.all(
      warmed.map((entry) => NodeFSP.stat(NodePath.join(cacheDirs[1], entry))),
    );
    const readOnly = process.getuid?.() !== 0;
    if (readOnly) await chmodTree(cacheDirs[1], 0o555, 0o444);
    try {
      const reuse = launch(mounts[1]);
      assert.equal(reuse.status, 0, reuse.stderr);
      assert.ok(reuse.stdout.trim().startsWith(cacheDirs[1]), reuse.stdout);
      assert.match(reuse.stderr, /main\.cjs was accepted/, reuse.stderr);
    } finally {
      if (readOnly) await chmodTree(cacheDirs[1], 0o755, 0o644);
    }
    assert.deepEqual(await listEntries(cacheDirs[1]), warmed);
    const statsAfter = await Promise.all(
      warmed.map((entry) => NodeFSP.stat(NodePath.join(cacheDirs[1], entry))),
    );
    assert.deepEqual(
      statsAfter.map((stat) => stat.mtimeMs),
      statsBefore.map((stat) => stat.mtimeMs),
      "a hit rewrites nothing",
    );
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

async function chmodTree(root, directoryMode, fileMode) {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    await NodeFSP.chmod(
      NodePath.join(entry.parentPath, entry.name),
      entry.isDirectory() ? directoryMode : fileMode,
    );
  }
  await NodeFSP.chmod(root, directoryMode);
}
