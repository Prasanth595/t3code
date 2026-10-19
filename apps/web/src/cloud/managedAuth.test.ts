// @vitest-environment jsdom

import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import { act, createElement, type PropsWithChildren, useState } from "react";
import ReactDOM, { type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
} from "./managedAuth";

const fixture = vi.hoisted(() => {
  let completeCleanup = () => {};
  const cleanupFinished = new Promise<void>((resolve) => {
    completeCleanup = resolve;
  });
  return { signOut: () => {}, cleanupFinished, completeCleanup };
});

vi.mock("@clerk/react", async () => {
  const { createContext, useContext } = await import("react");
  const AuthContext = createContext({ isSignedIn: false });
  const getToken = async () => null;
  return {
    ClerkProvider: ({ children }: PropsWithChildren) => {
      const [isSignedIn, setSignedIn] = useState(true);
      fixture.signOut = () => setSignedIn(false);
      return createElement(AuthContext.Provider, { value: { isSignedIn } }, children);
    },
    useAuth: () => {
      const { isSignedIn } = useContext(AuthContext);
      return { isLoaded: true, isSignedIn, userId: isSignedIn ? "demo-account" : null, getToken };
    },
  };
});

vi.mock("../connection/catalog", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const catalogValueAtom = Atom.make({
    entries: new Map([
      ["relay-demo", true],
      ["independent-direct", false],
    ]),
  });
  return {
    environmentCatalog: {
      catalogValueAtom,
      // Each real registry owns its catalog state; registry.test covers route-removal policy.
      removeRelayEnvironments: {
        label: "test:remove-relay-environments",
        run: async (registry: import("effect/reactivity/AtomRegistry").AtomRegistry) => {
          registry.set(catalogValueAtom, {
            entries: new Map(
              [...registry.get(catalogValueAtom).entries].filter(([, relay]) => !relay),
            ),
          });
          fixture.completeCleanup();
          return AsyncResult.success(undefined);
        },
      },
    },
  };
});

function CatalogView() {
  const { entries } = useAtomValue(environmentCatalog.catalogValueAtom);
  return createElement("div", null, [...entries.keys()].join(", "));
}

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  RouterProvider: () => createElement(CatalogView),
}));
vi.mock("../router", () => ({ getRouter: () => ({ load: async () => {} }) }));
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("../providerAuthDelivery", () => ({ prepareProviderAuthDelivery: () => {} }));
vi.mock("./publicConfig", () => ({
  hasCloudPublicConfig: () => true,
  resolveRelayClerkTokenOptions: () => ({}),
}));
vi.mock("../lib/runtime", () => ({
  runtime: { runPromiseExit: async () => ({ _tag: "Success", value: undefined }) },
}));
vi.mock("../browser/BrowserProfileReporter", () => ({ BrowserProfileReporter: () => null }));
vi.mock("../browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("../components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));

let root: Root | undefined;

afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  deactivateManagedRelayAuthentication();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("managed relay authentication", () => {
  it("clears all token access synchronously before account cleanup can fail", async () => {
    activateManagedRelayAuthentication("account-1", async () => "account-1-token");
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    const token = await Effect.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)).pipe(
      Effect.flatMap((session) => session.readClerkToken()),
      Effect.runPromise,
    );
    expect(token).toBe("account-1-token");

    deactivateManagedRelayAuthentication();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    await cleanup;
  });

  it("replaces an existing account session atomically", () => {
    setManagedRelaySession(appAtomRegistry, {
      accountId: "account-1",
      readClerkToken: async () => "account-1-token",
    });

    activateManagedRelayAuthentication("account-2", async () => "account-2-token");

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-2");
  });

  it("sign-out removes Relay environments from the catalog rendered by the app", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_synthetic");
    const container = document.createElement("div");
    container.id = "root";
    document.body.append(container);

    const createRoot = ReactDOM.createRoot;
    vi.spyOn(ReactDOM, "createRoot").mockImplementation((...args) => (root = createRoot(...args)));
    // Boot the production provider tree so auth and routed UI must select the same registry.
    await act(async () => {
      const { startup } = await import("../main");
      await startup;
    });
    expect(container.textContent).toBe("relay-demo, independent-direct");

    await act(() => fixture.signOut());
    await act(async () => {
      await fixture.cleanupFinished;
    });

    expect(container.textContent).toBe("independent-direct");
  });
});
