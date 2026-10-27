"use client";

import React, { useState } from "react";
import { ShieldAlert, Check, X, Loader2, Terminal } from "lucide-react";
import { useChatStore } from "@/stores/useChatStore";

interface PermissionApprovalBannerProps {
  sessionId?: string | null;
}

export function PermissionApprovalBanner({ sessionId }: PermissionApprovalBannerProps) {
  const { pendingPermission, respondPermission } = useChatStore();
  const [submitting, setSubmitting] = useState(false);

  if (!pendingPermission || (sessionId && pendingPermission.sessionId !== sessionId)) {
    return null;
  }

  const handleAction = async (approved: boolean) => {
    setSubmitting(true);
    try {
      await respondPermission(approved);
    } finally {
      setSubmitting(false);
    }
  };

  const argsFormatted =
    typeof pendingPermission.arguments === "object"
      ? JSON.stringify(pendingPermission.arguments, null, 2)
      : String(pendingPermission.arguments);

  return (
    <div className="w-full max-w-3xl mx-auto my-0 px-4 py-3 rounded-xl border border-amber-500/30 bg-[#1A1813]/95 backdrop-blur-md shadow-2xl shadow-black/80 text-xs animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-start justify-between gap-3">
        {/* 左侧：图标与说明 */}
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-400 shrink-0 mt-0.5 border border-amber-500/20">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div className="space-y-1 min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-amber-200 text-sm">
                安全权限审批
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/25">
                高危操作
              </span>
            </div>
            <p className="text-[#A0A0A5] leading-relaxed">
              {pendingPermission.reason || "智能体请求调用写权限或执行系统命令，需人工确认。"}
            </p>
            <div className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-[#D0D0D5]">
              <Terminal className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
              <span className="text-codex-muted">目标工具:</span>
              <span className="text-amber-300 font-medium px-1 rounded bg-black/40 border border-white/5">
                {pendingPermission.toolName}
              </span>
            </div>

            {/* 参数预览 */}
            {argsFormatted && argsFormatted !== "{}" && (
              <pre className="mt-2 p-2 rounded-lg bg-black/50 border border-white/10 text-[11px] font-mono text-[#E4E4E7] overflow-x-auto max-h-24 scrollbar-thin">
                <code>{argsFormatted}</code>
              </pre>
            )}
          </div>
        </div>

        {/* 右侧：决策按钮组 */}
        <div className="flex items-center gap-2 shrink-0 self-start pt-0.5">
          <button
            onClick={() => handleAction(false)}
            disabled={submitting}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-950/20 text-red-300 hover:bg-red-900/40 hover:text-red-200 transition-all font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <X className="w-3.5 h-3.5" />
            )}
            <span>拒绝</span>
          </button>
          <button
            onClick={() => handleAction(true)}
            disabled={submitting}
            className="flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            <span>允许执行</span>
          </button>
        </div>
      </div>
    </div>
  );
}
