import AgentActivity, {
  AgentActivityWidget,
  type AgentActivityProps,
} from "../../widgets/AgentActivity";

export function publishAgentActivityWidget(props: AgentActivityProps): boolean {
  try {
    AgentActivityWidget.updateSnapshot(props);
    return true;
  } catch {
    // Personal-team builds have no widget extension.
    return false;
  }
}

export function dismissEndedAgentLiveActivities() {
  AgentActivity.dismissEnded();
}

export function getAgentLiveActivities() {
  return AgentActivity.getInstances();
}

export function startAgentLiveActivity(props: AgentActivityProps, staleDate?: Date) {
  return AgentActivity.start(props, undefined, staleDate);
}
