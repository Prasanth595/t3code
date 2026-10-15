import { describe, expect, it } from "vite-plus/test";

import { binaryFileInfo } from "./binaryFileInfo";

describe("binaryFileInfo", () => {
  it.each([
    ["/workspace/slides.PPTX", "slides.PPTX", "PowerPoint presentation"],
    ["C:\\work\\report.docx", "report.docx", "Word document"],
    ["budget.numbers", "budget.numbers", "Numbers spreadsheet"],
    ["assets.zip", "assets.zip", "Archive"],
    ["font.woff2", "font.woff2", "Font"],
    ["scene.glb", "scene.glb", "3D model"],
    ["photo.psd", "photo.psd", "Image"],
    ["recording.flac", "recording.flac", "Audio"],
    ["movie.mkv", "movie.mkv", "Video"],
  ])("labels and allows document-like file %s", (path, name, kind) => {
    expect(binaryFileInfo(path)).toEqual({ name, kind, canOpenDefault: true });
  });

  it.each([
    "program.exe",
    "install.msi",
    "App.app",
    "run.sh",
    "run.command",
    "run.bat",
    "run.cmd",
    "run.ps1",
    "run.py",
    "run.js",
    "page.html",
    "image.svg",
    "slides.pptx.exe",
    "slides.pptm",
    "unknown.bin",
    "no-extension",
  ])("does not offer default-app open for %s", (path) => {
    expect(binaryFileInfo(path).canOpenDefault).toBe(false);
  });

  it("describes unknown formats without assuming an application", () => {
    expect(binaryFileInfo("data.bin").kind).toBe("BIN file");
    expect(binaryFileInfo("data").kind).toBe("Binary file");
  });
});
