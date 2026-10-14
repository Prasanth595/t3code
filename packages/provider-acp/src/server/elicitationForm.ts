import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";

import { unknownRecord } from "./clientPolicy.ts";

type Field =
  | { readonly kind: "text" }
  | { readonly kind: "number"; readonly integer: boolean }
  | { readonly kind: "boolean" }
  | { readonly kind: "choice"; readonly values: ReadonlySet<string>; readonly multiple: boolean };

type Option = OrchestrationV2UserInputQuestion["options"][number];

export interface ElicitationForm {
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  /**
   * Types answers as the schema declares them. Unknown keys and options are
   * dropped, as is an answer that does not fit its field. Returns undefined
   * when a required field is left without a valid answer.
   */
  readonly content: (
    answers: ProviderUserInputAnswers,
  ) => Record<string, EffectAcpSchema.ElicitationContentValue> | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** `enum` values label themselves. `oneOf` entries carry a title for their `const`. */
function enumOptions(property: Readonly<Record<string, unknown>>): Option[] | undefined {
  const entries = Array.isArray(property.oneOf)
    ? property.oneOf.map((entry) => {
        const option = unknownRecord(entry);
        const label = text(option?.title) ?? text(option?.const);
        return typeof option?.const === "string" && label !== undefined
          ? { label, description: text(option.description) ?? label, value: option.const }
          : undefined;
      })
    : Array.isArray(property.enum)
      ? property.enum.map((value) => {
          const label = text(value);
          return typeof value === "string" && label !== undefined
            ? { label, description: label, value }
            : undefined;
        })
      : undefined;
  if (entries === undefined || entries.length === 0) return undefined;
  return entries.every((entry) => entry !== undefined) ? entries : undefined;
}

function parseField(
  property: Readonly<Record<string, unknown>>,
): { readonly field: Field; readonly options: Option[] } | undefined {
  switch (property.type) {
    case "string": {
      // ACP treats a null `enum` or `oneOf` like an omitted one.
      if ((property.enum ?? property.oneOf ?? undefined) === undefined) {
        return { field: { kind: "text" }, options: [] };
      }
      const options = enumOptions(property);
      return options === undefined
        ? undefined
        : {
            field: { kind: "choice", values: new Set(options.map(optionValue)), multiple: false },
            options,
          };
    }
    case "array": {
      const items = unknownRecord(property.items);
      const options = items?.type === "string" ? enumOptions(items) : undefined;
      return options === undefined
        ? undefined
        : {
            field: { kind: "choice", values: new Set(options.map(optionValue)), multiple: true },
            options,
          };
    }
    case "boolean":
      return {
        field: { kind: "boolean" },
        options: [
          { label: "true", description: "Yes", value: "true" },
          { label: "false", description: "No", value: "false" },
        ],
      };
    case "number":
    case "integer":
      return { field: { kind: "number", integer: property.type === "integer" }, options: [] };
    default:
      return undefined;
  }
}

function optionValue(option: Option): string {
  return option.value ?? option.label;
}

function typedAnswer(
  field: Field,
  answer: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  switch (field.kind) {
    case "text":
      return typeof answer === "string" ? answer : undefined;
    case "boolean":
      if (typeof answer === "boolean") return answer;
      return answer === "true" ? true : answer === "false" ? false : undefined;
    case "number": {
      const parsed =
        typeof answer === "number"
          ? answer
          : typeof answer === "string" && answer.trim().length > 0
            ? Number(answer.trim())
            : Number.NaN;
      if (!Number.isFinite(parsed)) return undefined;
      return field.integer && !Number.isInteger(parsed) ? undefined : parsed;
    }
    case "choice": {
      if (!field.multiple) {
        return typeof answer === "string" && field.values.has(answer) ? answer : undefined;
      }
      const selected = (Array.isArray(answer) ? answer : [answer]).filter(
        (entry): entry is string => typeof entry === "string" && field.values.has(entry),
      );
      return selected.length > 0 ? [...new Set(selected)] : undefined;
    }
  }
}

/**
 * Reads an ACP form elicitation's `requestedSchema` as one question per
 * property. Fixed choices (string enums, titled `oneOf`, string-enum arrays,
 * booleans) allow no custom answer. Returns undefined when a property has a
 * shape T3 cannot ask for, so the caller declines without asking.
 */
export function parseElicitationForm(
  requestedSchema: unknown,
  message: string,
): ElicitationForm | undefined {
  const schema = unknownRecord(requestedSchema);
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const fields = new Map<string, Field>();
  const questions: OrchestrationV2UserInputQuestion[] = [];
  for (const [id, value] of Object.entries(unknownRecord(schema?.properties) ?? {})) {
    const property = unknownRecord(value);
    const parsed = property === undefined ? undefined : parseField(property);
    // Question ids must survive the contract's trim to round-trip answers.
    if (property === undefined || parsed === undefined || text(id) !== id) return undefined;
    fields.set(id, parsed.field);
    questions.push({
      id,
      header: text(property.title) ?? `Question ${questions.length + 1}`,
      question: text(property.description) ?? message,
      options: parsed.options,
      ...(parsed.field.kind === "choice" || parsed.field.kind === "boolean"
        ? { allowCustomAnswer: false }
        : {}),
      ...(parsed.field.kind === "choice" && parsed.field.multiple ? { multiSelect: true } : {}),
    });
  }
  return {
    questions,
    content: (answers) => {
      const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
      for (const [id, field] of fields) {
        const typed = Object.hasOwn(answers, id) ? typedAnswer(field, answers[id]) : undefined;
        if (typed !== undefined) content[id] = typed;
        else if (required.has(id)) return undefined;
      }
      return content;
    },
  };
}
