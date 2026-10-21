import { RegistryContext } from "@effect/atom-react";
import { NavigationContainer, useNavigation } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  EnvironmentId,
  PullRequestActivity,
  ProjectId,
  ProjectIconColor,
  ThreadId,
  type ProjectIconOverride,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef, useState } from "react";
import { Image, Linking, Pressable, ScrollView, StatusBar, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useSharedValue } from "react-native-reanimated";
import type { LegendListRef } from "@legendapp/list/react-native";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { ComposerContextRecord, RuntimeRequestId } from "@t3tools/contracts";
import { PendingUserInputCard } from "../threads/PendingUserInputCard";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells, environmentThreadDetails } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { projectFaviconUrlAtom } from "../../state/assets";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadFeed } from "../threads/ThreadFeed";
import { ExistingThreadSettingsRouteProvider } from "../threads/ThreadSettingsSheet";
import { ThreadComposer } from "../threads/ThreadComposer";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";
import { pullRequestTimelineRows } from "../pull-requests/PullRequestTimeline";
import { PullRequestDescription } from "../pull-requests/PullRequestDescription";
import { PullRequestMarkdownRepository } from "../pull-requests/PullRequestMarkdown";
import { PullRequestMarkdown } from "../pull-requests/PullRequestMarkdown";
import { CommandPalette } from "../keyboard/CommandPalette";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { NativeLayoutMetricsProvider } from "../../native/native-layout-metrics";
import { OverlayPortalHost } from "../../components/ui/OverlayPortal";
import * as Dialog from "../../components/ui/Dialog";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";
import { MOBILE_THEME_IDS } from "../../lib/mobileTheme";
import { setComposerDraftText, setComposerDraftContext } from "../../state/use-composer-drafts";
import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import { VoiceInputProvider } from "../voice-input/VoiceInputProvider";
import { FaviconLifecycleFixture } from "./FaviconLifecycleFixture";
import { ArchiveFixture, HomeFixture, NewTaskFixture } from "./CallerFixtures";
import { Rasterizer, seedGlyphFailures } from "./rasterizer";
import {
  ATLAS,
  context,
  ENVIRONMENT_ID,
  EXTERNAL,
  feed,
  FILES,
  FIXED_TIME,
  markdown,
  PREVIEW,
  PR_REVIEWS,
  REVIEW,
  SCENES,
  SERVER_CONFIG,
  SIZES,
  SKILLS,
  THREAD_ID,
  UNKNOWN,
  validateFixtures,
  type Scene,
} from "./fixtures";
import "../../../global.css";

