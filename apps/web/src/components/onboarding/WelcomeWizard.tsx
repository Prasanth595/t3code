import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  LinkIcon,
  MonitorIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  fetchMiraAccount,
  formatMiraTokens,
  hasMiraEnvironment,
  issueMiraModelKey,
  MIRA_PI_INSTANCE_ID,
  miraPiInstance,
} from "../../cloud/miraAccount";
import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import type { SaasAccountResponse } from "@t3tools/contracts/saas";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import {
  isOnboardingRelayEnvironment,
  resolveOnboardingSetup,
} from "../../onboarding/targetEnvironment.logic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { presentSavedCloudEnvironmentConnection } from "../cloud/cloudEnvironmentConnectionPresentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { T3Wordmark } from "../T3Wordmark";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CommandBlock } from "../CommandBlock";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { WizardPanel, WizardSteps, WizardPopup, WizardHeader } from "../ui/wizard";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";

type WizardStep = "account" | "connection" | "agents";

const ONBOARDING_STAGES = ["Account", "Connect", "Model"] as const;
const STEP_ORDER: readonly WizardStep[] = ["account", "connection", "agents"];

export function WelcomeWizard({
  localAvailable,
  onDone,
  resumeEnvironmentId,
}: {
  readonly localAvailable: boolean;
  readonly resumeEnvironmentId?: EnvironmentId | undefined;
  readonly onDone: (projectRef?: ScopedProjectRef) => void | Promise<void>;
}) {
  const [step, setStep] = useState<WizardStep>(resumeEnvironmentId ? "agents" : "account");
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(null);
  // Share the registry for the wizard's lifetime so unchecked computers are not auto-selected again.
  const [autoSelectedComputers] = useState(() => new Set<EnvironmentId>());
  const [setupIds, setSetupIds] = useState<readonly EnvironmentId[]>(
    resumeEnvironmentId ? [resumeEnvironmentId] : [],
  );
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  useEffect(() => {
    const newComputers = environments.filter(
      (environment) => !autoSelectedComputers.has(environment.environmentId),
    );
    if (newComputers.length === 0) return;
    for (const environment of newComputers) {
      autoSelectedComputers.add(environment.environmentId);
    }
    const enabledComputers = newComputers.filter((environment) => environment.entry.enabled);
    if (enabledComputers.length === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- The registry marks each computer once, and only after commit; render must not mutate it.
    setSelection(
      (current) =>
        new Set([
          ...(current ?? []),
          ...enabledComputers.map((environment) => environment.environmentId),
        ]),
    );
  }, [autoSelectedComputers, environments]);
  const selectedIds =
    selection ?? new Set(primaryEnvironment ? [primaryEnvironment.environmentId] : []);
  const startSetup = (ids: readonly EnvironmentId[]) => {
    if (ids.length === 0) return;
    setSetupIds(ids);
    setStep("agents");
  };
  const stageIndex = STEP_ORDER.indexOf(step);
  const finish = (projectRef?: ScopedProjectRef) => {
    if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
    if (completionErrorToastIdRef.current !== null) {
      toastManager.close(completionErrorToastIdRef.current);
      completionErrorToastIdRef.current = null;
    }

    const completion = completeOnboarding()
      .then(async () => {
        if (completionErrorToastIdRef.current !== null) {
          toastManager.close(completionErrorToastIdRef.current);
          completionErrorToastIdRef.current = null;
        }
        await onDone(projectRef);
        return true;
      })
      .catch(() => {
        const errorToast = {
          type: "error",
          title: "Could not finish setup",
          description: "Your settings could not be saved. Try again.",
        } as const;
        if (completionErrorToastIdRef.current === null) {
          completionErrorToastIdRef.current = toastManager.add(errorToast);
        } else {
          toastManager.update(completionErrorToastIdRef.current, errorToast);
        }
        return false;
      })
      .finally(() => {
        if (finishingPromiseRef.current === completion) {
          finishingPromiseRef.current = null;
        }
      });
    finishingPromiseRef.current = completion;
    return completion;
  };

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(_, event) => {
        event.cancel();
        if (event.reason === "close-press") void finish();
      }}
    >
      <WizardPopup
        size="wide"
        bottomStickOnMobile={false}
        initialFocus={() => document.getElementById("onboarding-pairing-url") ?? true}
      >
        <WizardHeader
          title="Set up Mira"
          identity={
            <div className="flex items-baseline gap-1.5" role="img" aria-label="T3 Code">
              <T3Wordmark className="h-4 w-auto shrink-0" aria-hidden />
              <span className="text-2xl font-medium tracking-tight text-muted-foreground">
                Code
              </span>
            </div>
          }
        >
          <WizardSteps
            steps={ONBOARDING_STAGES}
            currentStep={stageIndex}
            isStepDisabled={(index) => index >= stageIndex}
            onStepChange={(index) => {
              if (index > stageIndex) return;
              setStep(STEP_ORDER[index] ?? "account");
            }}
          />
        </WizardHeader>

        <WizardPanel>
          {step === "account" ? (
            <AccountStep onContinue={() => setStep("connection")} />
          ) : step === "connection" ? (
            <ConnectionStep
              expandPairingInitially={!localAvailable && !hasCloudPublicConfig()}
              selectedIds={selectedIds}
              autoSelectedComputers={autoSelectedComputers}
              onSelectionChange={setSelection}
              onToggleEnvironment={(environmentId, checked) =>
                setSelection((current) => {
                  const next = new Set(current ?? selectedIds);
                  if (checked) next.add(environmentId);
                  else next.delete(environmentId);
                  return next;
                })
              }
              onContinue={() =>
                startSetup(resolveOnboardingSetup(environments, selectedIds).environmentIds)
              }
              onPaired={(environmentId) => {
                setSelection(new Set([...selectedIds, environmentId]));
              }}
            />
          ) : (
            <AgentsStep environmentIds={setupIds} onContinue={() => void finish()} />
          )}
        </WizardPanel>
      </WizardPopup>
    </Dialog>
  );
}

