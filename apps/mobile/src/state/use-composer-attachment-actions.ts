import * as Dialog from "../components/ui/Dialog";
import { useLayoutEffect, useRef } from "react";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type ServerConfig } from "@t3tools/contracts";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { nextPastedTextFileName } from "@t3tools/client-runtime/text-paste";
import type { ComposerTextPaste } from "../components/ComposerEditor";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  getComposerDraftSnapshot,
  type ComposerDraftInsertion,
} from "./use-composer-drafts";

export function useComposerAttachmentActions(props: {
  readonly draftKey: string | null;
  readonly serverConfig: ServerConfig | null | undefined;
  readonly locked?: boolean;
}) {
  const currentKey = useRef(props.draftKey);
  const reservedNames = useRef(new Map<string, Set<string>>());
  useLayoutEffect(() => {
    currentKey.current = props.draftKey;
    return () => {
      currentKey.current = null;
    };
  }, [props.draftKey]);
  const capabilities = props.serverConfig?.environment.capabilities;
  const append = async (
    key: string,
    attachments: ReadonlyArray<DraftComposerAttachment>,
    insertion: ComposerDraftInsertion,
  ) => {
    // A picker may finish after selecting another draft or sending this one.
    if (currentKey.current !== key) {
      await Promise.all(
        attachments.flatMap((item) =>
          item.fileUri ? [removePersistedComposerAttachmentFile(item.fileUri)] : [],
        ),
      );
      return 0;
    }
    return appendComposerDraftAttachments(key, attachments, { appendReference: true, insertion });
  };
  const report = (title: string, error: string | null | undefined, rejected: number) => {
    const problems = [
      ...(error ? [error] : []),
      ...(rejected
        ? [`Poți atașa cel mult ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} atașamente per mesaj.`]
        : []),
    ];
    if (problems.length) Dialog.alert(title, problems.join("\n\n"));
  };
  const onPickDraftMedia = async () => {
    const key = props.draftKey;
    if (!key || props.locked) return;
    const insertion = captureComposerDraftInsertion(key);
    const result = await pickComposerMedia({
      existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
      maxVideoBytes: capabilities?.attachmentUploads
        ? capabilities.fileAttachments?.maxUploadBytes
        : undefined,
    });
    report(
      "Poza sau video-ul nu a putut fi atașat",
      result.error,
      await append(key, result.attachments, insertion),
    );
  };
  const onPickDraftFiles = async () => {
    const key = props.draftKey;
    if (!key || props.locked) return;
    const maxBytes = capabilities?.fileAttachments?.maxUploadBytes;
    if (maxBytes === undefined) {
      Dialog.alert("Fișierul nu a putut fi atașat", "Acest server nu suportă atașarea fișierelor.");
      return;
    }
    const insertion = captureComposerDraftInsertion(key);
    const result = await pickComposerFiles({
      existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
      maxBytes,
    });
    report(
      "Fișierul nu a putut fi atașat",
      result.error,
      await append(key, result.files, insertion),
    );
  };
  const onNativePasteImages = async (uris: ReadonlyArray<string>) => {
    const key = props.draftKey;
    if (!key || props.locked || !uris.length) return;
    const insertion = captureComposerDraftInsertion(key);
    try {
      const images = await convertPastedImagesToAttachments({
        uris,
        existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
      });
      report("Imaginile nu au putut fi lipite", null, await append(key, images, insertion));
    } catch (error) {
      Dialog.alert(
        "Imaginile nu au putut fi lipite",
        error instanceof Error ? error.message : "Încearcă din nou.",
      );
    }
  };
  const onNativePasteText = async (paste: ComposerTextPaste) => {
    const key = props.draftKey;
    if (!key || props.locked) return;
    const maxBytes = capabilities?.attachmentUploads
      ? capabilities.fileAttachments?.maxUploadBytes
      : undefined;
    if (maxBytes === undefined) return;
    const names = reservedNames.current.get(key) ?? new Set<string>();
    reservedNames.current.set(key, names);
    for (const attachment of getComposerDraftSnapshot(key).attachments) names.add(attachment.name);
    const name = nextPastedTextFileName([...names]);
    names.add(name);
    try {
      const attachment = await createPastedTextComposerAttachment({
        text: paste.text,
        name,
        maxBytes: clampFileAttachmentUploadBytes(maxBytes),
      });
      const rejected = await append(key, [attachment], { text: paste.value, ...paste.selection });
      if (rejected) await removePersistedComposerAttachmentFile(attachment.fileUri);
      report("Textul lipit nu a putut fi atașat", null, rejected);
    } catch (error) {
      Dialog.alert(
        "Textul lipit nu a putut fi atașat",
        error instanceof Error ? error.message : "Încearcă din nou.",
      );
    }
  };
  return { onPickDraftMedia, onPickDraftFiles, onNativePasteImages, onNativePasteText };
}
