import { spawnSync } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { writeCanvasBundle } from "../src/canvas-bundle.ts";
import { ARTIFACT_CATALOG, validateArtifactSpec } from "../src/catalog.ts";
import { inlineStageAssets, stageAssets } from "../src/live/assets.ts";
import type { ArtifactStamp } from "../src/stamp.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const STAMP: ArtifactStamp = {
  components: "8922135e5cdf4d172be6e0eaeffa73009b6a5257",
  compiler: "0.0.0",
  lane: "spec",
  theme: "kobra",
  at: "2026-10-14T00:00:00Z",
};

function gallerySrcMax(): number {
  const items = ARTIFACT_CATALOG.Gallery?.props.items?.type;
  if (items?.kind !== "array") throw new Error("Gallery items is not an array");
  const item = items.items;
  if (item.kind !== "object") throw new Error("Gallery item is not an object");
  const src = item.fields.src?.type;
  if (src?.kind !== "string" || src.max === undefined) throw new Error("Gallery src has no max");
  return src.max;
}

test("Gallery src accepts a data URI longer than 4096 characters", () => {
  const max = gallerySrcMax();
  assert.ok(max > 4096);
  const prefix = "data:image/webp;base64,";
  const fits = prefix + "A".repeat(max - prefix.length);
  assert.equal(fits.length, max);
  const spec = validateArtifactSpec({
    root: {
      component: "Gallery",
      props: { items: [{ src: fits, alt: "tile" }] },
    },
  });
  const items = spec.root.props?.items as Array<{ src: string }>;
  assert.equal(items[0]?.src, fits);
  assert.throws(
    () =>
      validateArtifactSpec({
        root: {
          component: "Gallery",
          props: { items: [{ src: `${fits}A`, alt: "tile" }] },
        },
      }),
    /at most 65536 characters/,
  );
});

test("stage images are copied under assets/ and inlined into #nf-assets", () => {
  const assetDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "nf-stage-"));
  const out = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "nf-stage-out-"));
  try {
    const tile = Buffer.from("RIFFxxxxWEBP");
    const shot = Buffer.from("png-bytes");
    NodeFs.writeFileSync(NodePath.join(assetDir, "tile-01.webp"), tile);
    NodeFs.mkdirSync(NodePath.join(assetDir, "taste", "tiles"), { recursive: true });
    NodeFs.writeFileSync(NodePath.join(assetDir, "taste", "tiles", "shot.png"), shot);
    const outside = NodePath.join(NodePath.dirname(assetDir), "secret.webp");
    NodeFs.writeFileSync(outside, Buffer.from("nope"));
    const shotPath = NodePath.join(assetDir, "taste", "tiles", "shot.png");
    const text = JSON.stringify({
      root: {
        component: "Gallery",
        props: {
          items: [
            { src: "assets/tile-01.webp", alt: "tile" },
            { src: shotPath, alt: "shot" },
            { src: outside, alt: "outside" },
            { src: "assets/../../secret.webp", alt: "escape" },
          ],
        },
      },
    });
    const staged = stageAssets(assetDir, text);
    assert.equal(staged.text.includes(shotPath), false);
    assert.match(staged.text, /assets\/taste\/tiles\/shot\.png/);
    assert.match(staged.text, /assets\/tile-01\.webp/);
    assert.equal(staged.text.includes(outside), true);
    assert.equal(staged.text.includes("assets/../../secret.webp"), true);
    assert.deepEqual(
      staged.files.map((file) => file.bundlePath).sort(),
      ["assets/taste/tiles/shot.png", "assets/tile-01.webp"],
    );
    assert.deepEqual(staged.skippedInline, []);
    const html = inlineStageAssets(
      [
        "<!doctype html><html><head></head><body>",
        '<script type="application/json" id="nf-assets">{}</script>',
        "</body></html>",
      ].join(""),
      staged.files,
    );
    assert.match(html, /data:image\/webp;base64,/);
    assert.match(html, /data:image\/png;base64,/);
    writeCanvasBundle({
      outDir: out,
      html,
      name: "Tiles",
      size: { width: 960, height: 600 },
      background: "transparent",
      stamp: STAMP,
      sourceFile: { name: "stage.spec.json", bytes: Buffer.from(text) },
      assets: staged.files,
    });
    assert.deepEqual(NodeFs.readFileSync(NodePath.join(out, "assets", "tile-01.webp")), tile);
    assert.deepEqual(
      NodeFs.readFileSync(NodePath.join(out, "assets", "taste", "tiles", "shot.png")),
      shot,
    );
    assert.match(
      NodeFs.readFileSync(NodePath.join(out, "index.html"), "utf8"),
      /data:image\/webp;base64,/,
    );
    assert.equal(
      NodeFs.readFileSync(NodePath.join(out, "source", "stage.spec.json"), "utf8"),
      text,
    );
    assert.throws(
      () =>
        writeCanvasBundle({
          outDir: out,
          html,
          name: "Tiles",
          size: { width: 960, height: 600 },
          background: "transparent",
          stamp: STAMP,
          sourceFile: { name: "stage.spec.json", bytes: Buffer.from(text) },
          assets: [{ bundlePath: "assets/../../secret.webp", bytes: Buffer.from("x") }],
        }),
      /under assets/,
    );
    NodeFs.rmSync(outside, { force: true });
  } finally {
    NodeFs.rmSync(assetDir, { recursive: true, force: true });
    NodeFs.rmSync(out, { recursive: true, force: true });
  }
});

test("compile --asset-dir is a flag and refuses a missing directory", () => {
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--asset-dir <dir>/);

  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "nf-asset-cli-"));
  try {
    const spec = NodePath.join(dir, "gallery.spec.json");
    NodeFs.writeFileSync(spec, "{}\n");
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "compile",
        "--spec",
        spec,
        "--preset",
        "canvas-dark-kobra",
        "--asset-dir",
        NodePath.join(dir, "missing"),
        "--out",
        NodePath.join(dir, "out"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--asset-dir/);
    assert.equal(NodeFs.existsSync(NodePath.join(dir, "out")), false);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stageAssets refuses a missing directory", () => {
  assert.throws(() => stageAssets("/no/such/nf-asset-dir", ""), /does not exist/);
});
