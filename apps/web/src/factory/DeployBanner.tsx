import { AlarmClockIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";

import type { FactoryStatus } from "./api";
import { formatClock } from "./belt";

/** The states a run stays in while it waits on a person, which autodeploy does not wait for. */
const WAITING_ON_A_PERSON = new Set(["pr-open", "needs-info", "stuck"]);

/** The runs an update interrupts, by the rule `factory/scripts/autodeploy.sh` waits on. */
const runsInProgress = (runs: FactoryStatus["runs"]) =>
  runs.filter(({ state, unreadable }) => unreadable || !WAITING_ON_A_PERSON.has(state ?? ""));

const clockOf = (iso: string | null) => {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? null : formatClock(ms);
};

/**
 * The selected environment's waiting update: which build, how it holds claims, and Snooze 1 hour
 * and Update now. Update now asks first when it would interrupt a run or a thread at work. After an
 * Update now is accepted, `updating` says what happens next and stands in for the rest.
 */
export function DeployBanner({
  status,
  busy,
  updating,
  onSnooze,
  onDeployNow,
}: {
  status: FactoryStatus;
  /** A snooze or Update now of this environment is in flight. */
  busy: boolean;
  updating: string | null;
  onSnooze: () => void;
  onDeployNow: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const pending = status.deploy_pending;
  if (!pending) return null;

  if (updating !== null) {
    return (
      <div data-factory-update="">
        <Alert variant="info">
          <RefreshCwIcon />
          <AlertTitle>{updating}</AlertTitle>
        </Alert>
      </div>
    );
  }

  const inProgress = runsInProgress(status.runs);
  const threads = status.threads?.running ?? 0;
  const build = pending.commit ? `Build ${pending.commit.slice(0, 7)}` : "A new build";
  const snoozedUntil = clockOf(pending.snoozed_until);
  const deployBy = clockOf(pending.deploy_by);
  const title = snoozedUntil !== null ? `Update snoozed until ${snoozedUntil}.` : "Update waiting.";
  const description =
    snoozedUntil !== null
      ? `${build} is waiting. The factory claims work as normal until then.`
      : `${build} is ready to install. The factory claims no new work until it installs` +
        (deployBy === null
          ? "."
          : `, at ${deployBy} at the latest` +
            (inProgress.length > 0 ? ", or sooner once the runs in progress finish." : "."));

  return (
    <div data-factory-update="">
      <Alert controlAlignment="first-line" variant={snoozedUntil !== null ? "info" : "warning"}>
        {snoozedUntil !== null ? <AlarmClockIcon /> : <DownloadIcon />}
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
        <AlertAction>
          <Button disabled={busy} onClick={onSnooze} size="xs" variant="outline">
            Snooze 1 hour
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              inProgress.length > 0 || threads > 0 ? setConfirming(true) : onDeployNow()
            }
            size="xs"
          >
            Update now
          </Button>
        </AlertAction>
      </Alert>
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Update now?</AlertDialogTitle>
            <AlertDialogDescription>
              {build} installs now and the server restarts.
              {inProgress.length > 0 ? " These runs in progress will be interrupted:" : ""}
            </AlertDialogDescription>
            {inProgress.length > 0 ? (
              <ul className="list-disc pl-5 text-sm">
                {inProgress.map(({ id, title: runTitle }) => (
                  <li className="break-words" key={id}>
                    {runTitle ?? id}
                  </li>
                ))}
              </ul>
            ) : null}
            {threads > 0 ? (
              <p className="text-sm text-muted-foreground">
                {threads} {threads === 1 ? "thread" : "threads"} with an agent at work will be
                interrupted; you continue them in T3.
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                setConfirming(false);
                onDeployNow();
              }}
              variant="destructive"
            >
              Update now
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
