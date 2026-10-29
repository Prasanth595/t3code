// @effect-diagnostics globalTimers:off - scheduling for the standalone check:changed script.
const GiB = 1024 ** 3;

export const positiveInteger = (value: string | undefined) => {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
};

// A typecheck or test step can take several cores and gigabytes of memory, so
// allow one step per two cores and per 6 GiB of available memory.
export const defaultConcurrency = (cores: number, availableBytes: number) =>
  Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(availableBytes / (6 * GiB))));

// A task holds `weight` slots, capped at the limit, so a step that runs its own
// workers counts each one. Tasks start in order: a heavy task waiting for room
// is never overtaken by lighter ones behind it.
export const createLimiter = (concurrency: number) => {
  let active = 0;
  const queue: Array<{ slots: number; start: () => void }> = [];
  const startQueued = () => {
    while (queue.length > 0 && active + queue[0]!.slots <= concurrency) {
      const next = queue.shift()!;
      active += next.slots;
      next.start();
    }
  };
  return async <A>(task: () => Promise<A>, weight = 1): Promise<A> => {
    const slots = Math.min(Math.max(weight, 1), concurrency);
    if (queue.length === 0 && active + slots <= concurrency) active += slots;
    else await new Promise<void>((start) => queue.push({ slots, start }));
    try {
      return await task();
    } finally {
      active -= slots;
      startQueued();
    }
  };
};

export type StepOutcome = "pass" | "FAIL" | "TIMEOUT";

interface Child {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (status: number | null) => void): unknown;
}

// Node fires a delay above its 32-bit maximum after 1 ms instead.
const MAX_TIMER_MS = 2 ** 31 - 1;

// Collects a step's output and settles when it exits. Past timeoutMs it calls
// kill, which must end the whole process tree, and reports TIMEOUT whatever the
// exit status.
export const awaitStep = (child: Child, timeoutMs: number, kill: () => void) =>
  new Promise<{ outcome: StepOutcome; output: Buffer }>((resolve) => {
    const output: Array<Buffer> = [];
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        kill();
      },
      Math.min(timeoutMs, MAX_TIMER_MS),
    );
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    // A failed spawn emits "error", then "close" with a nonzero code.
    child.on("error", (error) => output.push(Buffer.from(`${error.message}\n`)));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        outcome: timedOut ? "TIMEOUT" : status === 0 ? "pass" : "FAIL",
        output: Buffer.concat(output),
      });
    });
  });
