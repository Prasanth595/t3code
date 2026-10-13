import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-popup-last-in-spaced-container", {
  filename: "fixture.tsx",
});

const imports = `
import { Menu, MenuTrigger, MenuPopup } from "~/components/ui/menu";
import { Popover } from "../ui/popover";
import { Select } from "~/components/ui/select";
`;

describe("t3code/no-popup-last-in-spaced-container", () => {
  rule.valid(
    "allows a popup followed by a sibling",
    `${imports}
const el = (
  <div className="space-y-3">
    <Menu><MenuTrigger /><MenuPopup /></Menu>
    <p>After</p>
  </div>
);`,
  );

  rule.valid(
    "allows a popup last in a gap container",
    `${imports}
const el = <div className="flex flex-col gap-3"><p>Before</p><Menu /></div>;`,
  );

  rule.valid(
    "allows a popup wrapped in its own element",
    `${imports}
const el = <div className="space-y-3"><p>Before</p><div><Menu /></div></div>;`,
  );

  rule.valid(
    "ignores zero spacing",
    `${imports}
const el = <div className="space-y-0"><p>Before</p><Menu /></div>;`,
  );

  rule.valid(
    "ignores spacing that targets other elements",
    `${imports}
const el = <div className="[&_ul]:space-y-2 *:divide-y [&>li]:space-x-1"><p>Before</p><Menu /></div>;`,
  );

  rule.invalid(
    "reports spacing behind a variant that targets the element itself",
    `${imports}
const el = <div className="[&:hover]:space-y-2 group-hover:space-y-1"><p>Before</p><Menu /></div>;`,
  );

  rule.valid(
    "ignores same-named components that are not ui popups",
    `import { Menu } from "./AppMenu";
const el = <div className="space-y-3"><p>Before</p><Menu /></div>;`,
  );

  rule.valid(
    "allows a select, whose hidden input stays last",
    `${imports}
const el = <div className="space-y-3"><p>Before</p><Select /></div>;`,
  );

  rule.invalid(
    "reports a popup last in a space-y container",
    `${imports}
const el = <div className="space-y-3"><p>Before</p><Menu><MenuTrigger /><MenuPopup /></Menu></div>;`,
    (output) => {
      assert.match(output, /<Menu> can be the last child of a `space-y-3` container/);
    },
  );

  rule.invalid(
    "reports variant and divide utilities inside cn",
    `${imports}
const el = <div className={cn("sm:divide-y", active && "ring")}><p>Before</p><Popover /></div>;`,
    (output) => {
      assert.match(output, /`sm:divide-y`/);
    },
  );

  rule.invalid(
    "reports a popup that is last only when a later sibling renders nothing",
    `${imports}
const el = <div className="space-y-2"><Popover />{error ? <p>{error}</p> : null}</div>;`,
  );

  rule.invalid(
    "reports a local component that renders a popup",
    `${imports}
function CommandPicker() {
  return <Menu><MenuTrigger /><MenuPopup /></Menu>;
}
const el = <div className="space-y-3"><ol /><CommandPicker /></div>;`,
    (output) => {
      assert.match(output, /<CommandPicker>/);
    },
  );

  rule.invalid(
    "reports a popup passed last into a local spaced slot",
    `${imports}
function Field({ label, children }) {
  return <div className="space-y-1.5"><label>{label}</label>{children}</div>;
}
const el = <Field label="Model"><Popover /></Field>;`,
    (output) => {
      assert.match(output, /`space-y-1.5`/);
    },
  );
});
