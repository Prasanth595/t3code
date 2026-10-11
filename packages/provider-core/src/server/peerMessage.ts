import type { OrchestrationV2SwarmPeerDelivery } from "@t3tools/contracts";

export function formatPeerMessage(
  text: string,
  delivery: OrchestrationV2SwarmPeerDelivery | undefined,
): string {
  if (delivery === undefined) return text;
  return `[Peer conversation content; swarm=${delivery.swarmId}; sender-thread=${delivery.senderThreadId}]\n${text}`;
}
