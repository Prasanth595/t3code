import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { DownloadIcon, UploadIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import {
  diffDeviceSettings,
  parseDeviceSettingsFile,
  pickDeviceSettings,
  planCustomThemeImport,
  serializeDeviceSettingsFile,
  type DeviceAppearance,
  type DeviceSettingChange,
  type DeviceSettingsFileImport,
} from "../../deviceSettingsFile";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsPatch,
} from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import {
  getCustomThemes,
  installCustomTheme,
  isKnownThemePreference,
  updateCustomTheme,
  type ThemeDefinition,
} from "../../themePalette";
import { Alert } from "../ui/alert";
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

const DEVICE_SETTINGS_FILE_NAME = "t3code-device-settings.json";

/** Embedded custom themes make the file larger than one theme file, but never by megabytes. */
const MAX_DEVICE_SETTINGS_FILE_BYTES = 1024 * 1024;

interface ImportPreview {
  readonly fileName: string;
  readonly imported: DeviceSettingsFileImport;
  readonly changes: ReadonlyArray<DeviceSettingChange>;
  readonly addedThemes: ReadonlyArray<ThemeDefinition>;
  readonly replacedThemes: ReadonlyArray<ThemeDefinition>;
}

function downloadJsonFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function formatSettingValue(value: unknown): string {
  return value === undefined ? "default" : JSON.stringify(value);
}

function useDeviceAppearance() {
  const theme = useTheme();
  const [advancedTypography, setAdvancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const appearance: DeviceAppearance = {
    theme: theme.theme,
    appearanceMode: theme.appearanceMode,
    themeHalves: theme.themeHalves,
    advancedTypography,
  };
  return { appearance, theme, setAdvancedTypography };
}

function notifySettingsUnavailable() {
  toastManager.add({
    type: "error",
    title: "Couldn’t read device settings",
    description: "Try again.",
  });
}

export function ExportDeviceSettingsButton() {
  const { appearance } = useDeviceAppearance();

  const exportSettings = async () => {
    const hydrated = await settlePromise(ensureClientSettingsHydrated);
    if (hydrated._tag === "Failure") {
      notifySettingsUnavailable();
      return;
    }
    downloadJsonFile(
      DEVICE_SETTINGS_FILE_NAME,
      serializeDeviceSettingsFile({
        settings: getClientSettings(),
        appearance,
        customThemes: getCustomThemes(),
      }),
    );
  };

  return (
    <Button size="xs" variant="ghost" onClick={() => void exportSettings()}>
      <DownloadIcon className="mx-1 size-3.5" />
      Export
    </Button>
  );
}

export function ImportDeviceSettingsButton({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <UploadIcon className="mx-1 size-3.5" />
        Import
      </Button>
      <DeviceSettingsImportDialog open={open} onOpenChange={setOpen} onImported={onImported} />
    </>
  );
}

export function DeviceSettingsImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const { appearance, theme, setAdvancedTypography } = useDeviceAppearance();

  const [renderedOpen, setRenderedOpen] = useState(open);
  if (renderedOpen !== open) {
    setRenderedOpen(open);
    setIsDropTarget(false);
    if (open) {
      setPreview(null);
      setError(null);
      setIsReading(false);
    }
  }

  const readFile = async (file: File) => {
    if (file.size > MAX_DEVICE_SETTINGS_FILE_BYTES) {
      setError("That file is larger than 1 MB, so it is not a device settings file.");
      return;
    }
    setIsReading(true);
    const [text, hydrated] = await Promise.all([
      settlePromise(() => file.text()),
      settlePromise(ensureClientSettingsHydrated),
    ]);
    setIsReading(false);
    if (text._tag === "Failure") {
      setError("Could not read that file.");
      return;
    }
    if (hydrated._tag === "Failure") {
      setError("Could not read the current device settings. Try again.");
      return;
    }
    try {
      const imported = parseDeviceSettingsFile(JSON.parse(text.value), isKnownThemePreference);
      const { added, replaced } = planCustomThemeImport(imported.customThemes, getCustomThemes());
      setPreview({
        fileName: file.name,
        imported,
        changes: diffDeviceSettings(
          { settings: pickDeviceSettings(getClientSettings()), appearance },
          imported,
        ),
        addedThemes: added,
        replacedThemes: replaced,
      });
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? "That file is not valid JSON."
          : cause instanceof Error
            ? cause.message
            : "That file is not a device settings file.",
      );
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void readFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropTarget(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  };

  const applyImport = async (accepted: ImportPreview) => {
    try {
      for (const customTheme of accepted.addedThemes) installCustomTheme(customTheme);
      for (const customTheme of accepted.replacedThemes) updateCustomTheme(customTheme);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the custom themes.");
      return;
    }

    const next = accepted.imported.appearance;
    // setTheme drops any light and dark mix, so the mix is written after it.
    const appearanceSaved =
      theme.setTheme(next.theme) &&
      theme.setAppearanceMode(next.appearanceMode) &&
      (next.themeHalves === null
        ? theme.clearThemeHalves()
        : theme.setThemeHalf("light", next.themeHalves.light ?? null) &&
          theme.setThemeHalf("dark", next.themeHalves.dark ?? null));
    setAdvancedTypography(next.advancedTypography);
    await persistClientSettingsPatch(accepted.imported.settings);
    onImported();
    if (!appearanceSaved) {
      setPreview(null);
      setError("Settings were imported, but the theme could not be saved. Try again.");
      return;
    }
    onOpenChange(false);
  };

  const themeChanges = preview
    ? [
        ...preview.addedThemes.map((customTheme) => `Add custom theme ${customTheme.id}`),
        ...preview.replacedThemes.map((customTheme) => `Replace custom theme ${customTheme.id}`),
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import device settings</DialogTitle>
          <DialogDescription>
            Every device setting the file leaves out goes back to its default.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {preview === null ? (
            <div
              className={cn(
                "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-3 transition-colors",
                isDropTarget ? "border-ring bg-accent/20" : "border-border/80 bg-muted/20",
              )}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDropTarget(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDropTarget(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
              }}
              onDrop={handleDrop}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">Settings file</p>
                <p className="truncate text-xs text-muted-foreground">
                  Drop a {DEVICE_SETTINGS_FILE_NAME} file
                </p>
              </div>
              <Button
                disabled={isReading}
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon />
                {isReading ? "Reading…" : "Choose file"}
              </Button>
              <input
                ref={fileInputRef}
                accept=".json,application/json"
                aria-label="Device settings file"
                className="sr-only"
                onChange={handleFileChange}
                type="file"
              />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="truncate text-xs text-muted-foreground">{preview.fileName}</p>
              {preview.changes.length === 0 && themeChanges.length === 0 ? (
                <p className="text-sm">This file matches the current device settings.</p>
              ) : (
                <ul aria-label="Changes" className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs">
                  {preview.changes.map((change) => (
                    <li key={change.key}>
                      {change.key}: {formatSettingValue(change.from)} →{" "}
                      {formatSettingValue(change.to)}
                    </li>
                  ))}
                  {themeChanges.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {preview.imported.warnings.length > 0 ? (
                <Alert variant="warning">
                  <ul aria-label="Warnings" className="space-y-1 text-xs">
                    {preview.imported.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </div>
          )}
          {error ? (
            <Alert aria-live="polite" variant="error">
              {error}
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {preview === null ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Back
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void applyImport(preview)}>Replace settings</Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
