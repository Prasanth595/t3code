import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { UsageRouteScreen } from "../usage/UsageRouteScreen";
import { ChatHome } from "../chat/ChatHome";

export function WorkspaceExtraTab(props: {
  tab: Exclude<NavigationTab, "threads" | "pullRequests">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "chats" ? <ChatHome /> : <UsageRouteScreen workspace />}
    </>
  );
}
