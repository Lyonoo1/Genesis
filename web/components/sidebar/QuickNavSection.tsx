"use client";

import React from "react";
import { useRouter, usePathname } from "next/navigation";
import { SquarePen, AtSign } from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";

export function QuickNavSection() {
  const router = useRouter();
  const pathname = usePathname();
  const { startNewChat, activeSessionId } = useSessionStore();

  const isNewChatActive = pathname === "/chat" && !activeSessionId;

  const handleNewChat = () => {
    startNewChat();
    router.push("/chat");
  };

  return (
    <div className="px-2 py-1 space-y-0.5 select-none flex-shrink-0">
      {/* 1. 新对话 */}
      <button
        type="button"
        onClick={handleNewChat}
        className={`w-full flex items-center justify-between px-2.5 h-8 rounded-lg text-xs font-medium transition-colors ${
          isNewChatActive
            ? "bg-[#373839] text-white shadow-sm"
            : "text-[#ECECED] hover:bg-white/[0.06]"
        }`}
      >
        <div className="flex items-center gap-2.5">
          <SquarePen className="w-3.5 h-3.5 text-[#ECECED]" />
          <span>新对话</span>
        </div>
        <span className="w-4 h-4 rounded-full flex items-center justify-center text-[#8E8E93] hover:text-white transition-colors">
          +
        </span>
      </button>


      {/* 4. @ 插件 */}
      <button
        type="button"
        onClick={() => router.push("/marketplace")}
        className={`w-full flex items-center gap-2.5 px-2.5 h-8 rounded-lg text-xs font-medium transition-colors ${
          pathname.startsWith("/marketplace")
            ? "bg-[#373839] text-white shadow-sm"
            : "text-[#ECECED] hover:bg-white/[0.06]"
        }`}
      >
        <AtSign className="w-3.5 h-3.5 text-[#ECECED]" />
        <span>插件</span>
      </button>
    </div>
  );
}
