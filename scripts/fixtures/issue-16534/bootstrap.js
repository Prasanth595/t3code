/** Reboot the real Vite document with a deterministic client clock and storage.
 * Run in the capture tab through preview_evaluate after pairing. The returned
 * source document is unmodified except for this pre-module fixture bootstrap.
 * No timer API is replaced. Auth and connection storage are preserved.
 */
async function rebootSidebarFixture(fixture) {
  const response = await fetch(location.href, { cache: "no-store" });
  if (!response.ok) throw new Error(`Fixture document fetch failed: ${response.status}`);
  const html = await response.text();
  const source = `(() => {
    const fixture = ${JSON.stringify(fixture).replaceAll("<", "\\u003c")};
    const NativeDate = Date;
    const epoch = NativeDate.parse(fixture.clock);
    class FixtureDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [epoch])); }
      static now() { return epoch; }
    }
    globalThis.Date = FixtureDate;
    globalThis.__sidebarCaptureClock = fixture.clock;
    localStorage.setItem('t3code:client-settings:v1', JSON.stringify(fixture.settings));
    localStorage.setItem('t3code:ui-state:v1', JSON.stringify(fixture.uiState));
  })();`;
  if (!html.includes("<head>")) throw new Error("Expected the real application document");
  document.open();
  document.write(html.replace("<head>", `<head><script>${source}</script>`));
  document.close();
}
