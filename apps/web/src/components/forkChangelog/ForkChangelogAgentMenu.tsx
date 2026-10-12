import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  BookOpenIcon,
  ChevronDownIcon,
  GitCompareArrowsIcon,
  HistoryIcon,
  MessageCircleQuestionIcon,
  type LucideIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";

import { APP_VERSION } from "../../branding";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readProjects } from "../../state/entities";
import { forkReleases, forkUpstreamPending } from "../../state/forkChangelog";
import { useEnvironmentQuery } from "../../state/query";
import { handoffPrompt } from "../pullRequest/pullRequestDetail.logic";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  buildForkChangelogAgentTask,
  FORK_CHANGELOG_CHIP_ID_PREFIX,
  type ForkChangelogAgentAction,
  type ForkChangelogAgentInput,
  type ForkChangelogTab,
  installedReleaseIndex,
  pickForkProject,
} from "./forkChangelog.logic";

/** What the last hand-off wrote into a draft, so the next one replaces it instead of stacking. */
const lastPromptByDraft = new Map<DraftId, string>();

/**
 * Fork feature: hands the changelog to an agent, like "Ask a question" on a pull request. Each
 * action opens a thread in the fork project with a changelog chip and a prompt to read and send.
 * The menu reads the same cached queries as the open tab, so it costs no extra GitHub call.
 */
export function ForkChangelogAgentMenu({
  environmentId,
  tab,
  onOpened,
}: {
  readonly environmentId: EnvironmentId;
  readonly tab: ForkChangelogTab;
  /** Called once the thread holds the task, so the dialog can get out of the way. */
  readonly onOpened: () => void;
}) {
  return tab === "releases" ? (
    <ReleasesAgentMenu environmentId={environmentId} onOpened={onOpened} />
  ) : (
    <UpstreamAgentMenu environmentId={environmentId} onOpened={onOpened} />
  );
}

interface MenuAction {
  readonly action: ForkChangelogAgentAction;
  readonly label: string;
  readonly description: string;
  readonly Icon: LucideIcon;
}

const ASK: MenuAction = {
  action: "ask",
  label: "Ask a question",
  description: "Opens a thread that knows this changelog.",
  Icon: MessageCircleQuestionIcon,
};

function ReleasesAgentMenu({
  environmentId,
  onOpened,
}: {
  readonly environmentId: EnvironmentId;
  readonly onOpened: () => void;
}) {
  const releases = useEnvironmentQuery(forkReleases({ environmentId, input: {} }));
  const input: ForkChangelogAgentInput = {
    tab: "releases",
    installedVersion: APP_VERSION,
    releases: releases.data?.releases ?? null,
    upstream: null,
  };
  const actions: MenuAction[] = [
    ASK,
    {
      action: "summarize-releases",
      label: "Summarize the changelog",
      description: "The listed releases, grouped by theme.",
      Icon: BookOpenIcon,
    },
  ];
  // Only when a listed release is newer than the installed one.
  if (installedReleaseIndex(input) > 0) {
    actions.push({
      action: "since-installed",
      label: "What changed since my version",
      description: `What the releases after ${APP_VERSION} add.`,
      Icon: HistoryIcon,
    });
  }
  return (
    <AgentMenu actions={actions} environmentId={environmentId} input={input} onOpened={onOpened} />
  );
}

function UpstreamAgentMenu({
  environmentId,
  onOpened,
}: {
  readonly environmentId: EnvironmentId;
  readonly onOpened: () => void;
}) {
  const pending = useEnvironmentQuery(forkUpstreamPending({ environmentId, input: {} }));
  const upstream = pending.data;
  const input: ForkChangelogAgentInput = {
    tab: "upstream",
    installedVersion: APP_VERSION,
    releases: null,
    upstream: upstream === null ? null : { total: upstream.total, compareUrl: upstream.compareUrl },
  };
  const actions: MenuAction[] = [ASK];
  if (upstream !== null && upstream.total > 0) {
    actions.push(
      {
        action: "summarize-upstream",
        label: "Summarize upstream changes",
        description: "The upstream commits fork main does not have yet.",
        Icon: BookOpenIcon,
      },
      {
        action: "upstream-impact",
        label: "Check the impact on the fork",
        description: "Where they touch fork changes, before the next Fork Sync.",
        Icon: GitCompareArrowsIcon,
      },
    );
  }
  return (
    <AgentMenu actions={actions} environmentId={environmentId} input={input} onOpened={onOpened} />
  );
}

function AgentMenu({
  actions,
  environmentId,
  input,
  onOpened,
}: {
  readonly actions: ReadonlyArray<MenuAction>;
  readonly environmentId: EnvironmentId;
  readonly input: ForkChangelogAgentInput;
  readonly onOpened: () => void;
}) {
  const newThread = useNewThreadHandler();
  const [pending, setPending] = useState<ForkChangelogAgentAction | null>(null);

  const start = async (action: ForkChangelogAgentAction) => {
    if (pending !== null) return;
    const project = pickForkProject(readProjects(), environmentId);
    if (project === null) {
      toastManager.add({
        type: "error",
        title: "No fork project here",
        description: "Add a checkout of the fork as a project on this machine, then ask again.",
      });
      return;
    }
    setPending(action);
    const session = await newThread(scopeProjectRef(environmentId, project.id)).then(
      (result) => result,
      () => null,
    );
    setPending(null);
    if (session === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    const task = buildForkChangelogAgentTask(action, input);
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(session.draftId);
    store.setPrompt(
      session.draftId,
      handoffPrompt(
        { prompt: draft?.prompt ?? "", lastHandoffPrompt: lastPromptByDraft.get(session.draftId) },
        task.prompt,
      ),
    );
    lastPromptByDraft.set(session.draftId, task.prompt);
    store.setReviewComments(session.draftId, [
      ...(draft?.reviewComments ?? []).filter(
        (comment) => !comment.id.startsWith(FORK_CHANGELOG_CHIP_ID_PREFIX),
      ),
      task.chip,
    ]);
    onOpened();
    toastManager.add({
      type: "success",
      title: "Asked in a thread",
      description:
        task.prompt.length > 0
          ? "The question is in the composer. Read it over, then send."
          : "The changelog is in the composer. Type your question, then send.",
    });
  };

  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        <SparklesIcon className="size-3.5" />
        <span>{pending === null ? "Ask agent" : "Opening…"}</span>
        <ChevronDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        {actions.map(({ action, label, description, Icon }) => (
          <MenuItem disabled={pending !== null} key={action} onClick={() => void start(action)}>
            <Icon className="mt-1 size-3.5 shrink-0 self-start" />
            <span className="flex min-w-0 flex-col">
              <span>{label}</span>
              <span className="text-xs text-muted-foreground">{description}</span>
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
