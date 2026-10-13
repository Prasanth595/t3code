import { grokBotMcpSetup } from "@t3tools/client-runtime/connection";
import { useId } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function GrokBotSetupDialog({
  open,
  onOpenChange,
  environmentLabel,
  mcpUrl,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentLabel: string;
  readonly mcpUrl: string | null;
}) {
  const urlId = useId();
  const { copyToClipboard } = useCopyToClipboard<"prompt" | "configuration">({
    target: "Grok Bot setup",
    onCopy: (kind) => {
      toastManager.add({
        type: "success",
        title: kind === "prompt" ? "Setup prompt copied" : "MCP configuration copied",
        description:
          kind === "prompt"
            ? "Paste it into your existing Grok Bot chat."
            : "Add it as a custom MCP server in Grok Bot, then sign in with OAuth.",
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
  const setup = mcpUrl === null ? null : grokBotMcpSetup(mcpUrl);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Connect Grok Bot</DialogTitle>
          <DialogDescription>
            Let your existing Bot work with {environmentLabel}'s projects and coding threads.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {mcpUrl === null ? (
            <p className="text-sm text-muted-foreground">
              Grok Bot connects from the cloud. Enable T3 Connect for this environment or add a
              publicly reachable HTTPS route, then reopen this setup. Localhost, LAN, and private
              Tailscale routes cannot be used by the Bot's connector.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <label htmlFor={urlId} className="text-sm font-medium">
                  MCP server URL
                </label>
                <Input id={urlId} readOnly value={mcpUrl} />
              </div>
              <p className="text-sm text-muted-foreground">
                Paste the setup prompt into your Bot's chat, or add the configuration as a custom
                Remote HTTPS MCP server. Leave headers and optional OAuth client credentials empty,
                then sign in. The T3 approval page may name the client “Cursor”.
              </p>
              <p className="text-sm text-muted-foreground">
                Read only lets the Bot inspect projects and threads. Choose Supervised or above to
                let it start, message, and stop coding threads. You choose access on T3's approval
                page and can revoke it in Connections.
              </p>
              <p className="text-sm text-muted-foreground">
                The Bot's conversation stays in Grok Bot; coding work stays in T3 threads on this
                environment. Keep the environment online while the Bot uses it.
              </p>
            </>
          )}
          <a
            href="https://docs.x.ai/grok-bot/team-bots"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Grok Bot MCP setup documentation
          </a>
        </DialogPanel>
        {setup !== null ? (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => copyToClipboard(setup.configuration, "configuration")}
            >
              Copy configuration
            </Button>
            <Button onClick={() => copyToClipboard(setup.prompt, "prompt")}>
              Copy setup prompt
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
