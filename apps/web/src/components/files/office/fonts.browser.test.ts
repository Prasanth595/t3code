import { expect, it, vi } from "vite-plus/test";
import { loadFace, presentationFace, wordFonts } from "./fonts";

it.each([
  ["cjk-sc", "SimSun"],
  ["cjk-tc", "Microsoft JhengHei"],
  ["cjk-jp", "Yu Gothic"],
  ["cjk-kr", "Malgun Gothic"],
] as const)("loads local %s fonts for Word and PowerPoint", async (script, family) => {
  using fetch = vi.spyOn(globalThis, "fetch");
  const provider = wordFonts();
  const fallback = provider.resolveScriptFallback?.(script, false, false);
  const named = provider.resolve(family, false, false);

  expect(fallback).toBeTypeOf("function");
  expect(named).toBeTypeOf("function");
  expect(fetch).not.toHaveBeenCalled();

  const face = presentationFace(family, false, false);
  expect(face.script).toBe(script);

  const buffers = await Promise.all([fallback!(), named!(), loadFace(face)]);
  for (const bytes of buffers) {
    const font = await new FontFace("office-preview-test", bytes).load();
    expect(font.status).toBe("loaded");
  }
  expect(fetch).toHaveBeenCalled();
  for (const [url] of fetch.mock.calls)
    expect(new URL(String(url), location.href).origin).toBe(location.origin);
});

it("loads Latin fonts without fetching CJK assets", async () => {
  using fetch = vi.spyOn(globalThis, "fetch");
  const load = wordFonts().resolve("Calibri", false, false);
  expect(fetch).not.toHaveBeenCalled();
  expect(load).toBeTypeOf("function");
  await new FontFace("office-latin-test", await load!()).load();
  expect(fetch).toHaveBeenCalled();
  for (const [url] of fetch.mock.calls)
    expect(String(url)).not.toMatch(/Noto(?:Sans|Serif)(?:SC|TC|JP|KR)/);
});
