import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { formatStartupCrashReport, parseStartupCrashRecords } from "./crash-log-model";

const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(),
  pendingWrites: [] as Promise<void>[],
  failure: "" as "" | "create" | "write",
}));

vi.mock("expo-file-system", () => {
  function uri(parts: (string | { uri: string })[]) {
    return parts
      .map((part) => (typeof part === "string" ? part : part.uri).replace(/\/$/, ""))
      .join("/");
  }

  class File {
    readonly uri: string;

    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }

    get name() {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }

    get exists() {
      return disk.files.has(this.uri);
    }

    create(options?: { overwrite?: boolean }) {
      if (this.exists && !options?.overwrite) throw new Error("File already exists");
      disk.files.set(this.uri, "");
    }

    write(content: string) {
      // SDK 58 schedules native IO; returning its promise does not persist the bytes.
      const pending = Promise.resolve().then(() => this.writeSync(content));
      disk.pendingWrites.push(pending);
      return pending;
    }

    writeSync(content: string) {
      if (disk.failure === "write") throw new Error("Disk full");
      disk.files.set(this.uri, content);
    }

    textSync() {
      const content = disk.files.get(this.uri);
      if (content === undefined) throw new Error("File missing");
      return content;
    }

    async text() {
      return this.textSync();
    }

    delete() {
      disk.files.delete(this.uri);
    }
  }

  class Directory {
    readonly uri: string;

    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }

    get exists() {
      return disk.directories.has(this.uri);
    }

    create(options?: { idempotent?: boolean }) {
      if (disk.failure === "create") throw new Error("Permission denied");
      if (this.exists && !options?.idempotent) throw new Error("Directory already exists");
      disk.directories.add(this.uri);
    }

    list() {
      if (!this.exists) throw new Error("Directory missing");
      return [...disk.files.keys()]
        .filter((path) => path.slice(0, path.lastIndexOf("/")) === this.uri)
        .map((path) => new File(path));
    }
  }

  return { File, Directory, Paths: { document: new Directory("file:///documents") } };
});

const BUNDLE =
  "/Users/expo/workingdir/build/apps/mobile/ios/build/Build/Intermediates.noindex/ArchiveIntermediates/T3Code/BuildProductsPath/Release-iphoneos/main.jsbundle";
const FATAL = {
  timestamp: 1789277752000,
  level: "error",
  code: "JSRuntimeError",
  message: [
    "ErrorRecovery fatal exception: Fatal error: Time: 1789277752033.127930",
    "Domain: RCTErrorDomain",
    "Code: 0",
    "Description: Unhandled JS Exception: TypeError: Cannot read property 'defaultModelSelection' of null",
    "",
    "This error is located at:",
    `    at NewTaskFlowProvider (${BUNDLE}:590585:51)`,
    `    at NavigationProvider (${BUNDLE}:139067:3)`,
    "    at RNSSafeAreaView (<anonymous>)",
  ].join("\n"),
};

describe("parseStartupCrashRecords", () => {
  it("extracts the JS error and a compact component stack from a fatal entry", () => {
    const [record] = parseStartupCrashRecords([FATAL]);
    expect(record?.description).toBe(
      "TypeError: Cannot read property 'defaultModelSelection' of null",
    );
    expect(record?.frames).toEqual([
      "NewTaskFlowProvider (main.jsbundle:590585:51)",
      "NavigationProvider (main.jsbundle:139067:3)",
      "RNSSafeAreaView",
    ]);
    expect(record?.detail).toContain("Domain: RCTErrorDomain");
  });

  it("ignores update-check noise and orders crashes newest first", () => {
    const records = parseStartupCrashRecords([
      { timestamp: 1, level: "info", code: "NoUpdatesAvailable", message: "checked" },
      { ...FATAL, timestamp: 10 },
      { timestamp: 5, level: "error", code: "UpdateFailedToLoad", message: "nope" },
      { ...FATAL, timestamp: 20 },
    ]);
    expect(records.map((record) => record.timestamp)).toEqual([20, 10]);
  });

  it("skips a runtime error entry without a description line", () => {
    expect(
      parseStartupCrashRecords([
        { ...FATAL, message: "ErrorRecovery fatal exception: Fatal exception: Name: x" },
      ]),
    ).toEqual([]);
  });
});

describe("formatStartupCrashReport", () => {
  it("writes the app version and each crash's full detail", () => {
    const report = formatStartupCrashReport(parseStartupCrashRecords([FATAL]), {
      version: "1.1.1",
      build: "56",
    });
    expect(report.startsWith("T3 Code 1.1.1 (56)\n")).toBe(true);
    expect(report).toContain("2026-09-13T05:35:52.000Z");
    expect(report).toContain("at NewTaskFlowProvider");
  });

  it("says so when nothing was recorded", () => {
    expect(formatStartupCrashReport([], { version: "1.1.1", build: "56" })).toBe(
      "T3 Code 1.1.1 (56)\nNo crashes recorded.",
    );
  });
});

