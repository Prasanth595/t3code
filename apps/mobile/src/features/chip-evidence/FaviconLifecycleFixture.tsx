import { useLayoutEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { Atom } from "effect/reactivity";
import {
  getProjectFaviconCacheKey,
  getProjectFaviconResourceKey,
} from "@t3tools/shared/projectFavicon";
import { hasLoadedProjectFavicon } from "../../lib/projectFaviconRequests";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { projectFaviconUrlAtom } from "../../state/assets";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ENVIRONMENT_ID } from "./fixtures";

const stages = [
  "absent",
  "placeholder",
  "invalid-data",
  "loaded",
  "new-revision",
  "blank-title",
] as const;
const cwd = "/fixture/favicon-lifecycle";
const assets = [
  Image.resolveAssetSource(require("../../../assets/link-icons/github.png"))?.uri ?? null,
  Image.resolveAssetSource(require("../../../assets/context-chip-icons/terminal.png"))?.uri ?? null,
];
export function FaviconLifecycleFixture(props: {
  readonly setUrl: <A>(atom: Atom.Atom<A>, value: A) => void;
}) {
  const { setUrl } = props;
  const [events, setEvents] = useState<ReadonlyArray<string>>([]);
  const [stageIndex, setStageIndex] = useState(0);
  const stage = stages[stageIndex]!;
  const { themeVariables: colors } = useAppearancePreferences();
  const faviconPath = `${stage}.png`;
  const uri =
    stage === "placeholder"
      ? "file:///fixture/project-favicon-missing"
      : stage === "invalid-data"
        ? "data:image/png;base64,bm90IGFuIGltYWdl"
        : stage === "loaded"
          ? assets[0]!
          : stage === "new-revision"
            ? assets[1]!
            : null;
  useLayoutEffect(() => {
    setUrl(projectFaviconUrlAtom({ environmentId: ENVIRONMENT_ID, cwd, faviconPath }), uri);
  }, [setUrl, uri, faviconPath]);
  function inspectNativeCache() {
    const key = uri
      ? uri.startsWith("data:")
        ? getProjectFaviconResourceKey(ENVIRONMENT_ID, cwd, faviconPath)
        : getProjectFaviconCacheKey(ENVIRONMENT_ID, cwd, uri)
      : null;
    const event = `${stage}: native cache loaded=${hasLoadedProjectFavicon(key)}`;
    console.info(`[chip-evidence] ${event}`);
    setEvents((previous) => [...previous, event]);
  }
  return (
    <View className="flex-1 bg-screen p-4 gap-5">
      <Text
        style={{ color: colors["--color-foreground"] }}
        accessibilityLabel={`Favicon stage ${stage}`}
      >
        Native favicon lifecycle: {stage}
      </Text>
      <View className="bg-grouped-card p-3 flex-row gap-6">
        {[18, 20, 48].map((size) => (
          <ProjectFavicon
            key={size}
            environmentId={ENVIRONMENT_ID}
            projectTitle={stage === "blank-title" ? "   " : "Lifecycle project"}
            workspaceRoot={cwd}
            faviconPath={faviconPath}
            size={size}
          />
        ))}
      </View>
      <Pressable
        accessibilityLabel="Next favicon stage"
        onPress={() => setStageIndex((stageIndex + 1) % stages.length)}
      >
        <Text style={{ color: colors["--color-foreground"] }}>Next native resource stage</Text>
      </Pressable>
      <Pressable accessibilityLabel="Inspect native favicon cache" onPress={inspectNativeCache}>
        <Text style={{ color: colors["--color-foreground"] }}>Inspect native cache</Text>
      </Pressable>
      <Text style={{ color: colors["--color-foreground"] }}>{events.join("\n")}</Text>
      <Text style={{ color: colors["--color-foreground"] }}>
        Bundled resources only. Record the native error and revision sequence; a settled fallback
        alone cannot establish a pending load.
      </Text>
    </View>
  );
}
