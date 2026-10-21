import { expect, it } from "vite-plus/test";
import { validateFixtures } from "./fixtures";

it("accepts every embedded context record through the wire contract", () => {
  expect(() => validateFixtures()).not.toThrow();
});