validateFixtures();
seedGlyphFailures();
const decodeActivity = Schema.decodeUnknownSync(PullRequestActivity);
const decodeRecords = Schema.decodeUnknownSync(Schema.Array(ComposerContextRecord));
const Stack = createNativeStackNavigator();
const draftKey = "chip-evidence-static-draft";
const shell = makeThreadShellFixture({
  environmentId: ENVIRONMENT_ID,
  id: THREAD_ID,
  title: "Chip contrast fixture",
});
const fixtureUpdates = new Map<unknown, () => void>();
function preload<A>(atom: Atom.Atom<A>, value: A) {
  const node = appAtomRegistry.ensureNode(atom);
  if (fixtureUpdates.has(atom)) {
    fixtureUpdates.set(atom, () => node.setInitialValue(value));
    node.setInitialValue(value);
    return;
  }
  fixtureUpdates.set(atom, () => node.setInitialValue(value));
  node.setInitialValue(value);
  // Async catalog initialization must not replace this fixture with empty remote state.
  appAtomRegistry.subscribe(atom, (next) => {
    if (next !== value) fixtureUpdates.get(atom)?.();
  });
}
preload(
  environmentThreadDetails.threadAtom({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }),
  null,
);
const timestamp = FIXED_TIME;
const projects: EnvironmentProject[] = ProjectIconColor.literals.map((color, index) => ({
  environmentId: ENVIRONMENT_ID,
  id: ProjectId.make(`fixture-project-${index}`),
  title: `Fixture ${color}`,
  workspaceRoot: `/fixture/${color}`,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
  projectIcon: { kind: "monogram", text: index % 2 ? "T3" : "T", color },
  faviconPath: null,
  defaultModelSelection: null,
  scripts: [],
}));
preload(serverEnvironment.configValueAtom(ENVIRONMENT_ID), SERVER_CONFIG);
preload(environmentProjects.projectsAtom, projects);
preload(environmentThreadShells.threadShellsAtom, [shell]);
const linkedProjects: EnvironmentProject[] = [];
const linkedShells = [shell];
const projectKinds: ReadonlyArray<{ id: string; title: string; icon?: ProjectIconOverride }> = [
  { id: "favicon", title: "Loaded favicon" },
  { id: "emoji", title: "Emoji project", icon: { kind: "emoji", emoji: "👩🏽‍💻" } },
  { id: "mono1", title: "One glyph", icon: { kind: "monogram", text: "T", color: "orange" } },
  { id: "mono2", title: "Two glyphs", icon: { kind: "monogram", text: "T3", color: "cyan" } },
  {
    id: "lucide",
    title: "Lucide project",
    icon: { kind: "lucide", name: "folder", color: "purple" },
  },
  {
    id: "normal",
    title: "Mobile application with a very long project title and a suffix that should truncate",
  },
  { id: "punctuation", title: "!!!" },
  { id: "digit", title: "t3code" },
  { id: "blank", title: "   " },
  { id: "scratch", title: "Scratch" },
  { id: "pending", title: "Pending glyph", icon: { kind: "monogram", text: "P", color: "blue" } },
  { id: "failed", title: "Failed glyph", icon: { kind: "monogram", text: "F", color: "red" } },
];
for (const kind of projectKinds) {
  const project = {
    ...projects[0]!,
    id: ProjectId.make(`linked-${kind.id}`),
    title: kind.title,
    workspaceRoot: `/fixture/${kind.id}`,
    projectIcon: kind.icon ?? null,
  };
  linkedProjects.push(project);
  linkedShells.push(
    makeThreadShellFixture({
      environmentId: ENVIRONMENT_ID,
      id: ThreadId.make(`linked-${kind.id}`),
      projectId: project.id,
      title: kind.title,
    }),
  );
  preload(
    environmentProjects.projectAtom({ environmentId: ENVIRONMENT_ID, projectId: project.id }),
    project,
  );
  preload(
    projectFaviconUrlAtom({
      environmentId: ENVIRONMENT_ID,
      cwd: project.workspaceRoot,
      faviconPath: null,
    }),
    kind.id === "favicon"
      ? (Image.resolveAssetSource(require("../../../assets/link-icons/github.png"))?.uri ?? null)
      : null,
  );
  preload(
    environmentThreadShells.threadShellAtom({
      environmentId: ENVIRONMENT_ID,
      threadId: ThreadId.make(`linked-${kind.id}`),
    }),
    makeThreadShellFixture({
      environmentId: ENVIRONMENT_ID,
      id: ThreadId.make(`linked-${kind.id}`),
      projectId: project.id,
      title: kind.title,
    }),
  );
}
preload(
  environmentThreadShells.threadShellAtom({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }),
  shell,
);

