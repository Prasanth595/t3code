// @effect-diagnostics nodeBuiltinImport:off -- Maintains the pinned SDK patch without loading a provider.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const originalGrepOutput =
  "matches:e.result.value.matches?.map((e=>({file:e.file,...void 0!==e.lineNumber?{lineNumber:e.lineNumber}:{},line:e.line,...e.beforeContext?{beforeContext:e.beforeContext}:{},...e.afterContext?{afterContext:e.afterContext}:{}})))??[],totalMatches:e.result.value.totalMatches??0";
const patchedGrepOutput = [
  "matches:e.result.value.matches?.flatMap((e=>{",
  "if(!Array.isArray(e.matches))return[{file:e.file,...void 0!==e.lineNumber?{lineNumber:e.lineNumber}:{},line:e.line,...e.beforeContext?{beforeContext:e.beforeContext}:{},...e.afterContext?{afterContext:e.afterContext}:{}}];",
  "return e.matches.flatMap(((t,r,n)=>{if(t.isContextLine)return[];let s=r,i=r;for(;s>0&&n[s-1].isContextLine;)s--;for(;i+1<n.length&&n[i+1].isContextLine;)i++;",
  "const o=n.slice(s,r).map((e=>e.content)),a=n.slice(r+1,i+1).map((e=>e.content));",
  "return[{file:e.file,...void 0!==t.lineNumber?{lineNumber:t.lineNumber}:{},line:t.content,...o.length?{beforeContext:o}:{},...a.length?{afterContext:a}:{}}]}))",
  "}))??[],totalMatches:e.result.value.totalMatchedLines??e.result.value.totalMatches??0",
].join("");

const originalSha256 = "c57599bbc8c9e18c55d8635c6c1621d746022254308b544ad04469bb9cf274ef";
const patchedSha256 = "43e958124dea446e7e00d15f7736276e923634a4c7e3a13f92fd1582f241d806";

function sha256(source: string): string {
  return NodeCrypto.createHash("sha256").update(source).digest("hex");
}

function cursorGrepSource(source: string, target: "original" | "patched"): string {
  const hash = sha256(source);
  if (hash !== originalSha256 && hash !== patchedSha256) {
    throw new Error(`Unexpected @cursor/sdk 1.0.35 689.js hash: ${hash}`);
  }
  const expected = target === "original" ? originalSha256 : patchedSha256;
  if (hash === expected) return source;
  const [before, after] =
    target === "original"
      ? [patchedGrepOutput, originalGrepOutput]
      : [originalGrepOutput, patchedGrepOutput];
  if (source.split(before).length !== 2) throw new Error("Ambiguous SDK grep patch anchor");
  const result = source.replace(before, () => after);
  if (sha256(result) !== expected) throw new Error("Unexpected generated SDK grep hash");
  return result;
}

// Regenerate with: node scripts/lib/cursor-grep-patch.ts generate <sdk-dir> <patch-file>.
const [command, sdkDirectory, patchFile] = process.argv.slice(2);
if (!sdkDirectory || (command !== "generate" && command !== "verify")) {
  throw new Error("Usage: cursor-grep-patch.ts generate <sdk-dir> <patch-file> | verify <sdk-dir>");
}
const source = await NodeFSP.readFile(NodePath.join(sdkDirectory, "dist/cjs/689.js"), "utf8");
if (command === "verify") {
  if (patchFile !== undefined || sha256(source) !== patchedSha256) {
    throw new Error("The installed @cursor/sdk 1.0.35 does not contain the expected grep patch");
  }
} else {
  if (!patchFile) throw new Error("A destination patch file is required");
  const original = cursorGrepSource(source, "original");
  const patched = cursorGrepSource(source, "patched");
  if (original.includes("\n") || patched.includes("\n")) {
    throw new Error("Expected one minified line in 689.js");
  }
  await NodeFSP.writeFile(
    patchFile,
    "diff --git a/dist/cjs/689.js b/dist/cjs/689.js\n" +
      "--- a/dist/cjs/689.js\n+++ b/dist/cjs/689.js\n@@ -1 +1 @@\n" +
      `-${original}\n\\ No newline at end of file\n` +
      `+${patched}\n\\ No newline at end of file\n`,
  );
}
