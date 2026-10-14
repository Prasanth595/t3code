// Flow card (tsx lane, 640×440): how an artifact gets from a source file onto a Canvas board. Every
// step is the real command or file; pick a step to read what it does.
import { useState } from "react";

import { Stepper } from "@nofun/ui/stepper";
import {
  Widget,
  WidgetContent,
  WidgetDescription,
  WidgetHeader,
  WidgetHeading,
  WidgetTitle,
} from "@nofun/ui/widget";

const STEPS = [
  {
    title: "Write",
    description: "spec, tsx, page",
    code: "examples/canvas/dashboard.spec.json",
    detail:
      "A catalog spec, a React module that imports real No Fun blocks, or a json-render page for a brand.",
  },
  {
    title: "Compile",
    description: "one HTML page",
    code: "nofun-artifacts compile --spec dashboard.spec.json --preset canvas-dark-kobra --out dashboard",
    detail:
      "Bundles the blocks from the pinned nofun-components revision. The preset sets the theme, the card size and the dark scheme.",
  },
  {
    title: "Bundle",
    description: "manifest, stamp",
    code: "manifest.json  index.html  stamp.json  source/",
    detail:
      "The manifest holds size, background and the sha256 of index.html. The stamp names the components revision.",
  },
  {
    title: "Validate",
    description: "validate_bundle",
    code: 'validate_bundle("dashboard/")',
    detail:
      "The Canvas MCP checks the manifest keys and sha256, regular files only, index.html under 2 MiB and no network URLs.",
  },
  {
    title: "Place",
    description: "place_artifact",
    code: '{ "board_id": "…", "bundle_path": "dashboard/" }',
    detail:
      "place_artifact stages the bundle and queues the card at its manifest size. One CSS pixel is one board point, so zooming never reflows it.",
  },
];

export default function FlowCard() {
  const [step, setStep] = useState(1);
  const current = STEPS[step]!;
  return (
    <Widget className="min-h-[calc(100dvh-32px)]">
      <WidgetHeader>
        <WidgetHeading>
          <WidgetTitle>From a file to a card on the board</WidgetTitle>
          <WidgetDescription>
            Five steps, all local. Pick one to see what it does.
          </WidgetDescription>
        </WidgetHeading>
      </WidgetHeader>
      <WidgetContent className="grid grid-cols-[11rem_1fr] gap-6">
        <Stepper
          steps={STEPS.map(({ title, description }) => ({ title, description }))}
          value={step}
          onValueChange={setStep}
          clickable="all"
          orientation="vertical"
          aria-label="Artifact pipeline"
        />
        <div className="grid gap-3 self-start rounded-lg border border-border bg-muted/40 p-4">
          <p className="m-0 text-xs text-muted-foreground tabular-nums">
            Step {step + 1} of {STEPS.length}
          </p>
          <p className="m-0 text-sm text-foreground text-pretty">{current.detail}</p>
          <code className="block font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
            {current.code}
          </code>
        </div>
      </WidgetContent>
    </Widget>
  );
}
