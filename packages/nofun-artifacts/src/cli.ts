#!/usr/bin/env node
// `nofun-artifacts compile` writes a Canvas bundle directory from a spec, tsx, or page file.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

import { parseCanvasBackground, parseCanvasSize, writeCanvasBundle } from "./canvas-bundle.ts";
import { compileArtifact, compilePage } from "./compiler.ts";
import { readStamp } from "./stamp.ts";

const USAGE =
  "nofun-artifacts compile (--spec <file> | --tsx <file> | --page <file>) --theme <id> --size WxH [--background transparent|match|#rrggbb] [--name <name>] --out <dir>";

interface Flags {
  spec?: string;
  tsx?: string;
  page?: string;
  theme?: string;
  size?: string;
  background?: string;
  name?: string;
  out?: string;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const take = (name: keyof Flags) => {
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
      if (flags[name]) throw new Error(`${flag} was passed twice.`);
      flags[name] = value;
      i += 1;
    };
    switch (flag) {
      case "--spec":
        take("spec");
        break;
      case "--tsx":
        take("tsx");
        break;
      case "--page":
        take("page");
        break;
      case "--theme":
        take("theme");
        break;
      case "--size":
        take("size");
        break;
      case "--background":
        take("background");
        break;
      case "--name":
        take("name");
        break;
      case "--out":
        take("out");
        break;
      default:
        throw new Error(`Unknown argument ${JSON.stringify(flag)}. ${USAGE}`);
    }
  }
  return flags;
}

async function compile(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const chosen = [flags.spec, flags.tsx, flags.page].filter((file) => file !== undefined);
  if (chosen.length !== 1)
    throw new Error(`Pass exactly one of --spec, --tsx, or --page. ${USAGE}`);
  if (!flags.theme) throw new Error(`--theme is required. ${USAGE}`);
  if (!flags.size) throw new Error(`--size is required. ${USAGE}`);
  if (!flags.out) throw new Error(`--out is required. ${USAGE}`);
  const file = chosen[0]!;
  const lane = flags.spec ? "spec" : flags.tsx ? "tsx" : "page";
  const bytes = NodeFs.readFileSync(file);
  const text = bytes.toString("utf8");
  const theme = flags.theme;
  const title = flags.name;
  const compiled =
    lane === "page"
      ? await compilePage({ spec: text, brand: theme, ...(title ? { title } : {}) })
      : await compileArtifact(
          lane === "tsx"
            ? { tsx: text, theme, ...(title ? { title } : {}) }
            : { spec: text, theme, ...(title ? { title } : {}) },
        );
  const stamp = readStamp(compiled.html);
  if (!stamp) throw new Error("Compiled HTML is missing the nofun-artifact stamp.");
  const size = parseCanvasSize(flags.size);
  const background = parseCanvasBackground(flags.background ?? "transparent");
  const manifest = writeCanvasBundle({
    outDir: flags.out,
    html: compiled.html,
    name: title?.trim() || compiled.title,
    size,
    background,
    stamp,
    sourceFile: { name: NodePath.basename(file), bytes },
  });
  console.log(
    `${manifest.name} ${compiled.lane} ${(compiled.bytes / 1024).toFixed(0)} KiB → ${NodePath.resolve(flags.out)}`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) throw new Error(USAGE);
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return;
  }
  if (argv[0] !== "compile")
    throw new Error(`Unknown command ${JSON.stringify(argv[0])}. ${USAGE}`);
  await compile(argv.slice(1));
}

const invoked = process.argv[1] ? pathToFileURL(NodePath.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
