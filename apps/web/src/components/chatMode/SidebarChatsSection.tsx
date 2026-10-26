import { Link, useLocation } from "@tanstack/react-router";
import { LockIcon, MessageCirclePlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  hasAgenticAccess,
  miraChatHistory,
  useMiraAccess,
  useMiraChatHistory,
} from "~/cloud/miraChat";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { AgenticUpgradeDialog } from "./AgenticUpgradeDialog";

const COLLAPSED_LIMIT = 8;

/** Chat-mode conversations above the agentic threads. */
export function SidebarChatsSection({ onNavigate }: { readonly onNavigate?: () => void }) {
  const { chats } = useMiraChatHistory();
  const access = useMiraAccess();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const visible = showAll ? chats : chats.slice(0, COLLAPSED_LIMIT);
  return (
    <div className="flex flex-col gap-px pb-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
            Chats
          </CollapsibleSectionHeader>
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="New chat"
          render={<Link to="/ask" onClick={onNavigate} />}
        >
          <MessageCirclePlusIcon />
        </Button>
      </div>
      {expanded ? (
        <SidebarMenu>
          {visible.map((chat) => (
            <SidebarMenuItem key={chat.id} className="group/chat-row">
              <SidebarMenuButton
                isActive={pathname === `/ask/${chat.id}`}
                render={
                  <Link to="/ask/$chatId" params={{ chatId: chat.id }} onClick={onNavigate} />
                }
              >
                <span>{chat.title}</span>
              </SidebarMenuButton>
              <span className="absolute end-1 top-1 opacity-0 group-hover/chat-row:opacity-100 has-focus-visible:opacity-100">
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Delete ${chat.title}`}
                  onClick={() => miraChatHistory.remove(chat.id)}
                >
                  <Trash2Icon />
                </Button>
              </span>
            </SidebarMenuItem>
          ))}
          {chats.length > COLLAPSED_LIMIT ? (
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" onClick={() => setShowAll(!showAll)}>
                <span>{showAll ? "Show fewer" : `Show all ${chats.length}`}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          {!hasAgenticAccess(access) ? (
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setUpgradeOpen(true)}>
                <LockIcon />
                <span>Agentic mode · Pro</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      ) : null}
      <AgenticUpgradeDialog open={upgradeOpen} onOpenChange={setUpgradeOpen} />
    </div>
  );
}
