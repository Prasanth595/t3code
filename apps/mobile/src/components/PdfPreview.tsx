import { useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { FilePreviewLoading, FilePreviewNotice } from "../features/files/FilePreviewFeedback";

export function PdfPreview(props: { readonly uri: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="flex-1 bg-card">
      {error ? (
        <FilePreviewNotice title="PDF-ul nu a putut fi încărcat">{error}</FilePreviewNotice>
      ) : null}
      <WebView
        source={{ uri: props.uri }}
        originWhitelist={["*"]}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        startInLoadingState
        onError={(event) =>
          setError(event.nativeEvent.description || "PDF-ul nu a putut fi încărcat.")
        }
        onHttpError={(event) =>
          setError(`Serverul a returnat HTTP ${event.nativeEvent.statusCode}.`)
        }
        renderLoading={() => (
          <FilePreviewLoading message="Se încarcă PDF-ul..." background="card" />
        )}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
