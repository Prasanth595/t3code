import { useAtomValue } from "@effect/atom-react";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CopyIcon,
  HammerIcon,
  LinkIcon,
  MessageCircleQuestionIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";

import { shortcutLabelForCommand } from "~/keybindings";
import { readLocalApi } from "~/localApi";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ActOnEnvironmentPicker, type PerformPullRequestAction } from "./PullRequestDetailActions";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  pullRequestActionMenuHasGroup,
} from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import type { PickableEnvironment } from "./pullRequestProjectAssignment.logic";
import { PullRequestThreadLinks } from "./PullRequestThreadLinks";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

/** Everything else the reader can do with the pull request, behind the header's overflow button. */
export function PullRequestActionsMenu({
  environmentId,
  reference,
  pullRequestKey,
  detail,
  terminology,
  linkThreadRef,
  onThreadPickerOpenChange,
  refreshing,
  refreshFromHost,
  handoff,
  attachesToComposer,
  askAboutPullRequest,
  canFixFindings,
  startFixFindings,
  handoffLabels,
  pickableEnvironments,
  actingEnvironmentId,
  onActingEnvironmentChange,
  can,
  autoMergeArmed,
  showsDraftToggle,
  showsAutoMerge,
  showsMergeMethods,
  allowedMergeMethods,
  selectedMergeMethod,
  onSelectMergeMethod,
  showsDeleteBranch,
  environmentConnected,
  confirmDeleteBranch,
  pendingAction,
  perform,
  openOnHostText,
  copyReference,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pullRequestKey: string;
  detail: Pick<PullRequestDetail, "url" | "state" | "isDraft" | "headBranch">;
  terminology: ChangeRequestTerminology;
  linkThreadRef: ScopedThreadRef | null;
  onThreadPickerOpenChange: (open: boolean) => void;
  refreshing: boolean;
  refreshFromHost: () => Promise<void>;
  handoff: string | null;
  attachesToComposer: boolean;
  askAboutPullRequest: () => void;
  canFixFindings: boolean;
  startFixFindings: () => void;
  handoffLabels: { readonly fixFindings: string };
  pickableEnvironments: ReadonlyArray<PickableEnvironment>;
  actingEnvironmentId: EnvironmentId;
  onActingEnvironmentChange: (environmentId: EnvironmentId) => void;
  can: (action: PullRequestAction) => boolean;
  autoMergeArmed: boolean;
  showsDraftToggle: boolean;
  showsAutoMerge: boolean;
  showsMergeMethods: boolean;
  allowedMergeMethods: ReadonlyArray<PullRequestMergeMethod>;
  selectedMergeMethod: PullRequestMergeMethod;
  onSelectMergeMethod: (method: PullRequestMergeMethod) => void;
  showsDeleteBranch: boolean;
  environmentConnected: boolean;
  confirmDeleteBranch: () => Promise<void>;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  openOnHostText: string;
  copyReference: (value: string, label: string) => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label={
                    refreshing
                      ? `Refreshing ${terminology.singular}`
                      : `More ${terminology.singular} actions`
                  }
                  size="icon-xs"
                  variant="ghost-muted"
                />
              }
            >
              {refreshing ? (
                <RefreshIcon refreshing size="md" />
              ) : (
                <MoreHorizontalIcon className="size-4" />
              )}
            </MenuTrigger>
          }
        />
        <TooltipPopup>
          {refreshing
            ? `Refreshing ${terminology.singular}`
            : `More ${terminology.singular} actions`}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <PullRequestThreadLinks
          display="menu-item"
          environmentId={environmentId}
          reference={reference}
          url={detail.url}
          threadRef={linkThreadRef}
          onPickerOpenChange={onThreadPickerOpenChange}
        />
        <MenuItem disabled={refreshing} onClick={() => void refreshFromHost()}>
          <RefreshIcon size="sm" refreshing={refreshing} />
          Refresh
        </MenuItem>
        <MenuItem disabled={handoff !== null} onClick={askAboutPullRequest}>
          <MessageCircleQuestionIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>{handoff === "ask" ? "Opening..." : "Ask a question"}</span>
            <span className="text-xs text-muted-foreground">
              {attachesToComposer
                ? `Adds the ${terminology.singular} to this thread's composer.`
                : `Opens a thread that knows which ${terminology.singular} you mean.`}
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={handoff !== null || !canFixFindings} onClick={startFixFindings}>
          <HammerIcon className="size-3.5" />
          {handoff === "findings" ? "Preparing..." : handoffLabels.fixFindings}
        </MenuItem>
        {pickableEnvironments.length > 0 ? (
          <ActOnEnvironmentPicker
            environments={pickableEnvironments}
            value={actingEnvironmentId}
            onChange={onActingEnvironmentChange}
            disabled={handoff !== null}
          />
        ) : null}
        <MenuSeparator />
        {detail.state === "open" ? (
          <>
            {showsDraftToggle ? (
              <MenuItem
                disabled={actionPending}
                onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
              >
                {detail.isDraft ? (
                  <PullRequestGlyph.pullRequest className="size-3.5" />
                ) : (
                  <PullRequestGlyph.draft className="size-3.5" />
                )}
                {detail.isDraft ? "Ready for review" : "Convert to draft"}
              </MenuItem>
            ) : null}
            {/* The same merge, left with the host to carry out once its requirements
                pass. A conflicting branch cannot be armed because nothing the host
                waits for will clear the conflict. */}
            {autoMergeArmed && can("disable-auto-merge") ? (
              <MenuItem disabled={actionPending} onClick={() => void perform("disable-auto-merge")}>
                <PullRequestGlyph.merged className="size-3.5" />
                Disable auto-merge
              </MenuItem>
            ) : showsAutoMerge ? (
              <MenuItem
                closeOnClick={inlineConfirm.isArmed("enable-auto-merge")}
                aria-label={
                  inlineConfirm.isArmed("enable-auto-merge")
                    ? "Confirm auto-merge?"
                    : "Enable auto-merge"
                }
                disabled={actionPending}
                {...inlineConfirm.props(
                  "enable-auto-merge",
                  () => void perform("enable-auto-merge", selectedMergeMethod),
                )}
              >
                <PullRequestGlyph.merged className="size-3.5" />
                {inlineConfirm.isArmed("enable-auto-merge")
                  ? "Confirm auto-merge?"
                  : "Enable auto-merge"}
              </MenuItem>
            ) : null}
            {showsMergeMethods ? (
              <>
                {/* Only below the draft control. A host with no draft of its own, or
                    a draft whose control is already the header button, would leave
                    this against the separator that opened the group. */}
                {showsDraftToggle || showsAutoMerge ? <MenuSeparator /> : null}
                <MenuRadioGroup
                  value={selectedMergeMethod}
                  onValueChange={(method) => onSelectMergeMethod(method as PullRequestMergeMethod)}
                >
                  {allowedMergeMethods.map((method) => (
                    <MenuRadioItem
                      key={method}
                      value={method}
                      disabled={actionPending}
                      closeOnClick
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <PullRequestGlyph.merged className="size-3.5" />
                        <span>{PULL_REQUEST_MERGE_METHOD_LABELS[method]}</span>
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </>
            ) : null}
            {pullRequestActionMenuHasGroup(showsDraftToggle, showsAutoMerge, showsMergeMethods) ? (
              <MenuSeparator />
            ) : null}
          </>
        ) : null}
        <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}>
          <ArrowUpRightIcon className="size-3.5" />
          {openOnHostText}
        </MenuItem>
        <MenuItem onClick={() => copyReference(detail.url, `${terminology.shortLabel} link`)}>
          <LinkIcon className="size-3.5" />
          Copy link
          <MenuShortcut>
            {shortcutLabelForCommand(keybindings, "thread.copyReference")}
          </MenuShortcut>
        </MenuItem>
        <MenuItem
          onClick={() => copyReference(`#${reference.number}`, `${terminology.shortLabel} number`)}
        >
          <CopyIcon className="size-3.5" />
          Copy {terminology.shortLabel} number
          <MenuShortcut>
            {shortcutLabelForCommand(keybindings, "pullRequest.copyNumber")}
          </MenuShortcut>
        </MenuItem>
        {detail.state === "open" && can("close") ? (
          <>
            <MenuSeparator />
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("close")}
              aria-label={
                inlineConfirm.isArmed("close") ? "Confirm close?" : `Close ${terminology.singular}`
              }
              variant="destructive"
              disabled={actionPending}
              {...inlineConfirm.props("close", () => void perform("close"))}
            >
              <PullRequestGlyph.closed className="size-3.5" />
              {inlineConfirm.isArmed("close") ? "Confirm close?" : `Close ${terminology.singular}`}
            </MenuItem>
          </>
        ) : detail.state === "closed" && can("reopen") ? (
          <>
            <MenuSeparator />
            <MenuItem disabled={actionPending} onClick={() => void perform("reopen")}>
              <PullRequestGlyph.reopen className="size-3.5" />
              Reopen {terminology.singular}
            </MenuItem>
          </>
        ) : detail.state === "merged" && can("revert") ? (
          <>
            <MenuSeparator />
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("revert")}
              aria-label={inlineConfirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"}
              variant={inlineConfirm.isArmed("revert") ? "destructive" : "default"}
              disabled={actionPending}
              {...inlineConfirm.props("revert", () => void perform("revert"))}
            >
              <RotateCcwIcon className="size-3.5" />
              {inlineConfirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"}
            </MenuItem>
          </>
        ) : null}
        {showsDeleteBranch ? (
          <>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={actionPending || !environmentConnected}
              onClick={() => void confirmDeleteBranch()}
            >
              <Trash2Icon className="mt-1 size-3.5 shrink-0 self-start" />
              <span className="flex min-w-0 flex-col">
                <span>
                  {pendingAction === "delete-branch" ? "Deleting branch..." : "Delete branch"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {environmentConnected ? detail.headBranch : "Reconnect to delete this branch"}
                </span>
              </span>
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
