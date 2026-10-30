import { describe, expect, it } from "vite-plus/test";

import script from "../../../../factory/scripts/autodeploy.sh?raw";
import { WAITING_ON_A_PERSON } from "./updateInterrupts";

describe("what Update now asks about", () => {
  it("is what autodeploy waits on: a running pass, an unreadable run, a run not waiting on a person", () => {
    const busy = /busy=\$\(jq -r '(.*?)' <<< "\$body"/s.exec(script)?.[1] ?? "";
    expect(busy).toContain(".passes.running == true");
    expect(busy).toContain(".unreadable or");
    const states = /\(\.state \/\/ ""\) \| IN\(([^)]*)\) \| not/.exec(busy)?.[1] ?? "";
    expect(
      states
        .split(",")
        .map((state) => JSON.parse(state.trim()))
        .toSorted(),
    ).toEqual([...WAITING_ON_A_PERSON].toSorted());
  });
});
