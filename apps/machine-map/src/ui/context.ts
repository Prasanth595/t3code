import { createContext, useContext } from "react";
import type {
  CommandDelivery,
  MachineCommandInput,
  MachineId,
  MachineMapDocument,
  MapChange,
  MapRevision,
  PortalSnapshot,
} from "@t3tools/contracts/machineMap";

import type { PauseState, PendingRotation } from "../api.ts";
import type { Route, Selection, View } from "./route.ts";

/** One held change of a draft (MM-707). */
export interface DraftChange {
  readonly summary: string;
  readonly changes: ReadonlyArray<MapChange>;
}

export interface CommandOptions {
  readonly delivery: CommandDelivery;
  readonly expiresInMinutes: number;
}

export type Dialog =
  | { readonly _tag: "addMachine" }
  | {
      readonly _tag: "joinCode";
      readonly machineName: string;
      readonly code: string;
      readonly expiresAt: string;
    }
  | { readonly _tag: "newJoinCode"; readonly machineId: MachineId; readonly machineName: string }
  | { readonly _tag: "savePreset" }
  | { readonly _tag: "manageSetting" }
  /** MM-708: the big red button, opened from the command palette. */
  | { readonly _tag: "emergency" }
  | {
      readonly _tag: "confirm";
      readonly title: string;
      readonly body: string;
      readonly confirmLabel: string;
      /** The confirm button look. Dangerous actions are the default. */
      readonly tone?: "danger" | "primary";
      readonly action: () => void;
    };

export interface Portal {
  readonly snapshot: PortalSnapshot;
  /** The live map, with the draft on top while changes are held (MM-707). */
  readonly map: MachineMapDocument;
  /** Revisions newest first: the snapshot history plus older pages that the page loaded. */
  readonly history: ReadonlyArray<MapRevision>;
  readonly rotations: ReadonlyArray<PendingRotation>;
  /** MM-713: null when nothing is paused. */
  readonly pause: PauseState | null;
  readonly draft: ReadonlyArray<DraftChange> | null;
  readonly now: number;
  readonly route: Route;
  /** Applies changes as one revision, or adds them to the draft. */
  submit(summary: string, changes: ReadonlyArray<MapChange>): void;
  /** Sends a command. Dangerous commands ask first (MM-504). */
  command(machineId: MachineId, input: MachineCommandInput, options?: CommandOptions): void;
  /** Runs an API call and shows its error, or `done` on success. */
  call(work: () => Promise<unknown>, done?: string): void;
  select(selection: Selection, view?: View): void;
  open(dialog: Dialog): void;
  loadOlderHistory(): void;
}

export const PortalContext = createContext<Portal | null>(null);

export function usePortalContext(): Portal {
  const portal = useContext(PortalContext);
  if (!portal) throw new Error("usePortalContext needs PortalContext.");
  return portal;
}
