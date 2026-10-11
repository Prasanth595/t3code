// @effect-diagnostics nodeBuiltinImport:off - Vite's build plugin runs before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import type { Plugin } from "vite-plus";

const compressBrotli = NodeUtil.promisify(NodeZlib.brotliCompress);
const compressGzip = NodeUtil.promisify(NodeZlib.gzip);

const compressStreaming = async (filePath: string, compressor: NodeStream.Duplex) => {
  const chunks: Uint8Array[] = [];
  await NodeStreamPromises.pipeline(
    NodeFS.createReadStream(filePath, { highWaterMark: 65_536 }),
    compressor,
    new NodeStream.Writable({
      write(chunk: Uint8Array, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  );
  return Buffer.concat(chunks);
};

/** Move static asset compression to the build without increasing transferred bytes. */
export function precompressPlugin(): Plugin {
  let outDir = "";
  return {
    name: "t3code:precompress",
    apply: "build",
    configResolved(config) {
      outDir = NodePath.resolve(config.root, config.build.outDir);
    },
    async writeBundle(_options, bundle) {
      // Read final output, including sourcemap comments. Keep encodes sequential.
      for (const fileName of Object.keys(bundle)) {
        if (!/^assets\/.*\.(?:js|css)$/.test(fileName)) continue;
        const filePath = NodePath.resolve(outDir, fileName);
        const source = await NodeFSP.readFile(filePath);
        // Large files carry the startup cost; avoid hundreds of tiny release artifacts.
        if (source.length < 65_536) continue;
        // Match Effect's 64 KiB streaming baseline, including its per-chunk flushes.
        const br4 = await compressStreaming(
          filePath,
          NodeZlib.createBrotliCompress({
            params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 4 },
            flush: NodeZlib.constants.BROTLI_OPERATION_FLUSH,
          }),
        );
        const br11 = await compressBrotli(source, {
          params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 11 },
        });
        const gz6 = await compressStreaming(
          filePath,
          NodeZlib.createGzip({ level: 6, flush: NodeZlib.constants.Z_SYNC_FLUSH }),
        );
        const gz9 = await compressGzip(source, { level: 9 });
        // Higher quality can occasionally be larger; retain the runtime baseline then.
        await NodeFSP.writeFile(`${filePath}.br`, br11.length <= br4.length ? br11 : br4);
        await NodeFSP.writeFile(`${filePath}.gz`, gz9.length <= gz6.length ? gz9 : gz6);
      }
    },
  };
}