function ConnectionStep({
  autoSelectedComputers,
  expandPairingInitially,
  selectedIds,
  onSelectionChange,
  onToggleEnvironment,
  onContinue,
  onPaired,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly expandPairingInitially: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId>) => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
  readonly onContinue: () => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const cloudEnabled = hasCloudPublicConfig();
  const directEnvironments = environments.filter(
    (environment) => !cloudEnabled || !isOnboardingRelayEnvironment(environment),
  );
  const [pairingOpen, setPairingOpen] = useState(expandPairingInitially);
  const [isPairing, setIsPairing] = useState(false);
  const { ready, skippedIds } = resolveOnboardingSetup(environments, selectedIds);
  const skippedLabels = environments
    .filter((environment) => skippedIds.includes(environment.environmentId))
    .map((environment) => environment.label);
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (
      ready &&
      (document.activeElement === document.body ||
        document.activeElement?.getAttribute("role") === "dialog")
    ) {
      continueRef.current?.focus();
    }
  }, [ready]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Connect your computers
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Choose one or more computers. We’ll set up agents and projects on each.
      </p>
      {directEnvironments.length > 0 ? (
        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Computers to set up</legend>
          {directEnvironments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <Checkbox
                checked={selectedIds.has(environment.environmentId)}
                onCheckedChange={(checked) => {
                  const next = new Set(selectedIds);
                  if (checked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next);
                }}
              />
              <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium break-words">
                    {environment.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {!environment.entry.enabled && environment.connection.phase !== "unsupported"
                      ? "Off"
                      : presentSavedCloudEnvironmentConnection(environment.connection).buttonLabel}
                  </span>
                </span>
                {environment.displayUrl ? (
                  <span className="mt-0.5 block text-xs break-all text-muted-foreground">
                    {environment.displayUrl}
                  </span>
                ) : null}
                {environment.connection.phase === "unsupported" && environment.connection.error ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {environment.connection.error}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="mt-4 space-y-2">
        {cloudEnabled ? (
          <ConnectAccountOption
            autoSelectedComputers={autoSelectedComputers}
            disabled={isPairing}
            selectedIds={selectedIds}
            onToggleEnvironment={onToggleEnvironment}
          />
        ) : null}
        <div className="rounded-lg border border-border bg-background">
          <Collapsible open={pairingOpen} onOpenChange={setPairingOpen}>
            <CollapsibleTrigger
              disabled={isPairing}
              render={
                <Button
                  variant="ghost"
                  size="sm-multiline"
                  className="min-h-14 w-full justify-start"
                />
              }
            >
              <LinkIcon className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">Add a computer</span>
              <ChevronRightIcon
                className={cn("size-4 text-muted-foreground", pairingOpen && "rotate-90")}
              />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="px-3 pb-3">
                <PairingForm
                  isPairing={isPairing}
                  setIsPairing={setIsPairing}
                  onPaired={(environmentId) => {
                    setPairingOpen(false);
                    onPaired(environmentId);
                    requestAnimationFrame(() => continueRef.current?.focus());
                  }}
                />
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      </div>
      {skippedLabels.length > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Not connected, so setup skips {skippedLabels.join(", ")}. You can set{" "}
          {skippedLabels.length === 1 ? "it" : "them"} up later from Settings.
        </p>
      ) : null}
      <div className="mt-6 flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          T3 Code collects anonymous usage data to help us improve it. To read more about how your
          data is used and how to opt out, see our{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            privacy policy
          </a>
          .
        </p>
        <Button
          className="shrink-0 self-end"
          ref={continueRef}
          autoFocus={!expandPairingInitially}
          disabled={!ready || isPairing}
          onClick={onContinue}
        >
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function ConnectAccountOption({
  autoSelectedComputers,
  disabled,
  selectedIds,
  onToggleEnvironment,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly disabled: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const [expanded, setExpanded] = useState(true);
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const onDiscoveryReady = () => setDiscoveryReady(true);

  return (
    <div className="rounded-lg border border-border bg-background">
      <Collapsible open={expanded && !!isSignedIn && discoveryReady} onOpenChange={setExpanded}>
        <CollapsibleTrigger
          disabled={disabled || !isLoaded}
          onClick={(event) => {
            if (!isSignedIn) {
              event.preventDefault();
              setExpanded(true);
              openAuthPrompt();
            }
          }}
          render={
            <Button variant="ghost" size="sm-multiline" className="min-h-14 w-full justify-start" />
          }
        >
          <CloudIcon className="size-4 text-muted-foreground" />
          <span className="flex-1 text-left">Mira account</span>
          <span className="text-xs text-muted-foreground">
            {!isLoaded
              ? "Loading sign-in…"
              : !isSignedIn
                ? "Sign in"
                : !discoveryReady
                  ? "Loading computers…"
                  : null}
          </span>
          <ChevronRightIcon
            className={cn("size-4 text-muted-foreground", expanded && isSignedIn && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted>
          <div className="px-3 pb-3">
            <div className="mb-3 space-y-1.5">
              {isSignedIn ? (
                <CloudEnvironmentConnectRows
                  primaryEnvironmentId={null}
                  savedEnvironments={environments}
                  showSavedEnvironments
                  onDiscoveryReady={onDiscoveryReady}
                  selection={{ selectedIds, onChange: onToggleEnvironment, autoSelectedComputers }}
                  refreshWhileEmpty
                  empty={
                    <p className="py-3 text-sm text-muted-foreground">No computers linked yet.</p>
                  }
                />
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              Run this on each computer you want to connect.
            </p>
            <CommandBlock command="npx t3 connect" className="mt-3" />
            <p className="mt-3 text-xs text-muted-foreground">
              Keep T3 Code running. Select the computers you want to set up above.
            </p>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function PairingForm({
  isPairing,
  setIsPairing,
  onPaired,
}: {
  readonly isPairing: boolean;
  readonly setIsPairing: (value: boolean) => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (isPairing || pairingUrl.trim().length === 0) return;
    setIsPairing(true);
    setErrorMessage("");
    const result = await connectPairingEnvironment({ pairingUrl: pairingUrl.trim() });
    if (!mountedRef.current) return;
    setIsPairing(false);
    if (result._tag === "Success") {
      onPaired(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setErrorMessage(cause instanceof Error ? cause.message : "Pairing failed.");
  };

  return (
    <>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className="block text-sm text-muted-foreground" htmlFor="onboarding-pairing-url">
            Pairing link
          </label>
          <Input
            id="onboarding-pairing-url"
            autoFocus
            aria-invalid={errorMessage.length > 0}
            aria-describedby={errorMessage ? "onboarding-pairing-error" : undefined}
            className="mt-2"
            size="lg"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            nativeInput
            readOnly={isPairing}
            placeholder="https://your-server:5230/pair#token=…"
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>
        {errorMessage ? (
          <Alert id="onboarding-pairing-error" variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        <Collapsible>
          <div className="flex items-center justify-between gap-3">
            <CollapsibleTrigger
              type="button"
              className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
              Need a pairing link?
            </CollapsibleTrigger>
            <Button type="submit" disabled={isPairing || pairingUrl.trim().length === 0}>
              {isPairing ? "Pairing..." : "Pair"}
            </Button>
          </div>
          <CollapsiblePanel>
            <p className="pt-3 text-sm text-muted-foreground">
              Run this on the computer with your code.
            </p>
            <CommandBlock command="npx t3 pair" className="mt-2" />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Start T3 Code first, or run <code className="font-mono">npx t3 serve</code>. Add{" "}
              <code className="font-mono">--tailscale</code> to use your tailnet.
            </p>
          </CollapsiblePanel>
        </Collapsible>
      </form>
    </>
  );
}

function AccountStep({ onContinue }: { readonly onContinue: () => void }) {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const cloudEnabled = hasCloudPublicConfig();
  const [account, setAccount] = useState<SaasAccountResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    fetchMiraAccount().then(
      (next) => {
        if (cancelled) return;
        setAccount(next);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  return (
    <StepShell
      title="Sign in to Mira"
      description="Your Mira account includes the coding model, your plan's monthly usage, and access to your computers from anywhere."
    >
      {!cloudEnabled ? (
        <Alert className="mt-5" variant="warning">
          <AlertDescription>
            This build has no Mira account service configured. Set it up before shipping.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="mt-5 flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-4">
          <CloudIcon className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              {account?.email ?? (isSignedIn ? "Signed in" : "Mira account")}
            </span>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {error ??
                (account
                  ? `${account.plan.name} plan · ${formatMiraTokens(account.plan.monthlyTokenLimit)} tokens a month`
                  : isSignedIn
                    ? "Loading your plan…"
                    : "Free to create. Paid plans add more usage.")}
            </p>
          </div>
          {isSignedIn ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
              <CheckIcon className="size-3.5" />
              Signed in
            </span>
          ) : (
            <Button size="sm" disabled={!isLoaded} onClick={openAuthPrompt}>
              {isLoaded ? "Sign in or create account" : "Loading sign-in…"}
            </Button>
          )}
        </div>
      )}
      <div className="mt-6 flex justify-end">
        <Button autoFocus disabled={cloudEnabled && !isSignedIn} onClick={onContinue}>
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

function AgentsStep({
  environmentIds,
  onContinue,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly onContinue: () => void;
}) {
  const { environments } = useEnvironments();
  return (
    <StepShell
      title="Connect the Mira model"
      description="Pi comes with T3 Code. Each computer runs it on your Mira account's model."
    >
      <div className="mt-5 space-y-1.5">
        {environmentIds.map((environmentId) => (
          <MiraModelCard
            key={environmentId}
            environmentId={environmentId}
            machineLabel={
              environments.find((environment) => environment.environmentId === environmentId)
                ?.label ?? "Computer"
            }
          />
        ))}
      </div>
      <div className="mt-6 flex justify-end">
        <Button autoFocus onClick={onContinue}>
          Finish
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

function MiraModelCard({
  environmentId,
  machineLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
}) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [phase, setPhase] = useState<"connecting" | "failed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const connected = serverConfig !== null && hasMiraEnvironment(serverConfig.settings);
  const attemptedRef = useRef(false);

  const connect = async () => {
    if (serverConfig === null) return;
    setPhase("connecting");
    setError(null);
    const result = await settlePromise(async () => {
      const key = await issueMiraModelKey();
      const persisted = await persistProviderInstance({
        operation: "upsert",
        instanceId: MIRA_PI_INSTANCE_ID,
        instance: miraPiInstance(serverConfig.settings, key),
      });
      if (persisted._tag === "Failure") throw squashAtomCommandFailure(persisted);
    });
    if (result._tag === "Failure") {
      setPhase("failed");
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not connect the model.");
    }
  };

  useEffect(() => {
    if (connected || serverConfig === null || attemptedRef.current) return;
    attemptedRef.current = true;
    void connect();
  });

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-4">
      <ProviderInstanceIcon
        driverKind={ProviderDriverKind.make("pi")}
        displayName="Mira"
        iconClassName="size-5"
      />
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{machineLabel}</span>
        <p className="mt-0.5 text-xs leading-relaxed break-words text-muted-foreground">
          {connected
            ? "Ready to code with Mira."
            : phase === "failed"
              ? error
              : serverConfig === null
                ? "Waiting for this computer…"
                : "Connecting the Mira model…"}
        </p>
      </div>
      <div className="shrink-0">
        {connected ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : phase === "failed" ? (
          <Button size="xs" variant="ghost" onClick={() => void connect()}>
            Retry
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Connecting…</span>
        )}
      </div>
    </div>
  );
}

function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}
