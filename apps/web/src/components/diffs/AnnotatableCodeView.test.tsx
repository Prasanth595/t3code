import type { CodeViewDiffItem, DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

type Selection = { id: string; range: SelectedLineRange } | null;
interface ViewerProps {
  items: CodeViewDiffItem<unknown>[];
  selectedLines: Selection;
  onSelectedLinesChange: (selection: Selection) => void;
  options: {
    enableLineSelection: boolean;
    enableGutterUtility: boolean;
    onGutterUtilityClick: (
      range: SelectedLineRange,
      context: { item: CodeViewDiffItem<unknown> },
    ) => void;
  };
  renderAnnotation: (annotation: DiffLineAnnotation<unknown>) => ReactNode;
}

vi.mock("./StyledDiffCodeView", () => ({
  StyledDiffCodeView: (props: ViewerProps) =>
    props.items.map((item) => (
      <div key={item.id}>
        {item.annotations?.map((annotation) => (
          <div key={`${annotation.side}:${annotation.lineNumber}`}>
            {props.renderAnnotation(annotation)}
          </div>
        ))}
      </div>
    )),
}));
vi.mock("./DiffCommentAnnotation", () => ({ DiffCommentAnnotation: "diff-comment" }));

import { AnnotatableCodeView } from "./AnnotatableCodeView";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { StyledDiffCodeView } from "./StyledDiffCodeView";

const target = DraftId.make("diff-draft-test");
const range: SelectedLineRange = { start: 1, end: 1, side: "additions" };
let renderer: ReactTestRenderer;

function file(name: string, fileVersion = 1) {
  const fileDiff = parsePatchFiles(
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`,
    name,
  )[0]!.files[0]!;
  return { fileDiff, filePath: name, fileKey: name, fileVersion, collapsed: false };
}

function view(
  files: ReturnType<typeof file>[],
  codeViewKey = "scope:initial",
  pendingFilePaths: string[] = [],
) {
  return (
    <StrictMode>
      <AnnotatableCodeView
        codeViewKey={codeViewKey}
        files={files}
        pendingFilePaths={pendingFilePaths}
        sectionId="unstaged"
        sectionTitle="Uncommitted"
        composerDraftTarget={target}
        options={{}}
        renderHeaderFilenameSuffix={() => null}
        renderHeaderPrefix={() => null}
        onRevealSearchMatch={() => {}}
      />
    </StrictMode>
  );
}

function viewer(): ViewerProps {
  return renderer.root.findByType(StyledDiffCodeView).props as ViewerProps;
}

function beginComment() {
  const props = viewer();
  act(() => {
    props.onSelectedLinesChange({ id: props.items[0]!.id, range });
    props.options.onGutterUtilityClick(range, { item: props.items[0]! });
  });
  act(() => {
    renderer.root.findByType(DiffCommentAnnotation).props.onTextChange("Keep this draft");
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  act(() => {
    renderer = create(view([file("a.ts"), file("b.ts")]));
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  vi.unstubAllGlobals();
});

describe("diff comment drafts", () => {
  it("releases a removed file's draft so a surviving file can receive a comment", () => {
    beginComment();
    expect(viewer().options.enableLineSelection).toBe(false);

    act(() => renderer.update(view([file("b.ts")], "scope:refreshed")));

    expect(renderer.root.findAllByType(DiffCommentAnnotation)).toHaveLength(0);
    expect(viewer().selectedLines).toBeNull();
    expect(viewer().options.enableLineSelection).toBe(true);
    expect(viewer().options.enableGutterUtility).toBe(true);
    act(() => {
      viewer().options.onGutterUtilityClick(range, { item: viewer().items[0]! });
    });
    const comment = renderer.root.findByType(DiffCommentAnnotation);
    expect(comment.props.text).toBe("");
    act(() => comment.props.onComment("Review b.ts"));
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
      expect.objectContaining({ filePath: "b.ts", text: "Review b.ts" }),
    ]);

    act(() => renderer.update(view([file("a.ts"), file("b.ts")])));
    expect(renderer.root.findAllByType(DiffCommentAnnotation)).toHaveLength(1);
    expect(renderer.root.findByType(DiffCommentAnnotation).props.kind).toBe("comment");
  });

  it("preserves draft text and selection when refresh retains the file", () => {
    beginComment();

    act(() => renderer.update(view([file("a.ts", 2)], "scope:refreshed")));

    expect(renderer.root.findByType(DiffCommentAnnotation).props.text).toBe("Keep this draft");
    expect(viewer().selectedLines).toEqual({ id: "a.ts", range });
    expect(viewer().options.enableLineSelection).toBe(false);
    expect(viewer().options.enableGutterUtility).toBe(false);
  });

  it("preserves a draft while its file's patch reloads", () => {
    beginComment();

    act(() => renderer.update(view([file("b.ts")], "scope:loading", ["a.ts"])));
    act(() => renderer.update(view([file("a.ts", 2), file("b.ts")], "scope:loaded")));

    expect(renderer.root.findByType(DiffCommentAnnotation).props.text).toBe("Keep this draft");
    expect(viewer().selectedLines).toEqual({ id: "a.ts", range });
    expect(viewer().options.enableGutterUtility).toBe(false);
  });
});
