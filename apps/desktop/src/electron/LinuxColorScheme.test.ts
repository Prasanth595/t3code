// @effect-diagnostics nodeBuiltinImport:off -- Event-driven fake of the portal transport.
import * as NodeEvents from "node:events";
import { DBusError, Message, MessageType, Variant, type MessageBus } from "dbus-next";
import { expect, it, vi } from "vite-plus/test";

import { watchLinuxColorScheme, type LinuxColorScheme } from "./LinuxColorScheme.ts";

const PATH = "/org/freedesktop/portal/desktop";
const SETTINGS = "org.freedesktop.portal.Settings";

class FakeBus extends NodeEvents.EventEmitter {
  calls: Message[] = [];
  disconnect = vi.fn();
  readonly settings: { readOne?: unknown; read?: unknown };
  constructor(settings: { readOne?: unknown; read?: unknown }) {
    super();
    this.settings = settings;
  }

  async call(message: Message) {
    this.calls.push(message);
    if (message.member === "AddMatch")
      return new Message({ type: MessageType.METHOD_RETURN, replySerial: "1" });
    const value = message.member === "ReadOne" ? this.settings.readOne : this.settings.read;
    if (value === undefined) throw new DBusError("org.freedesktop.DBus.Error.UnknownMethod", "");
    return new Message({
      type: MessageType.METHOD_RETURN,
      replySerial: "1",
      signature: "v",
      body: [value],
    });
  }

  changed(namespace: string, key: string, value: number) {
    this.emit(
      "message",
      new Message({
        type: MessageType.SIGNAL,
        path: PATH,
        interface: SETTINGS,
        member: "SettingChanged",
        body: [namespace, key, new Variant("u", value)],
      }),
    );
  }
}

async function watch(bus: FakeBus) {
  const schemes: LinuxColorScheme[] = [];
  const read = Promise.withResolvers<void>();
  const stop = watchLinuxColorScheme(
    (scheme) => {
      schemes.push(scheme);
      read.resolve();
    },
    bus as unknown as MessageBus,
  );
  await read.promise;
  return { schemes, stop };
}

it("reads the current color scheme and follows portal changes", async () => {
  const bus = new FakeBus({ readOne: new Variant("u", 1) });
  const { schemes, stop } = await watch(bus);

  bus.changed("org.freedesktop.appearance", "color-scheme", 2);
  bus.changed("org.freedesktop.appearance", "accent-color", 1);
  bus.changed("org.gnome.desktop.interface", "color-scheme", 1);
  bus.changed("org.freedesktop.appearance", "color-scheme", 1);
  // GNOME's light mode reports "no preference".
  bus.changed("org.freedesktop.appearance", "color-scheme", 0);
  expect(schemes).toEqual(["dark", "light", "dark", "light"]);

  stop();
  bus.changed("org.freedesktop.appearance", "color-scheme", 1);
  expect(schemes).toEqual(["dark", "light", "dark", "light"]);
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it("falls back to the nested Read reply on portals without ReadOne", async () => {
  const bus = new FakeBus({ read: new Variant("v", new Variant("u", 2)) });
  const { schemes } = await watch(bus);

  expect(schemes).toEqual(["light"]);
  expect(bus.calls.map((call) => call.member)).toEqual(["AddMatch", "ReadOne", "Read"]);
});
