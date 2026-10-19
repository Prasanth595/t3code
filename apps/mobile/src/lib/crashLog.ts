import { Directory, File, Paths } from "expo-file-system";
import type { ErrorUtils as ErrorUtilsInterface } from "react-native";

const CRASH_LOG_DIRECTORY = "crash-logs";
const MAX_PERSISTED_CRASH_LOGS = 20;

interface PersistedCrashRecord {
  readonly capturedAt: string;
  readonly message: string;
  readonly name: string | null;
  readonly stack: string | null;
}

let crashSequence = 0;

function safeErrorMessage(error: unknown): string {
  try {
    return String(error);
  } catch {
    return "[Uncoercible error]";
  }
}

export function installCrashLogger(): void {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsInterface }).ErrorUtils;
  if (errorUtils === undefined) {
    return;
  }
  const previousHandler = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error: unknown, isFatal: boolean) => {
    if (isFatal === true) {
      try {
        persistCrashRecord(error);
      } catch {
        // Never let the logger mask the original error.
      }
    }
    previousHandler(error, isFatal);
  });
}

function persistCrashRecord(error: unknown): void {
  const directory = new Directory(Paths.document, CRASH_LOG_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const cause = error instanceof Error ? error : null;
  const record = {
    capturedAt: new Date().toISOString(),
    isFatal: true,
    message: typeof cause?.message === "string" ? cause.message : safeErrorMessage(error),
    name: typeof cause?.name === "string" ? cause.name : null,
    stack: typeof cause?.stack === "string" ? cause.stack : null,
  };
  crashSequence += 1;
  // Keep lexical directory ordering aligned with capture order for records
  // written within the same millisecond.
  const sequence = String(crashSequence).padStart(6, "0");
  const file = new File(directory, `crash-${Date.now()}-${sequence}.json`);
  file.create({ intermediates: true, overwrite: true });
  try {
    // ErrorUtils may terminate the runtime as soon as we delegate to its handler.
    file.writeSync(JSON.stringify(record));
  } catch (error) {
    try {
      file.delete();
    } catch {
      // Cleanup failure must not replace the write error.
    }
    throw error;
  }
  for (const oldFile of crashLogFiles().slice(MAX_PERSISTED_CRASH_LOGS)) {
    try {
      oldFile.delete();
    } catch {
      // Retention is best-effort when files cannot be deleted.
    }
  }
}

function crashLogFiles(): File[] {
  try {
    const directory = new Directory(Paths.document, CRASH_LOG_DIRECTORY);
    if (!directory.exists) return [];
    return directory
      .list()
      .filter(
        (entry): entry is File =>
          entry instanceof File && entry.name.startsWith("crash-") && entry.name.endsWith(".json"),
      )
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

export function readPersistedCrashRecords(): ReadonlyArray<PersistedCrashRecord> {
  const records: PersistedCrashRecord[] = [];
  for (const file of crashLogFiles().slice(0, MAX_PERSISTED_CRASH_LOGS)) {
    try {
      const record: unknown = JSON.parse(file.textSync());
      if (
        typeof record !== "object" ||
        record === null ||
        !("isFatal" in record) ||
        record.isFatal !== true ||
        !("capturedAt" in record) ||
        typeof record.capturedAt !== "string" ||
        !Number.isFinite(Date.parse(record.capturedAt)) ||
        !("message" in record) ||
        typeof record.message !== "string" ||
        !("name" in record) ||
        (record.name !== null && typeof record.name !== "string") ||
        !("stack" in record) ||
        (record.stack !== null && typeof record.stack !== "string")
      )
        continue;
      records.push({
        capturedAt: record.capturedAt,
        message: record.message,
        name: record.name,
        stack: record.stack,
      });
    } catch {
      // A partial or unreadable record must not hide the remaining crashes.
    }
  }
  return records;
}
