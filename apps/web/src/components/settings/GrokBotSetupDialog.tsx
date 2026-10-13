import { grokBotMcpSetup } from "@t3tools/client-runtime/connection";
import type { AuthMcpClientAccess, EnvironmentMachineKind } from "@t3tools/contracts";
import { grokClient } from "@t3tools/provider-grok/client";
import {
  ArrowLeftRightIcon,
  ArrowUpRightIcon,
  CalendarClockIcon,
  CopyIcon,
  EyeIcon,
  GlobeLockIcon,
  type LucideIcon,
  PaperclipIcon,
  SquareTerminalIcon,
  UnplugIcon,
} from "lucide-react";
import { useId, useRef } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { ProviderPackageIcon } from "../chat/ProviderPackageIcon";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { stackedThreadToast, toastManager } from "../ui/toast";

const GROK_BOT_DOCS_URL = "https://docs.x.ai/grok-bot/team-bots";

// Labels and icons match the levels on T3's approval page.
const ACCESS_LEVELS = {
  "read-only": { label: "Read only", icon: EyeIcon },
  "approval-required": runtimeModeConfig["approval-required"],
} satisfies Partial<Record<AuthMcpClientAccess, { label: string; icon: LucideIcon }>>;

// Grok Bot works across its own apps; these are the parts that reach T3 through
// its MCP tools, with the least access the approval page must grant for each.
const BOT_CAPABILITIES: ReadonlyArray<{
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
  readonly access: keyof typeof ACCESS_LEVELS;
}> = [
  {
    icon: SquareTerminalIcon,
    title: "Hand off coding from anywhere",
    description:
      "Ask from its chat, Slack, or email. It launches a T3 thread and can steer or stop it.",
    access: "approval-required",
  },
  {
    icon: CalendarClockIcon,
    title: "Report back where you work",
    description: "A routine can wait on a thread and post the results to Slack or its chat.",
    access: "read-only",
  },
  {
    icon: PaperclipIcon,
    title: "Bring context along",
    description: "It can attach screenshots and files from its browser and apps to a thread.",
    access: "approval-required",
  },
];

export function GrokBotSetupDialog({
  open,
  onOpenChange,
  environmentLabel,
  machineKind,
  mcpUrl,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentLabel: string;
  readonly machineKind: EnvironmentMachineKind;
  readonly mcpUrl: string | null;
}) {
  const urlId = useId();
  const copyPromptRef = useRef<HTMLButtonElement>(null);
  const { copyToClipboard } = useCopyToClipboard<"prompt" | "configuration" | "url">({
    target: "Grok Bot setup",
    onCopy: (kind) => {
      toastManager.add({
        type: "success",
        title:
          kind === "prompt"
            ? "Setup prompt copied"
            : kind === "configuration"
              ? "MCP configuration copied"
              : "MCP server URL copied",
        description:
          kind === "prompt"
            ? "Paste it into your existing Grok Bot chat."
            : "Add it as a custom Remote HTTPS MCP server in Grok Bot, then sign in.",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy Grok Bot setup",
          description: error.message,
        }),
      );
    },
  });
  const setup = mcpUrl === null ? null : { url: mcpUrl, ...grokBotMcpSetup(mcpUrl) };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup initialFocus={setup === null ? true : copyPromptRef}>
        <DialogHeader>
          <div aria-hidden className="mb-2 flex items-center gap-1.5 text-muted-foreground">
            <span className="flex size-9 items-center justify-center rounded-lg border bg-muted/40">
              <ProviderPackageIcon icon={grokClient.icon} className="size-5" />
            </span>
            <span className="h-px w-4 bg-border" />
            {setup === null ? (
              <UnplugIcon className="size-3.5" />
            ) : (
              <ArrowLeftRightIcon className="size-3.5" />
            )}
            <span className="h-px w-4 bg-border" />
            <span className="flex size-9 items-center justify-center rounded-lg border bg-muted/40 text-foreground">
              <EnvironmentMachineIcon kind={machineKind} className="size-4.5" />
            </span>
          </div>
          <DialogTitle>Connect Grok Bot</DialogTitle>
          <DialogDescription>
            Your Bot keeps working from its own cloud computer. Give it {environmentLabel}'s
            projects, and coding work runs here as T3 threads you can review.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {setup === null ? (
            <Alert variant="info">
              <GlobeLockIcon aria-hidden />
              <AlertTitle>{environmentLabel} isn't reachable from the cloud</AlertTitle>
              <AlertDescription>
                Turn on T3 Connect for this environment or add a public HTTPS route, then reopen
                this setup. The Bot can't use localhost, LAN, or private Tailscale addresses.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <ul className="divide-y rounded-xl border">
                {BOT_CAPABILITIES.map((capability) => (
                  <li key={capability.title} className="flex items-start gap-3 px-3.5 py-3">
                    <capability.icon
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{capability.title}</p>
                      <p className="text-xs text-muted-foreground">{capability.description}</p>
                    </div>
                    <AccessBadge access={capability.access} />
                  </li>
                ))}
              </ul>
              <ol className="space-y-2 text-sm">
                {[
                  "Copy the setup prompt into your Bot's chat.",
                  "Approve the T3 sign-in it opens. The page may call it “Cursor”.",
                  "Pick Read only or Supervised. Revoke it any time in Connections.",
                ].map((step, index) => (
                  <li key={step} className="flex items-start gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
                      {index + 1}
                    </span>
                    <span className="pt-px">{step}</span>
                  </li>
                ))}
              </ol>
              <div className="space-y-1.5">
                <label htmlFor={urlId} className="text-sm font-medium">
                  MCP server URL
                </label>
                <InputGroup>
                  <InputGroupInput id={urlId} readOnly value={setup.url} />
                  <InputGroupAddon align="inline-end">
                    <Button
                      aria-label="Copy MCP server URL"
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => copyToClipboard(setup.url, "url")}
                    >
                      <CopyIcon />
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
                <p className="text-xs text-muted-foreground">
                  Remote HTTPS with OAuth. Leave headers and client credentials empty.
                </p>
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <div className="sm:me-auto">
            <Button
              variant="ghost"
              render={<a href={GROK_BOT_DOCS_URL} target="_blank" rel="noreferrer" />}
            >
              Grok Bot docs
              <ArrowUpRightIcon />
            </Button>
          </div>
          {setup === null ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => copyToClipboard(setup.configuration, "configuration")}
              >
                Copy configuration
              </Button>
              <Button ref={copyPromptRef} onClick={() => copyToClipboard(setup.prompt, "prompt")}>
                Copy setup prompt
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function AccessBadge({ access }: { readonly access: keyof typeof ACCESS_LEVELS }) {
  const level = ACCESS_LEVELS[access];
  return (
    <Badge variant="outline" size="sm">
      <level.icon aria-hidden />
      {level.label}
    </Badge>
  );
}
