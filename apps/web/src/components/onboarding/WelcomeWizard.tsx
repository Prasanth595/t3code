import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ProviderDriverKind } from "@t3tools/contracts";
import { ArrowRightIcon, CheckIcon, CloudIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
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
import { serverEnvironment } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { WizardPanel, WizardSteps, WizardPopup, WizardHeader } from "../ui/wizard";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { PRIVACY_POLICY_URL } from "../../legalLinks";

type WizardStep = "account" | "agents";

const ONBOARDING_STAGES = ["Cont", "Model"] as const;
const STEP_ORDER: readonly WizardStep[] = ["account", "agents"];

export function WelcomeWizard({
  onDone,
  resumeEnvironmentId,
}: {
  readonly resumeEnvironmentId?: EnvironmentId | undefined;
  readonly onDone: (projectRef?: ScopedProjectRef) => void | Promise<void>;
}) {
  const [step, setStep] = useState<WizardStep>(resumeEnvironmentId ? "agents" : "account");
  const { environments } = useEnvironments();
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  // Other computers set up their own model when they sign in, so this one is enough here.
  const setupIds: readonly EnvironmentId[] = resumeEnvironmentId
    ? [resumeEnvironmentId]
    : primaryEnvironment
      ? [primaryEnvironment.environmentId]
      : environments.map((environment) => environment.environmentId);
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
          title: "Configurarea nu a putut fi finalizată",
          description: "Setările nu au putut fi salvate. Încearcă din nou.",
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
      <WizardPopup size="wide" bottomStickOnMobile={false}>
        <WizardHeader
          title="Configurează Mira"
          identity={<span className="text-2xl font-semibold tracking-tight">Mira</span>}
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
            <AccountStep onContinue={() => setStep("agents")} />
          ) : (
            <AgentsStep environmentIds={setupIds} onContinue={() => void finish()} />
          )}
        </WizardPanel>
      </WizardPopup>
    </Dialog>
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
      title="Autentifică-te în Mira"
      description="Contul Mira include modelul de programare, utilizarea lunară din plan și accesul la calculatoarele tale de oriunde."
    >
      {!cloudEnabled ? (
        <Alert className="mt-5" variant="warning">
          <AlertDescription>
            Această versiune nu are configurat serviciul de conturi Mira. Configurează-l înainte de
            publicare.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="mt-5 flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-4">
          <CloudIcon className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              {account?.email ?? (isSignedIn ? "Autentificat" : "Cont Mira")}
            </span>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {error ??
                (account
                  ? `Planul ${account.plan.name} · ${formatMiraTokens(account.plan.monthlyTokenLimit)} tokeni pe lună`
                  : isSignedIn
                    ? "Se încarcă planul…"
                    : "Gratuit la creare. Planurile plătite oferă mai multă utilizare.")}
            </p>
          </div>
          {isSignedIn ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
              <CheckIcon className="size-3.5" />
              Autentificat
            </span>
          ) : (
            <Button size="sm" disabled={!isLoaded} onClick={openAuthPrompt}>
              {isLoaded ? "Autentifică-te sau creează cont" : "Se încarcă autentificarea…"}
            </Button>
          )}
        </div>
      )}
      <div className="mt-6 flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          Mira colectează date anonime de utilizare ca s-o putem îmbunătăți. Ca să afli cum sunt
          folosite datele și cum poți renunța, citește{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            politica de confidențialitate
          </a>
          .
        </p>
        <Button
          className="shrink-0 self-end"
          autoFocus
          disabled={cloudEnabled && !isSignedIn}
          onClick={onContinue}
        >
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
      title="Conectează modelul Mira"
      description="Pi vine cu Mira. Fiecare calculator îl rulează cu modelul contului tău Mira."
    >
      <div className="mt-5 space-y-1.5">
        {environmentIds.map((environmentId) => (
          <MiraModelCard
            key={environmentId}
            environmentId={environmentId}
            machineLabel={
              environments.find((environment) => environment.environmentId === environmentId)
                ?.label ?? "Calculator"
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
  const [phase, setPhase] = useState<"waiting" | "connecting" | "failed">("waiting");
  const [error, setError] = useState<string | null>(null);
  const connected = serverConfig !== null && hasMiraEnvironment(serverConfig.settings);

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
    if (result._tag === "Success") {
      setPhase("waiting");
    } else {
      setPhase("failed");
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Modelul nu a putut fi conectat.");
    }
  };

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
            ? "Gata de lucru cu Mira."
            : phase === "failed"
              ? error
              : serverConfig === null
                ? "Se așteaptă acest calculator…"
                : "Se conectează modelul Mira…"}
        </p>
      </div>
      <div className="shrink-0">
        {connected ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            disabled={phase === "connecting" || serverConfig === null}
            onClick={() => void connect()}
          >
            {phase === "failed" ? "Reîncearcă" : "Conectează acum"}
          </Button>
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
