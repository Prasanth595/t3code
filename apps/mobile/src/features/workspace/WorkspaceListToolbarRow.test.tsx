import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { WorkspaceListToolbarRow } from "./WorkspaceListToolbarRow";

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
  }: {
    readonly children: ReactNode;
    readonly onPress?: () => void;
  }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  Animated: {
    View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    Value: class {
      constructor(readonly initial: number) {}
    },
    timing: () => ({ start() {}, stop() {} }),
  },
}));
vi.mock("../../components/CompactBrandTitle", () => ({
  brandTitleOffset: () => 0,
  CompactBrandTitle: () => <span data-testid="brand">T3 Code</span>,
}));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({
  AndroidHeaderIconButton: () => <button type="button" />,
}));
vi.mock("../../components/ui/useToolbarLayout", () => ({
  useToolbarLayout: () => ({ height: 56, paddingTop: 0, paddingBottom: 0 }),
}));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1 }),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../lib/clock", () => ({ useDeadlinePassed: () => false }));
vi.mock("../../state/workspace", () => ({}));
vi.mock("./workspace-connection-status", () => ({
  workspaceConnectionStatusPresentation: () => null,
}));

function renderRow(props: {
  readonly onOpenEnvironments: () => void;
  readonly onOpenHome?: () => void;
}) {
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    container,
    render: () =>
      act(async () =>
        root.render(
          <WorkspaceListToolbarRow
            filter={null}
            onCloseSearch={() => undefined}
            onOpenEnvironments={props.onOpenEnvironments}
            onOpenSearch={() => undefined}
            searchAccessibilityLabel="Search threads"
            searchField={null}
            searching={false}
            titleAccessibilityLabel="T3 Code, Threads"
            {...(props.onOpenHome === undefined ? {} : { onOpenHome: props.onOpenHome })}
          />,
        ),
      ),
    unmount: () => act(() => root.unmount()),
  };
}

it("takes the drawer's brand back to the home list instead of environments", async () => {
  const onOpenEnvironments = vi.fn();
  const onOpenHome = vi.fn();
  const row = renderRow({ onOpenEnvironments, onOpenHome });
  await row.render();

  act(() => row.container.querySelector("[data-testid=brand]")!.closest("button")!.click());

  expect(onOpenHome).toHaveBeenCalledTimes(1);
  expect(onOpenEnvironments).not.toHaveBeenCalled();
  row.unmount();
});

it("opens environments from the brand where no home action is given", async () => {
  const onOpenEnvironments = vi.fn();
  const row = renderRow({ onOpenEnvironments });
  await row.render();

  act(() => row.container.querySelector("[data-testid=brand]")!.closest("button")!.click());

  expect(onOpenEnvironments).toHaveBeenCalledTimes(1);
  row.unmount();
});
