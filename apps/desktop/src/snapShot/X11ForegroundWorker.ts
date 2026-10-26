import { readActiveX11Window } from "./X11Foreground.ts";

void readActiveX11Window().then(
  (window) => process.stdout.write(JSON.stringify(window ?? null)),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
