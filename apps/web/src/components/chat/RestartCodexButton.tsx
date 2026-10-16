import type { EnvironmentId, ThreadId, RunId } from "@t3tools/contracts";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function RestartCodexButton({
  environmentId,
  threadId,
  retryRunId,
  continueWork = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  retryRunId: RunId;
  continueWork?: boolean;
}) {
  const restart = useAtomCommand(orchestrationEnvironment.restartCodex, { reportFailure: false });
  const allowed = useAtomValue(orchestrationEnvironment.restartCodex.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={!allowed || pending}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          setMessage(null);
          try {
            const result = await restart({ environmentId, input: { threadId, retryRunId } });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            toastManager.add({
              type: "success",
              title: continueWork ? "Conversation continued." : "Message resent.",
            });
          } catch (cause) {
            setMessage(
              cause instanceof Error ? cause.message : "Could not recover the conversation.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        {pending
          ? continueWork
            ? "Continuing…"
            : "Retrying message…"
          : continueWork
            ? "Continue"
            : "Retry message"}
      </Button>
      {message ? (
        <p role="status" className="text-xs">
          {message}
        </p>
      ) : null}
    </div>
  );
}
