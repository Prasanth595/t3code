import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useEffect } from "react";
import { ArchivedThreadsScreen } from "../archive/ArchivedThreadsScreen";
import { HomeScreen } from "../home/HomeScreen";
import { NewTaskDraftScreen } from "../threads/NewTaskDraftScreen";
import { NewTaskRouteScreen } from "../threads/NewTaskRouteScreen";
import { NewTaskFlowProvider, useNewTaskFlow } from "../threads/new-task-flow-provider";
import { IncomingShareProvider } from "../sharing/IncomingShareProvider";
import { useWorkspaceState } from "../../state/workspace";
import { setComposerDraftText, setComposerDraftContext } from "../../state/use-composer-drafts";
import { FIXED_TIME } from "./fixtures";
import { ComposerContextRecord } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const decodeContextRecords = Schema.decodeUnknownSync(Schema.Array(ComposerContextRecord));

const noop = () => {};
const no = async () => false;
export function ArchiveFixture({
  projects,
  thread,
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly thread: EnvironmentThreadShell;
}) {
  return (
    <ArchivedThreadsScreen
      environments={[]}
      error={null}
      groups={projects.slice(0, 4).map((project, index) => ({
        key: project.id,
        project,
        threads: [
          {
            ...thread,
            id: `${thread.id}-${index}` as typeof thread.id,
            projectId: project.id,
            title: `${project.title} archived thread`,
            archivedAt: FIXED_TIME,
          },
        ],
      }))}
      isLoading={false}
      searchQuery=""
      selectedEnvironmentId={null}
      sortOrder="newest"
      onDeleteThread={noop}
      onEnvironmentChange={noop}
      onRefresh={noop}
      onSearchQueryChange={noop}
      onSortOrderChange={noop}
      onUnarchiveThread={noop}
    />
  );
}
export function HomeFixture({
  projects,
  thread,
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly thread: EnvironmentThreadShell;
}) {
  const { state } = useWorkspaceState();
  return (
    <HomeScreen
      projects={projects.slice(0, 5)}
      threads={projects.slice(0, 5).map((project, index) => ({
        ...thread,
        id: `${thread.id}-${index}` as typeof thread.id,
        projectId: project.id,
        title: `${project.title} thread`,
      }))}
      pendingTasks={[]}
      catalogState={state}
      savedConnectionsById={{}}
      environments={[]}
      searchQuery=""
      selectedEnvironmentId={null}
      selectedProjectKey={null}
      projectSortOrder="updated_at"
      projectGroupingMode="separate"
      onSearchQueryChange={noop}
      onEnvironmentChange={noop}
      onProjectChange={noop}
      onAddConnection={noop}
      onOpenSettings={noop}
      onStartNewTask={noop}
      onSelectThread={noop}
      onArchiveThread={noop}
      onDeleteThread={noop}
      onSettleThread={no}
      onSnoozeThread={no}
      onUnsnoozeThread={no}
      onUnsettleThread={noop}
      onPinThread={no}
      onUnpinThread={no}
      onSetThreadAutoSettle={no}
      onMoveThread={no}
      onRenameThread={noop}
      onRegenerateThreadTitle={no}
      onSelectPendingTask={noop}
      onDeletePendingTask={noop}
      onNewThreadOnBranch={noop}
      onNewThreadInProject={noop}
    />
  );
}
function DraftSeed({
  project,
  text,
  records,
}: {
  readonly project: EnvironmentProject;
  readonly text: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
}) {
  const flow = useNewTaskFlow();
  const selectedProject = flow.selectedProject;
  const setProject = flow.setProject;
  const draftKey = flow.draftKey;
  useEffect(() => {
    if (selectedProject?.id !== project.id) setProject(project);
  }, [selectedProject?.id, project, setProject]);
  const recordJson = JSON.stringify(records);
  useEffect(() => {
    if (!draftKey) return;
    setComposerDraftText(draftKey, text);
    setComposerDraftContext(draftKey, {
      version: 1,
      records: decodeContextRecords(JSON.parse(recordJson)),
    });
  }, [draftKey, text, recordJson]);
  return <NewTaskDraftScreen />;
}
function ProjectChoices() {
  return <NewTaskRouteScreen route={{ params: undefined }} />;
}
export function NewTaskFixture(props: {
  readonly project: EnvironmentProject;
  readonly text: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
  readonly picker?: boolean;
}) {
  return (
    <IncomingShareProvider>
      <NewTaskFlowProvider>
        {props.picker ? <ProjectChoices /> : <DraftSeed {...props} />}
      </NewTaskFlowProvider>
    </IncomingShareProvider>
  );
}
