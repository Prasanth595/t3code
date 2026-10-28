import type { PullRequestReviewGuideResult } from "@t3tools/contracts";

export function reviewGuideState(data: PullRequestReviewGuideResult | null) {
  const guide = data?.guide ?? null;
  return {
    guide,
    running: data?.run?._tag === "Running",
    stale: guide !== null && data?.currentHeadSha != null && guide.headSha !== data.currentHeadSha,
    failure:
      data?.run?._tag === "Failed" && data.run.headSha === data.currentHeadSha
        ? data.run.detail
        : null,
  };
}

export function guideNoticeState(state: {
  readonly data: PullRequestReviewGuideResult | null;
  readonly isPending: boolean;
  readonly running: boolean;
  readonly startError: string | null;
  readonly error: string | null;
}) {
  const { guide, stale, failure } = reviewGuideState(state.data);
  if (state.running) {
    return {
      kind: "writing" as const,
      title: "Se rescrie ghidul",
      description: guide
        ? "Poți citi în continuare ghidul cât timp agentul scrie actualizarea."
        : "Un agent citește modificarea și scrie turul. Poți pleca și reveni când e gata.",
      action: guide ? "Se rescrie…" : "Se scrie ghidul…",
    };
  }
  const error = state.startError ?? failure;
  if (error) {
    return {
      kind: "failed" as const,
      title: "Ghidul nu a putut fi scris",
      description: error,
      action: "Încearcă din nou",
    };
  }
  if (state.error) {
    return {
      kind: "unavailable" as const,
      title: "Ghidul nu a putut fi reîmprospătat",
      description: state.error,
      action: "Încearcă din nou",
    };
  }
  if (!state.data) {
    return {
      kind: "loading" as const,
      title: "Ghid de revizuire",
      description: "Se caută un ghid salvat…",
      action: "Se încarcă ghidul…",
    };
  }
  if (stale) {
    return {
      kind: "stale" as const,
      title: "Modificări noi de la acest ghid",
      description: "Poți citi ghidul anterior sau îl poți rescrie pentru ultimele modificări.",
      action: "Rescrie ghidul",
    };
  }
  return {
    kind: guide ? ("ready" as const) : ("empty" as const),
    title: "Ghid de revizuire",
    description:
      "Primești un tur al modificării, cu fragmente de cod și note despre ce merită verificat atent.",
    action: "Scrie ghidul",
  };
}
