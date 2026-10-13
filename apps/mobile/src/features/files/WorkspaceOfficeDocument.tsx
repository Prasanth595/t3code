import { useRef, useState } from "react";
import { View } from "react-native";
import { FilePreviewModal } from "../../components/FilePreviewModal";
import { EmptyState } from "../../components/EmptyState";
import type { MediaActionsSource } from "../../lib/mediaActionsSource";

/** Workspace Office files share the same native viewer and save/share fallback as attachments. */
export function WorkspaceOfficeDocument(props: {
  readonly source: MediaActionsSource;
  readonly onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pendingError = useRef<string | null>(null);
  return (
    <View className="flex-1 items-center justify-center px-6">
      <EmptyState
        title={error ? "No compatible document viewer" : "Opening document"}
        detail={error ?? "Use Save or share in File actions to open the original in another app."}
      />
      <FilePreviewModal
        source={open ? { ...props.source, kind: "document" } : null}
        onOpenError={(cause: unknown) => {
          pendingError.current =
            cause instanceof Error
              ? cause.message
              : "This device could not open the document. Use Save or share in File actions.";
        }}
        onRequestClose={() => {
          setOpen(false);
          if (pendingError.current) {
            setError(pendingError.current);
            pendingError.current = null;
          } else props.onClose();
        }}
      />
    </View>
  );
}