preload(environmentProjects.projectsAtom, [...linkedProjects, ...projects]);
preload(environmentThreadShells.threadShellsAtom, linkedShells);
const remoteEnvironment = EnvironmentId.make("chip-evidence-remote");
const remoteThreadId = ThreadId.make("remote:linked");
const remoteProject = {
  ...projects[0]!,
  environmentId: remoteEnvironment,
  id: ProjectId.make("remote-project"),
  workspaceRoot: "/fixture/remote",
  title: "Remote project",
  projectIcon: { kind: "emoji" as const, emoji: "🛰️" },
};
const remoteShell = makeThreadShellFixture({
  environmentId: remoteEnvironment,
  id: remoteThreadId,
  projectId: remoteProject.id,
  title: "Remote original title",
});
preload(
  environmentProjects.projectAtom({
    environmentId: remoteEnvironment,
    projectId: remoteProject.id,
  }),
  remoteProject,
);
preload(
  environmentThreadShells.threadShellAtom({
    environmentId: remoteEnvironment,
    threadId: remoteThreadId,
  }),
  remoteShell,
);
preload(environmentThreadShells.threadRefsAtom, [
  { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
  { environmentId: remoteEnvironment, threadId: remoteThreadId },
  ...projectKinds.map((kind) => ({
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make(`linked-${kind.id}`),
  })),
]);
function readRequest(url: string) {
  const query = new URL(url).searchParams;
  const requestedScene = query.get("scene");
  const scene = SCENES.find((value) => value === requestedScene) ?? "U1-1";
  const theme = MOBILE_THEME_IDS.find((value) => value === query.get("theme")) ?? "t3-code";
  const appearance = query.get("appearance") === "dark" ? "dark" : "light";
  const fontSize = query.get("fontSize") === "22" ? 22 : 16;
  return { scene, theme, appearance, fontSize } as const;
}
function recordsFor(scene: Scene) {
  if (scene.startsWith("P1") || scene.startsWith("P2") || scene === "C2-pr")
    return [...PR_REVIEWS, REVIEW];
  if (scene.startsWith("F1"))
    return FILES.slice(scene.endsWith("2") ? 4 : 0, scene.endsWith("2") ? 7 : 4);
  if (scene.startsWith("F2")) return SIZES;

  if (scene.startsWith("N1")) return [UNKNOWN];
  return ATLAS.slice(scene.endsWith("2") ? 5 : 0, scene.endsWith("2") ? 10 : 5);
}
function FixtureScreen() {
  const navigation = useNavigation();
  const [request, setRequest] = useState(() => readRequest("t3code-preview://chip-fixture"));
  const [palette, setPalette] = useState(false);
  const { scene, theme, appearance, fontSize } = request;
  const appearancePreferences = useAppearancePreferences();
  const {
    isReady,
    setThemeIdForBothAppearances,
    setThemeMode,
    setBaseFontSize,
    themeVariables: colors,
    themeId,
    themeAppearance,
  } = appearancePreferences;
  const listRef = useRef<LegendListRef>(null);
  const freeze = useSharedValue(false);
  const endAdjustment = useSharedValue(0);
  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url) setRequest(readRequest(url));
    });
    const subscription = Linking.addEventListener("url", ({ url }) => {
      setPalette(false);
      setRequest(readRequest(url));
    });
    return () => subscription.remove();
  }, []);
  const { themeIds, themeMode, appearance: typography } = appearancePreferences;
  useEffect(() => {
    if (!isReady) return;
    if (themeIds.light !== theme || themeIds.dark !== theme) setThemeIdForBothAppearances(theme);
    if (themeMode !== appearance) setThemeMode(appearance);
    if (typography.baseFontSize !== fontSize) setBaseFontSize(fontSize);
    void SplashScreen.hideAsync();
  }, [
    isReady,
    theme,
    appearance,
    fontSize,
    setThemeIdForBothAppearances,
    setThemeMode,
    setBaseFontSize,
    themeIds.light,
    themeIds.dark,
    themeMode,
    typography.baseFontSize,
  ]);
  useEffect(() => {
    if (!scene.startsWith("T5")) return;
    const updated = {
      ...remoteShell,
      title: scene === "T5-renamed" ? "Remote renamed title" : "Remote original title",
    };
    preload(
      environmentThreadShells.threadShellAtom({
        environmentId: remoteEnvironment,
        threadId: remoteThreadId,
      }),
      updated,
    );
    preload(
      environmentThreadShells.environmentThreadIndexAtom(ENVIRONMENT_ID),
      new Map([
        [
          remoteThreadId,
          makeRawThreadShell({
            id: remoteThreadId,
            projectId: remoteProject.id,
            title: updated.title,
          }),
        ],
      ]),
    );
  }, [scene]);
  let records = recordsFor(scene);
  let text =
    scene.includes("composer") || scene.startsWith("C1")
      ? records
          .map(
            (record) =>
              `Compare [${record.label}](t3-context://v1/${record.kind}/${record.contextId})`,
          )
          .join("\n")
      : markdown(records);
  const role =
    scene.includes("assistant") || scene.startsWith("A1") || scene === "P3-streaming"
      ? "assistant"
      : "user";
  if (scene === "C1-3") text = "Plain text control\n@src/app.tsx $check.mobile";
  if (scene.startsWith("P3")) text = EXTERNAL;
  if (scene.startsWith("A1"))
    text += "\n\nTry $check.mobile and `src/app.tsx` or [app.tsx](file:///fixture/src/app.tsx).";
  if (scene.startsWith("F2")) text += "\n\n[Missing record; no size](t3-context://v1/file/no-size)";
  if (scene.startsWith("N1"))
    text +=
      "\n\n[Missing image](t3-context://v1/image/missing) [Missing terminal](t3-context://v1/terminal/missing)\n\nPlain control.";
  if (scene === "W1-chat" || scene === "W1-composer") {
    records = SIZES;
    text = markdown(records) + "\n\n" + markdown(ATLAS.slice(4, 8));
  }
  if (scene === "W1-plain")
    text =
      "Plain text without tokens. A sufficiently long paragraph wraps naturally across several lines so layout and foreground can be compared.";
  if (scene.startsWith("T")) {
    const id = scene === "T1" ? "favicon" : scene.replace(/^T[234]-/, "");
    const threadId = ThreadId.make(`linked-${id}`);
    const record = {
      ...ATLAS[9]!,
      kind: "thread" as const,
      environmentId: ENVIRONMENT_ID,
      threadId,
      title: `Linked ${id}`,
      label: `Linked ${id}`,
    };
    records = [record];
    text = markdown(records) + `\n\nRaw [${id} thread](t3-thread://v1/${threadId})`;
    if (scene.startsWith("T5")) {
      records = [
        {
          ...record,
          environmentId: remoteEnvironment,
          threadId: remoteThreadId,
          title: "Remote project",
          label: "Remote context",
        },
      ];
      text = markdown(records) + "\n\n[Remote alias](t3-thread://v1/remote%3Alinked)";
    }
  }
  if (scene === "E4" || scene === "E4-empty")
    text = `Prose before [file](file:///fixture/src/app.tsx).\n\n<review_comment sectionId="file:src/app.tsx" sectionTitle="src/app.tsx" filePath="src/app.tsx" startIndex="0" endIndex="0" rangeLabel="L1">\n${scene === "E4-empty" ? "" : REVIEW.text}\n\`\`\`diff\n${REVIEW.diff}\n\`\`\`\n</review_comment>\n\nProse after [terminal](t3-context://v1/terminal/terminal).`;
  const composer = scene.includes("composer") || scene.startsWith("C1");
  const recordJson = JSON.stringify(records);
  useEffect(() => {
    const draftContext = context(decodeRecords(JSON.parse(recordJson)));
    setComposerDraftContext(draftKey, draftContext);
    setComposerDraftText(draftKey, composer ? text : "");
  }, [composer, text, recordJson]);
  const content =
    scene === "G3-home" ? (
      <HomeFixture projects={projects} thread={shell} />
    ) : scene === "G3-archive" ? (
      <ArchiveFixture projects={projects} thread={shell} />
    ) : scene === "G2" ? (
      <FaviconLifecycleFixture setUrl={preload} />
    ) : scene === "G3-new-task" || (scene.startsWith("C2") && scene !== "C2-thread-composer") ? (
      <NewTaskFixture
        picker={scene === "G3-new-task"}
        project={projects[0]!}
        text={text}
        records={records}
      />
    ) : scene.startsWith("E3") ? (
      <View style={{ flex: 1, justifyContent: "flex-end", padding: 12 }}>
        <PendingUserInputCard
          canOperateThread
          pendingUserInput={{
            requestId: RuntimeRequestId.make("fixture-question"),
            createdAt: FIXED_TIME,
            questions: [
              {
                id: "choice",
                header: "Fixture choice",
                question: PREVIEW,
                options: [
                  { label: "Keep", description: "Keep current behavior" },
                  { label: "Change", description: "Use the requested behavior" },
                ],
                multiSelect: false,
              },
            ],
            responseCapability: "live",
            dismissible: true,
          }}
          maxHeight={600}
          collapsed={scene === "E3-collapsed"}
          onToggleCollapsed={() =>
            setRequest({
              ...request,
              scene: scene === "E3-collapsed" ? "E3-expanded" : "E3-collapsed",
            })
          }
          drafts={{}}
          answers={null}
          respondingUserInputId={null}
          onSelectOption={() => {}}
          onChangeCustomAnswer={() => {}}
          onSubmit={async () => {}}
          onDismiss={async () => {}}
        />
      </View>
    ) : scene === "E1" ? (
      <FileMarkdownPreview
        environmentId={ENVIRONMENT_ID}
        threadId={THREAD_ID}
        cwd="/fixture"
        relativePath="README.md"
        markdown={PREVIEW}
        captured
      />
    ) : scene.startsWith("E2") ? (
      <ScrollView className="bg-screen" contentContainerStyle={{ padding: 16 }}>
        <PullRequestMarkdownRepository
          value="fixture/repo"
          params={{
            environmentId: ENVIRONMENT_ID,
            projectId: projects[0]!.id,
            repository: "fixture/repo",
            number: 42,
          }}
        >
          {scene === "E2-timeline" ? (
            pullRequestTimelineRows(
              decodeActivity({
                comments: [
                  {
                    id: "fixture-comment",
                    kind: "issue-comment",
                    author: null,
                    body: Array(5).fill(PREVIEW).join("\n\n"),
                    createdAt: FIXED_TIME,
                    url: null,
                    path: null,
                    reviewState: null,
                  },
                ],
                commentCount: 1,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
              {
                environmentId: ENVIRONMENT_ID,
                projectId: projects[0]!.id,
                repository: "fixture/repo",
                number: 42,
              },
              navigation,
            ).map((row) => <View key={row.key}>{row.content}</View>)
          ) : scene === "E2-description" ? (
            <PullRequestDescription
              markdown={Array(5).fill(PREVIEW).join("\n\n")}
              expanded={false}
              onCollapse={() => {}}
              onExpandedChange={() => {}}
            />
          ) : (
            <View
              className={scene === "E2-grouped" ? "bg-grouped-card p-3 rounded-xl" : "bg-screen"}
              style={scene === "E2-note" ? { marginLeft: 40 } : undefined}
            >
              <PullRequestMarkdown
                markdown={
                  PREVIEW +
                  "\n\n[Repository file](src/app.tsx)\n\n[A long wrapping chip label whose suffix remains visible](file:///fixture/src/a-very-long-name.tsx)"
                }
              />
            </View>
          )}
        </PullRequestMarkdownRepository>
      </ScrollView>
    ) : scene === "G3-sizes" ? (
      <ScrollView className="bg-screen" contentContainerStyle={{ padding: 12, gap: 12 }}>
        {[15, 18, 20, 24, 48].map((size) => (
          <View key={size} className="bg-grouped-card p-3" style={{ gap: 8 }}>
            <Text style={{ color: colors["--color-foreground"] }}>
              Caller size {size} / normal and 0.4 opacity
            </Text>
            {[1, 0.4].map((opacity) => (
              <View key={opacity} style={{ opacity, flexDirection: "row", gap: 12 }}>
                {projectKinds.slice(0, 4).map((kind) => (
                  <ProjectFavicon
                    key={kind.id}
                    environmentId={ENVIRONMENT_ID}
                    projectTitle={kind.title}
                    workspaceRoot={`/fixture/${kind.id}`}
                    projectIcon={kind.icon}
                    size={size}
                  />
                ))}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    ) : scene === "G1" ? (
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {projects.map((project) => (
          <View key={project.id} style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            <ProjectFavicon
              environmentId={ENVIRONMENT_ID}
              projectTitle={project.title}
              projectIcon={project.projectIcon}
              size={20}
            />
            <ProjectFavicon
              environmentId={ENVIRONMENT_ID}
              projectTitle={project.title}
              projectIcon={project.projectIcon}
              size={42}
            />
            <Text style={{ color: colors["--color-foreground"] }}>{project.title}</Text>
          </View>
        ))}
      </ScrollView>
    ) : (
      <ThreadFeed
        key={scene}
        environmentId={ENVIRONMENT_ID}
        threadId={THREAD_ID}
        threadTitle="Chip contrast fixture"
        workspaceRoot="/fixture"
        queuedMessages={[]}
        dispatchingMessageId={null}
        onEditPendingMessage={null}
        feed={
          composer
            ? []
            : [
                ...feed(
                  text,
                  role,
                  role === "user" ? records : undefined,
                  scene === "P3-streaming",
                ),
                ...(scene.startsWith("T")
                  ? feed(
                      scene.startsWith("T5")
                        ? "Assistant [remote alias](t3-thread://v1/remote%3Alinked)"
                        : `Assistant [linked thread](t3-thread://v1/linked-${scene === "T1" ? "favicon" : scene.replace(/^T[234]-/, "")})`,
                      "assistant",
                    )
                  : []),
              ]
        }
        contentPresentation={{ kind: "ready" }}
        agentLabel="Fixture agent"
        latestRun={null}
        activeWorkStartedAt={null}
        listRef={listRef}
        freeze={freeze}
        anchorMessageId={null}
        submittedMessageId={null}
        contentInsetEndAdjustment={endAdjustment}
        keyboardOffset={0}
        contentTopInset={12}
        contentBottomInset={12}
        skills={SKILLS}
      />
    );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors["--color-thread-canvas"] }}>
      <StatusBar barStyle={appearance === "dark" ? "light-content" : "dark-content"} />
      <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 4 }}>
        <Text
          accessibilityLabel={`Fixture ${scene} ${themeId} ${themeAppearance}`}
          style={{ color: colors["--color-foreground"], fontSize: 16, fontWeight: "600" }}
        >
          {scene} · {themeId} · {themeAppearance}
        </Text>
        <Text style={{ color: colors["--color-foreground-muted"], fontSize: 12 }}>
          Offline native fixture · 2026-01-01 · {fontSize} pt
        </Text>
        <View style={{ flexDirection: "row", gap: 20 }}>
          <Pressable
            accessibilityLabel="Previous fixture"
            onPress={() =>
              setRequest({
                ...request,
                scene: SCENES[(SCENES.indexOf(scene) + SCENES.length - 1) % SCENES.length]!,
              })
            }
          >
            <Text style={{ color: colors["--color-foreground"] }}>Previous</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Next fixture"
            onPress={() =>
              setRequest({
                ...request,
                scene: SCENES[(SCENES.indexOf(scene) + 1) % SCENES.length]!,
              })
            }
          >
            <Text style={{ color: colors["--color-foreground"] }}>Next</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Toggle appearance"
            onPress={() =>
              setRequest({ ...request, appearance: appearance === "light" ? "dark" : "light" })
            }
          >
            <Text style={{ color: colors["--color-foreground"] }}>Light / dark</Text>
          </Pressable>
          <Pressable accessibilityLabel="Open palette" onPress={() => setPalette(true)}>
            <Text style={{ color: colors["--color-foreground"] }}>Palette</Text>
          </Pressable>
        </View>
      </View>
      <View style={{ flex: 1 }}>{content}</View>
      {composer ? (
        <ThreadComposer
          key={scene}
          canOperateThread
          placeholder="Static draft"
          connectionState="offline"
          environmentLabel="Offline fixture"
          selectedThread={shell}
          hasCompactableConversation={false}
          serverConfig={SERVER_CONFIG}
          queueCount={0}
          activeThreadBusy={false}
          canStopThread={false}
          environmentId={ENVIRONMENT_ID}
          projectCwd="/fixture"
          draftKey={draftKey}
          followUpBehavior="queue"
          canSteerActiveTurn={false}
          hidden={false}
          onChangeDraftMessage={(value) => setComposerDraftText(draftKey, value)}
          onPickDraftMedia={async () => {}}
          onPickDraftFiles={async () => {}}
          onNativePasteImages={async () => {}}
          onNativePasteText={async () => {}}
          onRemoveDraftImage={() => {}}
          onStopThread={() => {}}
          onResumeQueue={null}
          onSendMessage={async () => null}
          onShowUsageLimits={() => {}}
          canSwitchProvider={false}
          onUpdateModelSelection={() => {}}
          onUpdateRuntimeMode={() => {}}
          onUpdateInteractionMode={() => {}}
        />
      ) : null}
      {palette || scene === "K1" || scene.startsWith("K2") ? (
        <CommandPalette pathname="/" onClose={() => setPalette(false)} onCommand={() => {}} />
      ) : null}
      <Rasterizer />
      <Dialog.Host />
      <OverlayPortalHost />
    </SafeAreaView>
  );
}
function FixtureNavigation() {
  const theme = useMobileNavigationTheme();
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: "none" }}>
        <Stack.Screen name="ChipEvidence" component={FixtureScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
export default function ChipEvidenceApp() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <AppearancePreferencesProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider>
            <SafeAreaProvider>
              <VoiceInputProvider>
                <NativeLayoutMetricsProvider>
                  <ExistingThreadSettingsRouteProvider>
                    <FixtureNavigation />
                  </ExistingThreadSettingsRouteProvider>
                </NativeLayoutMetricsProvider>
              </VoiceInputProvider>
            </SafeAreaProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </AppearancePreferencesProvider>
    </RegistryContext.Provider>
  );
}
