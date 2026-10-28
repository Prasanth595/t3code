import { createRealtimeVoiceEnvironmentAtoms } from "@t3tools/client-runtime/state/realtime-voice";

import { connectionAtomRuntime } from "../connection/runtime";

export const realtimeVoiceEnvironment = createRealtimeVoiceEnvironmentAtoms(connectionAtomRuntime);
