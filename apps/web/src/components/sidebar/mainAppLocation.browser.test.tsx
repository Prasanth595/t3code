import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { MainAppLocationTracker, useNavigateToMainApp } from "./mainAppLocation";

function LeaveUtilityPage() {
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <>
      <MainAppLocationTracker />
      <button type="button" onClick={() => void navigateToMainApp()}>
        Back to threads
      </button>
    </>
  );
}

describe("leaving a utility page", () => {
  it("preserves forward history when the remembered thread lies ahead", async () => {
    await using screen = await render(<LeaveUtilityPage />, { router: "/env/thread-a" });
    const router = screen.router!;

    await act(() => router.navigate({ href: "/settings/general" }));
    await act(() => router.navigate({ href: "/env/thread-b" }));
    await act(() => router.navigate({ href: "/settings/appearance" }));
    await act(() => router.history.back());
    await act(() => router.history.back());
    expect(router.state.location.pathname).toBe("/settings/general");

    await screen.getByRole("button", { name: "Back to threads" }).click();
    expect(router.state.location.pathname).toBe("/env/thread-b");
    await act(() => router.history.forward());
    expect(router.state.location.pathname).toBe("/settings/appearance");
  });

  it("keeps the remembered entry when traversing past it without overwriting it", async () => {
    await using screen = await render(<LeaveUtilityPage />, { router: "/settings" });
    const router = screen.router!;

    await act(() => router.navigate({ href: "/env/thread-a" }));
    await act(() => router.navigate({ href: "/settings/general" }));
    await act(() => router.history.go(-2));
    await act(() => router.history.go(2));
    await screen.getByRole("button", { name: "Back to threads" }).click();

    expect(router.state.location.pathname).toBe("/env/thread-a");
    await act(() => router.history.forward());
    expect(router.state.location.pathname).toBe("/settings/general");
  });

  it("does not traverse to a utility page that replaced the remembered entry", async () => {
    await using screen = await render(<LeaveUtilityPage />, { router: "/env/thread-a" });
    const router = screen.router!;

    await act(() => router.navigate({ href: "/settings/general", replace: true }));
    await act(() => router.navigate({ href: "/usage" }));
    await screen.getByRole("button", { name: "Back to threads" }).click();
    expect(router.state.location.pathname).toBe("/env/thread-a");
  });

  it("closing Settings preserves earlier threads and forward history", async () => {
    await using screen = await render(<LeaveUtilityPage />, { router: "/env/thread-a" });
    const router = screen.router!;

    await act(() => router.navigate({ href: "/env/thread-b" }));
    await act(() => router.navigate({ href: "/settings/general" }));
    await act(() => router.navigate({ href: "/settings/appearance" }));
    await act(() => router.navigate({ href: "/settings/open-source-licenses" }));
    await screen.getByRole("button", { name: "Back to threads" }).click();
    expect(router.state.location.pathname).toBe("/env/thread-b");

    await act(() => router.history.back());
    expect(router.state.location.pathname).toBe("/env/thread-a");
    await act(() => router.history.forward());
    expect(router.state.location.pathname).toBe("/env/thread-b");
    await act(() => router.history.forward());
    expect(router.state.location.pathname).toBe("/settings/general");
  });

  it("returns to the remembered thread after its history entry is replaced", async () => {
    await using screen = await render(<LeaveUtilityPage />, { router: "/settings" });
    const router = screen.router!;

    await act(() => router.navigate({ href: "/env/thread-a" }));
    await act(() => router.history.back());
    await act(() => router.navigate({ href: "/usage" }));
    await act(() => router.navigate({ href: "/settings" }));
    await screen.getByRole("button", { name: "Back to threads" }).click();
    expect(router.state.location.pathname).toBe("/env/thread-a");
  });
});
