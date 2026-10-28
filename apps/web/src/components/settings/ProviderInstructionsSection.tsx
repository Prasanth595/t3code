import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isProviderInstructionsConflictError,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderInstructionsReadResult,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { joinLineEndings, splitLineEndings } from "./providerInstructions.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type View =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly file: ProviderInstructionsReadResult };

interface Target {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly projectId: ProjectId | undefined;
}

const ambiguousCheckoutsDescription =
  "This project has several checkouts here. Select one checkout to edit its instructions.";

const textareaClassName =
  "block h-96 max-sm:h-64 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none ring-ring/24 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-inset disabled:opacity-64";

function failureMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function InstructionsEditor({
  target,
  file,
  canWrite,
  onDirtyChange,
  onClose,
  onReload,
}: {
  readonly target: Target;
  readonly file: ProviderInstructionsReadResult;
  readonly canWrite: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onClose: () => void;
  readonly onReload: () => void;
}) {
  const writeInstructions = useAtomCommand(serverEnvironment.writeProviderInstructions, {
    reportFailure: false,
  });
  const { text: initialText, lineEnding } = splitLineEndings(file.contents);
  // A missing file is only worth creating once it has text.
  const savedText = file.state === "missing" ? "" : initialText;
  const editable = file.state === "ready" || file.state === "missing";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dirty, setDirty] = useState(initialText !== savedText);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{
    readonly message: string;
    readonly conflict: boolean;
  } | null>(null);
  const seededImport = file.state === "missing" && initialText !== "";

  const save = async () => {
    const textarea = textareaRef.current;
    if (textarea === null || !dirty || !canWrite || saving) return;
    setSaving(true);
    setProblem(null);
    const result = await writeInstructions({
      environmentId: target.environmentId,
      input: {
        instanceId: target.instanceId,
        ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
        contents: joinLineEndings(textarea.value, lineEnding),
        revision: file.revision,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      onDirtyChange(false);
      toastManager.add({ type: "success", title: `Saved ${file.fileName}` });
      onClose();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    setProblem({
      message: failureMessage(error, `Could not save ${file.fileName}.`),
      conflict: isProviderInstructionsConflictError(error),
    });
  };

  return (
    <>
      <DialogPanel>
        <p className="break-all font-mono text-muted-foreground text-xs">{file.path}</p>
        {file.state === "too_large" ? (
          <p className="text-muted-foreground text-sm">
            This file is too large to edit here. Open it in an editor instead.
          </p>
        ) : file.state === "binary" ? (
          <p className="text-muted-foreground text-sm">This file is not text.</p>
        ) : (
          <>
            {seededImport ? (
              <p className="text-muted-foreground text-xs">
                This file does not exist yet. It starts as an import of AGENTS.md so the project's
                instructions keep applying.
              </p>
            ) : file.state === "missing" ? (
              <p className="text-muted-foreground text-xs">
                This file does not exist yet. Saving creates it.
              </p>
            ) : null}
            <textarea
              ref={textareaRef}
              aria-label={`${file.fileName} contents`}
              className={textareaClassName}
              defaultValue={initialText}
              readOnly={!canWrite || saving}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              onInput={(event) => {
                const next = event.currentTarget.value !== savedText;
                setDirty(next);
                onDirtyChange(next);
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </>
        )}
        {problem ? (
          <p role="alert" className="text-destructive text-xs">
            {problem.message}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {problem?.conflict ? (
          <Button variant="outline" size="sm" onClick={onReload}>
            Reload from disk
          </Button>
        ) : null}
        <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
          {dirty ? "Discard" : "Close"}
        </Button>
        {editable ? (
          <Button size="sm" disabled={!dirty || !canWrite || saving} onClick={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

/** The file is read when the dialog opens and never cached; agents and users edit it too. */
export function ProviderInstructionsSection({
  environmentId,
  instanceId,
  projectIds,
  providerLabel,
  environmentLabel,
  readOnly,
}: Omit<Target, "projectId"> & {
  readonly projectIds: readonly ProjectId[];
  readonly providerLabel: string;
  readonly environmentLabel: string;
  readonly readOnly: boolean;
}) {
  const projectId = projectIds[0];
  const ambiguous = projectIds.length > 1;
  const target = { environmentId, instanceId, projectId };
  const readInstructions = useAtomCommand(serverEnvironment.readProviderInstructions, {
    reportFailure: false,
  });
  const canWriteScope = useAtomValue(
    serverEnvironment.writeProviderInstructions.permissionAtom(environmentId),
  );
  const [view, setView] = useState<View | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const session = useRef(0);
  const dirty = useRef(false);

  const load = async () => {
    const current = ++session.current;
    dirty.current = false;
    setView({ status: "loading" });
    const result = await readInstructions({
      environmentId,
      input: { instanceId, ...(projectId === undefined ? {} : { projectId }) },
    });
    if (session.current !== current || isAtomCommandInterrupted(result)) return;
    setEditorKey((key) => key + 1);
    // A seeded new file counts as an unsaved draft from the start.
    dirty.current =
      result._tag === "Success" && result.value.state === "missing" && result.value.contents !== "";
    setView(
      result._tag === "Success"
        ? { status: "ready", file: result.value }
        : {
            status: "failed",
            message: failureMessage(
              squashAtomCommandFailure(result),
              "Could not read the instructions file.",
            ),
          },
    );
  };

  const close = () => {
    session.current += 1;
    dirty.current = false;
    setView(null);
  };

  const scope = projectId === undefined ? `every project on ${environmentLabel}` : "this project";
  return (
    <>
      <SettingsSection title="Instructions">
        <SettingsRow
          title="Custom instructions"
          description={
            ambiguous
              ? ambiguousCheckoutsDescription
              : `Edit what ${providerLabel} is told in ${scope}.`
          }
          control={
            <Button size="sm" variant="outline" disabled={ambiguous} onClick={() => void load()}>
              Edit
            </Button>
          }
        />
      </SettingsSection>
      <Dialog
        open={view !== null}
        onOpenChange={(open) => {
          // Escape and outside clicks keep unsaved text; Discard is the only way out.
          if (!open && !dirty.current) close();
        }}
      >
        <DialogPopup className="max-w-2xl" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {view?.status === "ready" ? view.file.fileName : `${providerLabel} instructions`}
            </DialogTitle>
            <DialogDescription>
              {providerLabel} reads this at the start of each session in {scope}.
            </DialogDescription>
          </DialogHeader>
          {view?.status === "ready" ? (
            <InstructionsEditor
              key={editorKey}
              target={target}
              file={view.file}
              canWrite={canWriteScope && !readOnly}
              onDirtyChange={(next) => {
                dirty.current = next;
              }}
              onClose={close}
              onReload={() => void load()}
            />
          ) : (
            <>
              <DialogPanel>
                <p
                  role={view?.status === "failed" ? "alert" : "status"}
                  className="text-muted-foreground text-sm"
                >
                  {view?.status === "failed" ? view.message : "Reading the file..."}
                </p>
              </DialogPanel>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={close}>
                  Close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
