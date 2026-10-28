import "~/index.css";

import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

function ModelPicker() {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("Claude Fable 5.1 Medium");
  return (
    <div className="flex w-96 justify-end">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger>{label}</PopoverTrigger>
        <PopoverPopup data-testid="popup">
          <button
            type="button"
            onClick={() => {
              setLabel("Sol");
              setOpen(false);
            }}
          >
            Pick
          </button>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

it("keeps a closing popover in place when its trigger resizes", async () => {
  await using _screen = await render(<ModelPicker />);
  await userEvent.click(page.getByRole("button", { name: "Claude Fable 5.1 Medium" }));
  const popup = page.getByTestId("popup");
  await expect.element(popup).toBeVisible();
  const positioner = popup.element().parentElement!;
  const openLeft = positioner.getBoundingClientRect().left;
  const closingLefts: number[] = [];
  const observer = new MutationObserver(() => {
    closingLefts.push(positioner.getBoundingClientRect().left);
  });
  observer.observe(positioner, { attributes: true, attributeFilter: ["style"] });

  await userEvent.click(page.getByRole("button", { name: "Pick" }));
  await expect.element(popup).not.toBeInTheDocument();
  observer.disconnect();

  expect(closingLefts.filter((left) => left !== openLeft)).toEqual([]);
});
