import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import {
  createModelSelection,
  moveModelSelectionChain,
  toggleModelSelectionChain,
} from "@t3tools/shared/model";

import type { ModelEsque } from "../chat/providerIconUtils";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { resolveModelPickerSelectedModel } from "../chat/ModelPickerContent";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";

export function UsageLimitFallbackChainSetting(props: {
  readonly chain: readonly ModelSelection[];
  readonly mixed: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly instanceEntries: readonly ProviderInstanceEntry[];
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  readonly onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  readonly onChange: (chain: readonly ModelSelection[]) => void;
}) {
  const activeInstanceId =
    props.chain[0]?.instanceId ??
    props.instanceEntries.find((entry) => entry.enabled && entry.isAvailable)?.instanceId ??
    props.instanceEntries[0]?.instanceId;
  const commit = (entry: ModelSelection) => {
    const reason = props.getModelDisabledReason(entry.instanceId, entry.model);
    if (reason) return;
    props.onChange(props.mixed ? [entry] : toggleModelSelectionChain(props.chain, entry));
  };

  return (
    <div className="flex min-w-0 flex-col items-stretch gap-2 sm:items-end">
      {activeInstanceId ? (
        <ProviderModelPicker
          environmentId={props.environmentId}
          activeInstanceId={activeInstanceId}
          model={props.chain[0]?.model ?? ""}
          selectedModels={props.mixed ? [] : props.chain}
          lockedProvider={null}
          instanceEntries={props.instanceEntries}
          modelOptionsByInstance={props.modelOptionsByInstance}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          triggerAriaLabel="Fallback models"
          {...(props.mixed ? { triggerLabel: "Mixed" } : {})}
          getModelDisabledReason={props.getModelDisabledReason}
          {...(props.onOpenProviderSetup ? { onOpenProviderSetup: props.onOpenProviderSetup } : {})}
          onToggleModel={(instanceId, model) => commit(createModelSelection(instanceId, model))}
          onInstanceModelChange={(instanceId, model) =>
            commit(createModelSelection(instanceId, model))
          }
        />
      ) : (
        <span className="text-sm text-muted-foreground">No providers available.</span>
      )}
      {props.mixed ? (
        <p className="max-w-sm text-right text-xs text-muted-foreground">
          Selected environments use different lists. Choosing a model replaces them with that one
          model.
        </p>
      ) : props.chain.length === 0 ? (
        <p className="text-xs text-muted-foreground">None. A limit waits for its reset.</p>
      ) : (
        <ol className="flex w-full max-w-sm flex-col gap-1">
          {props.chain.map((selection, index) => {
            const label = fallbackEntryLabel(
              selection,
              props.instanceEntries,
              props.modelOptionsByInstance,
            );
            return (
              <li
                key={`${selection.instanceId}:${selection.model}`}
                className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1"
              >
                <span className="w-4 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-sm" />}>
                    {label}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{label}</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        disabled={index === 0}
                        aria-label={`Move ${label} earlier`}
                        onClick={() =>
                          props.onChange(moveModelSelectionChain(props.chain, index, -1))
                        }
                      />
                    }
                  >
                    <ArrowUpIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Move earlier</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        disabled={index === props.chain.length - 1}
                        aria-label={`Move ${label} later`}
                        onClick={() =>
                          props.onChange(moveModelSelectionChain(props.chain, index, 1))
                        }
                      />
                    }
                  >
                    <ArrowDownIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Move later</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        aria-label={`Remove ${label}`}
                        onClick={() =>
                          props.onChange(toggleModelSelectionChain(props.chain, selection))
                        }
                      />
                    }
                  >
                    <XIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Remove</TooltipPopup>
                </Tooltip>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function fallbackEntryLabel(
  selection: ModelSelection,
  entries: readonly ProviderInstanceEntry[],
  optionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string {
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = resolveModelPickerSelectedModel({
    driverKind: entry?.driverKind,
    model: selection.model,
    options: optionsByInstance.get(selection.instanceId) ?? [],
  });
  const modelName = model ? getTriggerDisplayModelName(model) : selection.model;
  return `${entry?.displayName ?? selection.instanceId} · ${modelName}`;
}
