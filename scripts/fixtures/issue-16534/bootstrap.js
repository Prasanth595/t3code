(() => {
  const NativeDate = Date,
    epoch = NativeDate.parse("2026-10-22T00:00:00.000Z");
  class FixtureDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [epoch]));
    }
    static now() {
      return epoch;
    }
  }
  globalThis.Date = FixtureDate;
  globalThis.__sidebarCaptureClock = {
    epoch,
    readyState: document.readyState,
    moduleScripts: document.querySelectorAll('script[type="module"]').length,
  };
  const config = JSON.parse(sessionStorage.getItem("sidebar-capture-config") || "{}");
  for (const [key, value] of Object.entries(config.storage || {}))
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
})();
