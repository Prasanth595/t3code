// Scripts run inside the Factory WebView. The web app changes URL through the history
// API, so a navigation callback alone would miss most moves.

/** Reports the location on load and on every history change, and reports a 401 from the status endpoint. */
export const FACTORY_BEFORE_CONTENT_LOADED_SCRIPT = `
(function () {
  if (window.__factoryBridge) return;
  window.__factoryBridge = true;
  function post(message) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  function reportLocation() {
    post({ type: "location", href: window.location.href });
  }
  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    history[name] = function () {
      var result = original.apply(this, arguments);
      reportLocation();
      return result;
    };
  });
  window.addEventListener("popstate", reportLocation);
  var originalFetch = window.fetch;
  window.fetch = function () {
    var input = arguments[0];
    var url = typeof input === "string" ? input : input && input.url;
    return originalFetch.apply(this, arguments).then(function (response) {
      if (response.status === 401 && url && url.indexOf("/api/factory/status") !== -1) {
        post({ type: "unauthorized" });
      }
      return response;
    });
  };
  reportLocation();
})();
true;
`;

/** Trades a one-time pairing credential for the browser session cookie, then opens the Factory pages. */
export function factoryExchangeScript(credential: string): string {
  return `
(function () {
  function post(ok) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "exchange", ok: ok }));
  }
  fetch("/api/auth/browser-session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: ${JSON.stringify(credential)} }),
  })
    .then(function (response) {
      post(response.ok);
      if (response.ok) window.location.replace("/factory");
    })
    .catch(function () {
      post(false);
    });
})();
true;
`;
}
