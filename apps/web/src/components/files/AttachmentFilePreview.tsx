import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { filePreviewKind, FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { ChevronRightIcon, DownloadIcon, Trash2Icon, WrapTextIcon, XIcon } from "lucide-react";
import { Check, Code2, Copy, Eye, Table2 } from "lucide";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "./fileSurfaceChrome";

const SourcePreview = lazy(() => import("./ReadOnlySourcePreview"));

const STALE_URL_MS = 5 * 60_000;

export function ReadOnlySourcePreview(props: { name: string; text: string }) {
  return (
    <Suspense fallback={<FileSurfaceLoading className="p-4" />}>
      <SourcePreview {...props} />
    </Suspense>
  );
}

function renderedToggleLabel(mode: "markdown" | "html" | "table", rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Arată sursa markdown" : "Arată markdown formatat";
  if (mode === "table") return rendered ? "Arată sursa" : "Arată tabelul";
  return rendered ? "Arată sursa HTML" : "Arată pagina";
}

export function AttachmentFilePreview(props: {
  name: string;
  mimeType: string;
  sizeBytes: number;
  file?: Blob | null;
  asset?: { environmentId: EnvironmentId; attachmentId: string };
  htmlRender?: boolean;
  threadRef?: ScopedThreadRef;
  origin?: string;
  onRemove?: () => void;
  onClose?: () => void;
}) {
  const kind = filePreviewKind(props);
  const delimiter = filePreviewDelimiter(props);
  const renderedMode =
    kind === "markdown" ? "markdown" : kind === "html" ? "html" : delimiter ? "table" : null;
  const attachmentId = props.asset?.attachmentId;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: props.name });
  const resource = attachmentId
    ? {
        _tag: "attachment" as const,
        attachmentId,
        fileName: props.name,
        mimeType: props.mimeType,
        disposition: "inline" as const,
      }
    : null;
  const downloadResource = resource ? { ...resource, disposition: "attachment" as const } : null;
  const refresh = useAssetUrlRefresh(
    props.file ? null : (props.asset?.environmentId ?? null),
    props.file ? null : resource,
  );
  const prepareDownload = useAssetUrlRefresh(props.asset?.environmentId ?? null, downloadResource);
  const [saving, setSaving] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const authorizedAt = useRef(0);
  useEffect(() => {
    if (!props.file) return;
    const url = URL.createObjectURL(props.file);
    // oxlint-disable-next-line react/set-state-in-effect -- Publish an object URL only after its cleanup is registered for this Blob.
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [props.file]);
  useEffect(() => {
    if (props.file) return;
    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect -- A new preview request clears its previous URL and error.
    setRemoteUrl(null);
    setError(null);
    void refresh()
      .then((url) => {
        if (cancelled) return;
        if (!url) throw new Error("Reconectează-te la mediu și încearcă din nou.");
        authorizedAt.current = Date.now();
        setRemoteUrl(url);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Atașamentul nu e disponibil.");
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reauthorize the remote file.
  }, [props.file, refresh, revision]);
  const url = props.file ? localUrl : remoteUrl;
  const needsText = kind === "text" || kind === "markdown" || (kind === "html" && !rendered);
  useEffect(() => {
    if (!needsText || !url) return;
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- A new external resource must clear the previous response before loading.
    setContent(null);
    setContentError(null);
    const file = props.file;
    void (async () => {
      if (!file && Date.now() - authorizedAt.current > STALE_URL_MS) {
        const target = await refresh();
        if (controller.signal.aborted) return;
        if (!target) throw new Error("Reconectează-te la mediu și încearcă din nou.");
        authorizedAt.current = Date.now();
        if (target !== url) {
          setRemoteUrl(target);
          return;
        }
      }
      const response = file
        ? { ok: true, body: file.stream() }
        : await fetch(url, {
            signal: controller.signal,
            ...(props.sizeBytes > 0
              ? { headers: { Range: `bytes=0-${FILE_TEXT_PREVIEW_MAX_BYTES}` } }
              : {}),
            cache: revision === 0 ? "default" : "reload",
          });
      const result = await readFilePreviewResponse(response, controller.signal);
      if (!controller.signal.aborted) setContent(result);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setContentError(
          cause instanceof Error ? cause.message : "Fișierul nu a putut fi încărcat.",
        );
    });
    return () => controller.abort();
  }, [url, needsText, revision, props.sizeBytes, props.file, refresh]);
  const failure = error ?? (needsText ? contentError : null);
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const showsRawText =
    failure === null &&
    needsText &&
    content !== null &&
    !(delimiter && rendered) &&
    !(kind === "markdown" && rendered);

  const save = () => {
    setSaving(true);
    void settlePromise(async () => {
      let file = props.file;
      if (!file) {
        const target = await prepareDownload();
        if (!target) throw new Error("Reconectează-te la mediu și încearcă din nou.");
        const response = await fetch(target);
        if (!response.ok) throw new Error("Fișierul nu a putut fi încărcat. Încearcă din nou.");
        file = await response.blob();
      }
      // Blob downloads keep desktop's custom app scheme from navigating to an external browser.
      const downloadUrl = URL.createObjectURL(file);
      // Scheduled before the click so the URL is revoked even if the click throws.
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = props.name;
      anchor.click();
    }).then((result) => {
      if (!AsyncResult.isSuccess(result)) {
        const cause = Cause.squash(result.cause);
        toastManager.add({
          type: "error",
          title: "Fișierul nu a putut fi salvat",
          description: cause instanceof Error ? cause.message : "Încearcă din nou.",
        });
      }
      setSaving(false);
    });
  };

  const body = failure ? (
    <FileSurfaceFailure
      message={failure}
      onRetry={() => {
        setError(null);
        setRevision((value) => value + 1);
      }}
    />
  ) : !url || (needsText && !content) ? (
    <FileSurfaceLoading />
  ) : needsText && content ? (
    delimiter && rendered ? (
      <DelimitedTablePreview name={props.name} text={content.text} delimiter={delimiter} />
    ) : kind === "markdown" && rendered ? (
      <ScrollArea className="min-h-0 flex-1">
        <ChatMarkdown text={content.text} cwd={undefined} className="mx-auto max-w-4xl px-6 py-5" />
      </ScrollArea>
    ) : (
      <ReadOnlySourcePreview name={props.name} text={content.text} />
    )
  ) : kind === "pdf" || kind === "html" ? (
    <BrowserDocumentFrame
      src={url}
      title={props.name}
      pdf={kind === "pdf"}
      htmlRender={props.htmlRender === true}
      threadRef={props.threadRef}
    />
  ) : kind === "audio" ? (
    <AudioPreview
      src={url}
      name={props.name}
      onError={() => setError("Fișierul audio nu a putut fi încărcat.")}
    />
  ) : kind === "video" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        controls
        playsInline
        src={url}
        aria-label={props.name}
        className="max-h-full max-w-full"
        onError={() => setError("Video-ul nu a putut fi încărcat.")}
      />
    </div>
  ) : kind === "image" ? (
    // oxlint-disable-next-line t3code/require-centered-scroll-gutter -- The image is capped at max-h-full max-w-full, so this never scrolls.
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        src={url}
        alt={props.name}
        className="max-h-full max-w-full object-contain"
        onError={() => setError("Imaginea nu a putut fi încărcată.")}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium">No preview for this file</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        Save it to open in an app that supports {props.name.split(".").at(-1) || "this format"}{" "}
        files.
      </p>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className={cn(FILE_SURFACE_SUBHEADER_CLASS)} data-surface-subheader>
        <div className="flex min-w-0 flex-1 items-center text-xs">
          <span className="shrink-0 px-0.5 text-muted-foreground">
            {props.origin ?? "Atașament"}
          </span>
          <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
          <span aria-current="page" className="min-w-0 truncate px-0.5 font-medium text-foreground">
            {props.name}
          </span>
          {props.sizeBytes > 0 ? (
            <span className="ml-2 shrink-0 text-muted-foreground">
              {formatAttachmentSize(props.sizeBytes)}
            </span>
          ) : null}
        </div>
        {renderedMode ? (
          <FileSurfaceAction
            label={renderedToggleLabel(renderedMode, rendered)}
            pressed={rendered}
            onPress={() => setRendered((value) => !value)}
          >
            <MorphIcon
              className="size-3.5"
              icon={rendered ? Code2 : renderedMode === "table" ? Table2 : Eye}
            />
          </FileSurfaceAction>
        ) : null}
        {showsRawText ? (
          <FileSurfaceAction
            label={wordWrap ? "Dezactivează încadrarea" : "Activează încadrarea"}
            pressed={wordWrap}
            onPress={() => updateClientSettings({ wordWrap: !wordWrap })}
          >
            <WrapTextIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {content ? (
          <FileSurfaceAction
            label={
              isCopied
                ? "Copiat"
                : content.truncated
                  ? "Copiază previzualizarea"
                  : "Copiază conținutul"
            }
            onPress={() => copyToClipboard(content.text, undefined)}
          >
            <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
          </FileSurfaceAction>
        ) : null}
        {url ? (
          <FileSurfaceAction
            label={saving ? "Se pregătește fișierul…" : "Salvează fișierul"}
            disabled={saving}
            onPress={save}
          >
            <DownloadIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.onRemove ? (
          <FileSurfaceAction label="Elimină din ciornă" onPress={props.onRemove}>
            <Trash2Icon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.onClose ? (
          <FileSurfaceAction label="Închide" onPress={props.onClose}>
            <XIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
      </div>
      {content?.truncated ? (
        <FileSurfaceNotice>
          Previzualizare limitată la primul 1 MB
          {props.sizeBytes > 0
            ? ` dintr-un fișier de ${props.sizeBytes.toLocaleString()} octeți`
            : ""}
          . Salvează fișierul ca să-l citești complet.
        </FileSurfaceNotice>
      ) : null}
      {body}
    </div>
  );
}
