import { parseNewThreadLink } from "@t3tools/shared/promptLinks";
import { Navigate, createFileRoute, useLocation } from "@tanstack/react-router";
import { NewThreadLinkView } from "../components/promptLinks/NewThreadLinkView";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";

// The query is read raw: the router's own search parsing turns `prompt=123` into a number.
function NewThreadLinkRoute() {
  const search = useLocation({ select: (location) => location.searchStr });
  // A bare `/new` (also what `t3code://new` opens) asks for a new thread, not a broken link.
  if (new URLSearchParams(search).size === 0) {
    return <Navigate replace to="/" />;
  }
  const parsed = parseNewThreadLink(search);
  if (!parsed.ok) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>Could not open the link</EmptyTitle>
            <EmptyDescription>{parsed.error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }
  return <NewThreadLinkView key={search} link={parsed.value} />;
}

export const Route = createFileRoute("/_chat/new")({
  component: NewThreadLinkRoute,
});
