import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { Route } from "./_chat.new";

const NewThreadLinkRoute = Route.options.component!;

describe("/new link route", () => {
  it("redirects a bare /new to the new-thread view", async () => {
    await using screen = await render(<NewThreadLinkRoute />, { router: "/new" });

    await expect.poll(() => screen.router?.state.location.pathname).toBe("/");
    await expect.element(page.getByText("Could not open the link")).not.toBeInTheDocument();
  });

  it("still explains a malformed link", async () => {
    await using _screen = await render(<NewThreadLinkRoute />, { router: "/new?repo=%20" });

    await expect.element(page.getByText("Could not open the link")).toBeVisible();
  });
});