describe("persisted fatal JS diagnostics", () => {
  const capturedAt = new Date("2026-10-19T12:00:00.000Z");

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(capturedAt);
    disk.files.clear();
    disk.directories.clear();
    disk.pendingWrites.length = 0;
    disk.failure = "";
  });

  afterEach(async () => {
    await Promise.allSettled(disk.pendingWrites);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function install(previous: (error: unknown, isFatal?: boolean) => void) {
    let handler = previous;
    vi.stubGlobal("ErrorUtils", {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next: typeof handler) => {
        handler = next;
      },
    });
    await import("../../lib/installCrashLog");
    return handler;
  }

  it("finishes persisting the fatal error before the previous handler can terminate JS", async () => {
    const fatal = new TypeError("Unable to load the selected model");
    fatal.stack =
      "TypeError: Unable to load the selected model\n    at loadModel (main.jsbundle:12:3)";
    let persistedAtDelegation: string[] = [];
    const previous = vi.fn(() => {
      persistedAtDelegation = [...disk.files.values()];
      throw fatal;
    });
    const handler = await install(previous);

    expect(() => handler(fatal, true)).toThrow(fatal);
    expect(previous).toHaveBeenCalledExactlyOnceWith(fatal, true);
    expect(persistedAtDelegation).toHaveLength(1);
    const saved = persistedAtDelegation[0] ?? "";
    expect(saved).toContain(fatal.message);
    expect(saved).toContain("loadModel");
    expect(saved).toContain("TypeError");
  });

  it("recovers persisted crashes after a restart into the Diagnostics report alongside startup crashes", async () => {
    const fatal = new Error("The active thread could not be restored");
    fatal.stack =
      "Error: The active thread could not be restored\n    at restoreThread (main.jsbundle:42:7)";
    const handler = await install(() => undefined);
    handler(fatal, true);
    await Promise.allSettled(disk.pendingWrites);

    // Only disk survives a fresh module graph; recovery must not rely on logger memory.
    vi.resetModules();
    const { readCrashRecords } = await import("./crash-log-model");
    const startupDetail = [
      "Domain: RCTErrorDomain",
      `Description: Unhandled JS Exception: Error: ${fatal.message}`,
      "",
      "This error is located at:",
      `    at NativeThreadBoundary (${BUNDLE}:88:9)`,
    ].join("\n");
    const nearbyTimestamp = capturedAt.getTime() + 50;
    const records = readCrashRecords([
      FATAL,
      {
        ...FATAL,
        timestamp: capturedAt.getTime() + 33,
        message: `ErrorRecovery fatal exception: ${startupDetail}`,
      },
      { ...FATAL, timestamp: nearbyTimestamp },
    ]);

    expect(records).toHaveLength(3);
    expect(records.map((record) => record.timestamp)).toEqual([
      nearbyTimestamp,
      capturedAt.getTime(),
      FATAL.timestamp,
    ]);
    expect(records.map((record) => record.description)).toEqual([
      "TypeError: Cannot read property 'defaultModelSelection' of null",
      `Error: ${fatal.message}`,
      "TypeError: Cannot read property 'defaultModelSelection' of null",
    ]);
    expect(records[1]?.detail).toContain(fatal.stack);
    expect(records[1]?.detail).toContain(startupDetail);
    const report = formatStartupCrashReport(records, { version: "1.1.1", build: "56" });
    expect(report).toContain(capturedAt.toISOString());
    expect(report).toContain(fatal.stack);
    expect(report).toContain(startupDetail);
    expect(report).toContain("defaultModelSelection");
    expect(report).toContain("at NewTaskFlowProvider");
  });

  it("delegates nonfatal errors without saving them and preserves fatal errors when IO fails", async () => {
    const previous = vi.fn((error: unknown) => {
      throw error;
    });
    const handler = await install(previous);
    const nonfatal = new Error("Recoverable warning");
    expect(() => handler(nonfatal, false)).toThrow(nonfatal);
    expect(previous).toHaveBeenCalledExactlyOnceWith(nonfatal, false);
    expect(disk.files.size).toBe(0);
    expect(disk.pendingWrites).toHaveLength(0);

    for (const failure of ["create", "write"] as const) {
      disk.failure = failure;
      const fatal = new Error(`Original fatal during ${failure} failure`);
      expect(() => handler(fatal, true)).toThrow(fatal);
      expect(previous).toHaveBeenLastCalledWith(fatal, true);
      expect(previous.mock.calls.at(-1)?.[0]).toBe(fatal);
      await Promise.allSettled(disk.pendingWrites);
      expect(disk.files.size).toBe(0);
    }
    expect(previous).toHaveBeenCalledTimes(3);
  });
});
