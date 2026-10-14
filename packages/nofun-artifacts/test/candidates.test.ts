import assert from "node:assert/strict";
import { test } from "node:test";

import { candidatesOf } from "../src/live/bundle.ts";

test("candidatesOf drops brace tokens from minified vendor JS", () => {
  const junk = `[m("weight","Weight",400,900,100,{rebuild:!0})]`;
  const tokens = candidatesOf(`flex ${junk} bg-background w-[120px]`);
  assert.equal(tokens.includes("flex"), true);
  assert.equal(tokens.includes("bg-background"), true);
  assert.equal(tokens.includes("w-[120px]"), true);
  assert.equal(
    tokens.some((token) => /[{}]/.test(token)),
    false,
  );
});
