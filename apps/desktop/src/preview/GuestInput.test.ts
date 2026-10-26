import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

import { sendPageCommand, toKeyboardInputEvents } from "./GuestInput.ts";

const GUEST_ID = 7;

interface FakeElement {
  readonly localName: string;
  readonly isConnected: boolean;
  getWebContentsId(): number;
  focus(): void;
  blur(): void;
}

/** The app window around a guest, with a stand-in document for the focus scripts to run against. */
const makeHost = () => {
  const makeElement = (localName: string, guestId = -1) => {
    const element: FakeElement = {
      localName,
      isConnected: true,
      getWebContentsId: () => guestId,
      focus: () => {
        state.active = element;
      },
      blur: () => {
        if (state.active === element) state.active = body;
      },
    };
    return element;
  };
  const state = { active: undefined as FakeElement | undefined };
  const body = makeElement("body");
  const composer = makeElement("div");
  const search = makeElement("input");
  const webview = makeElement("webview", GUEST_ID);
  state.active = body;
  const context = NodeVM.createContext({
    document: {
      get activeElement() {
        return state.active;
      },
    },
  });
  return {
    body,
    composer,
    search,
    webview,
    makeElement,
    activeElement: () => state.active,
    hostWebContents: {
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async (script: string) => NodeVM.runInContext(script, context)),
    },
  };
};

/**
 * A guest whose page reports `focusedDocument` for the focus probe. Inside a
 * `host` it holds the window's focus while the host's webview is the active
 * element, and its page takes that focus on a mouse press, as Chromium does.
 */
const makeGuest = ({
  focusedDocument = true,
  host,
  webview = host?.webview,
}: {
  readonly focusedDocument?: boolean;
  readonly host?: ReturnType<typeof makeHost>;
  readonly webview?: FakeElement;
} = {}) => {
  const sendCommand = vi.fn(
    async (method: string, params?: { expression?: string; type?: string }) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
        webview?.focus();
      }
      return method === "Runtime.evaluate" && params?.expression?.endsWith("!== null")
        ? { result: { value: focusedDocument } }
        : { result: {} };
    },
  );
  const webContents = {
    id: webview?.getWebContentsId() ?? GUEST_ID,
    hostWebContents: host?.hostWebContents,
    get focusedFrame() {
      return host && host.activeElement() === webview ? {} : null;
    },
    insertText: vi.fn(async () => {}),
    sendInputEvent: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  };
  return {
    webContents,
    sendCommand,
    send: (method: string, params: Record<string, unknown>) =>
      sendPageCommand(
        webContents as unknown as Electron.WebContents,
        { sendCommand } as unknown as Electron.Debugger,
        method,
        params,
      ),
  };
};

