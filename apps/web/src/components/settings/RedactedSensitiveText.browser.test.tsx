import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

describe("RedactedSensitiveText", () => {
  it("names the button with the value only while it is revealed", async () => {
    await using _screen = await render(
      <RedactedSensitiveText
        value="my.1password.com"
        ariaLabel="Toggle account visibility"
        revealTooltip="Click to reveal account"
        hideTooltip="Click to hide account"
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "Toggle account visibility" }));
    await expect
      .element(page.getByRole("button", { name: "my.1password.com", pressed: true }))
      .toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "my.1password.com" }));
    await expect
      .element(page.getByRole("button", { name: "Toggle account visibility", pressed: false }))
      .toBeInTheDocument();
  });
});
