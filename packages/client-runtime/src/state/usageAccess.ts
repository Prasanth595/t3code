import {
  AuthDiagnosticsReadScope,
  type AuthSessionState,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

export function resolveUsageAccess(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly session: SessionGrantInput | null;
  readonly hasSessionError: boolean;
}) {
  if (input.hasSessionError) {
    return {
      canReadDiagnostics: false,
      isPending: false,
      error: "Nu am putut verifica accesul conexiunii la diagnosticare și utilizare.",
    };
  }
  if (input.session === null) {
    // An unprepared offline connection cannot finish its session check. Keep
    // it out of pending totals until the connection starts another attempt.
    const isPending =
      input.connectionPhase === "connected" ||
      input.connectionPhase === "connecting" ||
      input.connectionPhase === "reconnecting";
    return {
      canReadDiagnostics: false,
      isPending,
      error: isPending ? null : "Mediul nu e conectat.",
    };
  }
  const canReadDiagnostics = sessionGrantsScope(input.session, AuthDiagnosticsReadScope);
  return {
    canReadDiagnostics,
    isPending: false,
    error: canReadDiagnostics
      ? null
      : "Această conexiune nu are acces la diagnosticare și utilizare.",
  };
}