describe("preview guest input", () => {
  it("types into an unfocused guest's own page, not the app's focused field", async () => {
    const guest = makeGuest();
    await guest.send("Input.insertText", { text: "pairing-code" });
    expect(guest.webContents.insertText).toHaveBeenCalledWith("pairing-code");
    expect(guest.sendCommand).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it("refuses input when a cross-site frame holds the unfocused page's focus", async () => {
    const guest = makeGuest({ focusedDocument: false });
    await expect(guest.send("Input.insertText", { text: "secret" })).rejects.toThrow(
      /cross-site frame/,
    );
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
  });

  describe("an agent's mouse input in an unfocused guest", () => {
    const press = { type: "mousePressed", button: "left", x: 4, y: 5, clickCount: 1 };

    it("hands the app's focused field its focus back once the page has been clicked", async () => {
      const host = makeHost();
      host.composer.focus();
      const guest = makeGuest({ host });
      await guest.send("Input.dispatchMouseEvent", press);
      expect(guest.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", press);
      expect(host.activeElement()).toBe(host.composer);
    });

    it("takes focus off the preview when nothing in the app held it", async () => {
      const host = makeHost();
      const guest = makeGuest({ host });
      await guest.send("Input.dispatchMouseEvent", press);
      expect(host.activeElement()).toBe(host.body);
    });

    it("leaves focus where the person moved it during the click", async () => {
      const host = makeHost();
      host.composer.focus();
      const guest = makeGuest({ host });
      guest.sendCommand.mockImplementationOnce(async () => {
        host.webview.focus();
        host.search.focus();
        return { result: {} };
      });
      await guest.send("Input.dispatchMouseEvent", press);
      expect(host.activeElement()).toBe(host.search);
    });

    it("hands focus back when the click fails", async () => {
      const host = makeHost();
      host.composer.focus();
      const guest = makeGuest({ host });
      guest.sendCommand.mockImplementationOnce(async () => {
        host.webview.focus();
        throw new Error("Target closed");
      });
      await expect(guest.send("Input.dispatchMouseEvent", press)).rejects.toThrow("Target closed");
      expect(host.activeElement()).toBe(host.composer);
    });

    it.each([GUEST_ID, GUEST_ID + 1])(
      "restores focus after overlapping clicks in guest %s",
      async (guestId) => {
        const host = makeHost();
        host.composer.focus();
        const guest = makeGuest({ host });
        const webview = guestId === GUEST_ID ? host.webview : host.makeElement("webview", guestId);
        const other = guestId === GUEST_ID ? guest : makeGuest({ host, webview });
        const finishPress = Promise.withResolvers<void>();
        const finishRelease = Promise.withResolvers<void>();
        const pressStarted = Promise.withResolvers<void>();
        const releaseStarted = Promise.withResolvers<void>();
        guest.sendCommand.mockImplementationOnce(async () => {
          host.webview.focus();
          pressStarted.resolve();
          await finishPress.promise;
          return { result: {} };
        });
        other.sendCommand.mockImplementationOnce(async () => {
          webview.focus();
          releaseStarted.resolve();
          await finishRelease.promise;
          // A slow page focuses itself once it handles the event, after the press is done.
          webview.focus();
          return { result: {} };
        });
        const pressing = guest.send("Input.dispatchMouseEvent", press);
        await pressStarted.promise;
        expect(host.activeElement()).toBe(host.webview);
        // The relay forwards the release without waiting for the press to finish.
        const releasing = other.send("Input.dispatchMouseEvent", {
          ...press,
          type: "mouseReleased",
        });
        await releaseStarted.promise;
        finishPress.resolve();
        await pressing;
        finishRelease.resolve();
        await releasing;
        expect(host.activeElement()).toBe(host.composer);
      },
    );

    it("holds a click that arrives while the app's focus is being handed back", async () => {
      const host = makeHost();
      host.composer.focus();
      const guest = makeGuest({ host });
      const runScript = host.hostWebContents.executeJavaScript.getMockImplementation()!;
      let finishRestore = () => {};
      const restoreStarted = Promise.withResolvers<void>();
      host.hostWebContents.executeJavaScript
        .mockImplementationOnce(runScript)
        .mockImplementationOnce(async (script: string) => {
          restoreStarted.resolve();
          await new Promise<void>((resolve) => {
            finishRestore = resolve;
          });
          return runScript(script);
        });
      const first = guest.send("Input.dispatchMouseEvent", press);
      await Promise.race([restoreStarted.promise, first]);
      expect(host.hostWebContents.executeJavaScript).toHaveBeenCalledTimes(2);
      const second = guest.send("Input.dispatchMouseEvent", press);
      // The preview still holds the window's focus here; the click must wait for the hand-back.
      expect(guest.sendCommand).toHaveBeenCalledTimes(1);
      finishRestore();
      await Promise.all([first, second]);
      expect(host.activeElement()).toBe(host.composer);
    });

    it("does not touch the app's focus while the person has the preview focused", async () => {
      const host = makeHost();
      host.webview.focus();
      const guest = makeGuest({ host });
      await guest.send("Input.dispatchMouseEvent", press);
      expect(host.hostWebContents.executeJavaScript).not.toHaveBeenCalled();
      expect(host.activeElement()).toBe(host.webview);
    });

    it("keeps the originally focused guest when overlapping clicks return to it", async () => {
      const host = makeHost();
      host.webview.focus();
      const guest = makeGuest({ host });
      const other = makeGuest({ host, webview: host.makeElement("webview", GUEST_ID + 1) });
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      other.sendCommand.mockImplementationOnce(async () => {
        started.resolve();
        await finish.promise;
        return { result: {} };
      });
      const clicking = other.send("Input.dispatchMouseEvent", press);
      await started.promise;
      await guest.send("Input.dispatchMouseEvent", press);
      finish.resolve();
      await clicking;
      expect(host.activeElement()).toBe(host.webview);
    });
  });
});

describe("CDP key events as Electron input", () => {
  it("sends a key's text as char events after its key down", () => {
    expect(toKeyboardInputEvents({ type: "keyDown", key: "Enter", text: "\r" })).toEqual([
      { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
      { type: "char", keyCode: "\r", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "keyDown", key: "é", text: "é", modifiers: 8 })).toEqual([
      { type: "rawKeyDown", keyCode: "é", modifiers: ["shift"] },
      { type: "char", keyCode: "é", modifiers: ["shift"] },
    ]);
  });

  // regression: #18556 agent typing in a preview tab landed in the app instead of the guest
  it("names arrows and function keys as Electron accelerators", () => {
    expect(toKeyboardInputEvents({ type: "keyUp", key: "ArrowLeft", modifiers: 3 })).toEqual([
      { type: "keyUp", keyCode: "Left", modifiers: ["alt", "control"] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "F12" })).toEqual([
      { type: "rawKeyDown", keyCode: "F12", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "AudioVolumeUp" })).toEqual([]);
  });
});
