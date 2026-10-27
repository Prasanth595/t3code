/**
 * Runs `run` at most once at a time. A call made while a run is in flight
 * returns that run and queues one more after it, so input that arrives
 * mid-run (a native share handed over on resume) is still read.
 */
export function coalescedRun(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let again = false;
  const start = (): Promise<void> => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = run().finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        void start();
      }
    });
    return inFlight;
  };
  return start;
}
