"use client";

import React, { useState, useMemo } from "react";
import {
  Check,
  Undo2,
  Loader2,
  GitCompare,
  CheckCircle2,
  RotateCcw,
  Clock,
  Sparkles,
  AlertCircle,
} from "lucide-react";
import {
  DiffFileItem,
  useWorkbenchStore,
} from "@/stores/useWorkbenchStore";

export interface DiffReviewBarProps {
  /** 单文件审查模式 */
  file?: DiffFileItem | null;
  /** 批量审查模式（也可配合 file 同时提供用于批量按钮） */
  files?: DiffFileItem[];
  sessionId?: string | null;
  compact?: boolean;
  showBatchActions?: boolean;
  className?: string;
  onStatusChanged?: (
    action: "accepted" | "rejected",
    paths: string[]
  ) => void;
}

function getReviewStatusBadge(status?: "pending" | "accepted" | "rejected") {
  switch (status) {
    case "accepted":
      return {
        label: "Accepted",
        zhLabel: "已接受",
        cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
        icon: CheckCircle2,
      };
    case "rejected":
      return {
        label: "Rejected",
        zhLabel: "已回滚",
        cls: "bg-rose-500/15 text-rose-300 border-rose-500/30",
        icon: RotateCcw,
      };
    default:
      return {
        label: "Pending Review",
        zhLabel: "待审查",
        cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
        icon: Clock,
      };
  }
}

const EMPTY_DIFF_FILES: DiffFileItem[] = [];

export function DiffReviewBar({
  file,
  files,
  sessionId,
  compact = false,
  showBatchActions = false,
  className = "",
  onStatusChanged,
}: DiffReviewBarProps) {
  const activeWorkbenchSid = useWorkbenchStore((s) => s.activeSessionId);
  const effectiveSessionId = sessionId || activeWorkbenchSid || "default";

  // 从 Store 严格按目标会话读取最新的 Diff 状态与 patch_id，杜绝跨会话串台
  const storeDiffFiles = useWorkbenchStore((s) => {
    const sid = sessionId || s.activeSessionId;
    if (!sid) return s.allDiffFiles || EMPTY_DIFF_FILES;
    const sessionData = s.workbenchBySession[sid];
    if (sessionData) return sessionData.allDiffFiles || EMPTY_DIFF_FILES;
    return sid === s.activeSessionId ? s.allDiffFiles || EMPTY_DIFF_FILES : EMPTY_DIFF_FILES;
  });
  const acceptDiffPatch = useWorkbenchStore((s) => s.acceptDiffPatch);
  const revertDiffPatch = useWorkbenchStore((s) => s.revertDiffPatch);

  const [busyAction, setBusyAction] = useState<
    "accept" | "reject" | "accept_all" | "reject_all" | null
  >(null);
  const [notice, setNotice] = useState<{
    type: "accepted" | "reverted" | "error";
    text: string;
  } | null>(null);

  // 合并 store 最新状态
  const mergeWithStore = (item: DiffFileItem): DiffFileItem => {
    const matched = storeDiffFiles.find(
      (sf) =>
        sf.path === item.path ||
        (item.patchId && (sf.patchId === item.patchId || sf.patch_id === item.patchId))
    );
    if (!matched) return item;
    return {
      ...item,
      patchId: matched.patchId || matched.patch_id || item.patchId || item.patch_id,
      patch_id: matched.patch_id || matched.patchId || item.patch_id || item.patchId,
      status: matched.status || item.status || "pending",
    };
  };

  const resolvedFile = useMemo(
    () => (file ? mergeWithStore(file) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file, storeDiffFiles]
  );

  const resolvedFiles = useMemo(() => {
    const source = files && files.length > 0 ? files : file ? [file] : [];
    return source.map(mergeWithStore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, file, storeDiffFiles]);

  const isSingleMode = Boolean(resolvedFile);

  const aggregateStatus: "pending" | "accepted" | "rejected" = useMemo(() => {
    if (isSingleMode && resolvedFile) {
      return resolvedFile.status || "pending";
    }
    if (resolvedFiles.length === 0) return "pending";
    if (resolvedFiles.every((f) => f.status === "accepted")) return "accepted";
    if (resolvedFiles.every((f) => f.status === "rejected")) return "rejected";
    return "pending";
  }, [isSingleMode, resolvedFile, resolvedFiles]);

  if (!resolvedFile && resolvedFiles.length === 0) {
    return null;
  }

  const targetFiles = isSingleMode && resolvedFile ? [resolvedFile] : resolvedFiles;

  const totalAdditions = targetFiles.reduce((acc, f) => acc + (f.additions || 0), 0);
  const totalDeletions = targetFiles.reduce((acc, f) => acc + (f.deletions || 0), 0);

  const statusMeta = getReviewStatusBadge(aggregateStatus);
  const StatusIcon = statusMeta.icon;

  const pendingBatchFiles = resolvedFiles.filter(
    (f) => (f.status || "pending") === "pending"
  );

  const patchId = resolvedFile?.patchId || resolvedFile?.patch_id;
  const shortPatchId = patchId
    ? patchId.length > 18
      ? `${patchId.slice(0, 10)}…${patchId.slice(-4)}`
      : patchId
    : null;

  const flashNotice = (type: "accepted" | "reverted" | "error", text: string) => {
    setNotice({ type, text });
    setTimeout(() => {
      setNotice((prev) => (prev?.text === text ? null : prev));
    }, 5000);
  };

  const handleAcceptSingle = async () => {
    if (!resolvedFile || busyAction) return;
    setBusyAction("accept");
    try {
      const ok = await acceptDiffPatch(
        {
          patch_id: resolvedFile.patchId || resolvedFile.patch_id,
          path: resolvedFile.path,
          file: resolvedFile,
        },
        effectiveSessionId
      );
      if (ok) {
        flashNotice("accepted", `已确认接受 ${resolvedFile.name || resolvedFile.path}`);
        onStatusChanged?.("accepted", [resolvedFile.path]);
      } else {
        flashNotice("error", "接受补丁失败，请重试");
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleRejectSingle = async () => {
    if (!resolvedFile || busyAction) return;
    setBusyAction("reject");
    try {
      const res = await revertDiffPatch(
        {
          patch_id: resolvedFile.patchId || resolvedFile.patch_id,
          path: resolvedFile.path,
          session_id: effectiveSessionId,
          originalContent: resolvedFile.originalContent,
          file: resolvedFile,
        },
        effectiveSessionId
      );
      if (res.success) {
        flashNotice("reverted", "已回滚并同步至 Agent 工作记忆");
        onStatusChanged?.("rejected", [resolvedFile.path]);
      } else {
        flashNotice("error", res.message || "回滚补丁失败");
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleAcceptBatch = async () => {
    const targets = pendingBatchFiles.length > 0 ? pendingBatchFiles : resolvedFiles;
    if (targets.length === 0 || busyAction) return;
    setBusyAction("accept_all");
    try {
      const succeeded: string[] = [];
      for (const f of targets) {
        const ok = await acceptDiffPatch(
          {
            patch_id: f.patchId || f.patch_id,
            path: f.path,
            file: f,
          },
          effectiveSessionId
        );
        if (ok) succeeded.push(f.path);
      }
      if (succeeded.length > 0) {
        flashNotice("accepted", `已批量确认接受 ${succeeded.length} 个文件补丁`);
        onStatusChanged?.("accepted", succeeded);
      } else {
        flashNotice("error", "批量接受补丁失败");
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleRejectBatch = async () => {
    const targets = resolvedFiles.filter((f) => f.status !== "rejected");
    if (targets.length === 0 || busyAction) return;
    setBusyAction("reject_all");
    try {
      const reverted: string[] = [];
      for (const f of targets) {
        const res = await revertDiffPatch(
          {
            patch_id: f.patchId || f.patch_id,
            path: f.path,
            session_id: effectiveSessionId,
            originalContent: f.originalContent,
            file: f,
          },
          effectiveSessionId
        );
        if (res.success) reverted.push(f.path);
      }
      if (reverted.length > 0) {
        flashNotice(
          "reverted",
          `已回滚 ${reverted.length} 个文件并同步至 Agent 工作记忆`
        );
        onStatusChanged?.("rejected", reverted);
      } else {
        flashNotice("error", "批量回滚失败");
      }
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      className={`w-full bg-[#1B1B1F] border-b border-white/[0.08] text-xs select-none ${
        compact ? "px-2.5 py-1.5" : "px-3 py-2"
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {/* 左侧：状态徽章 + 文件/批次统计 + patch_id */}
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0 ${statusMeta.cls}`}
            title={statusMeta.label}
          >
            <StatusIcon className="w-3 h-3 shrink-0" />
            <span>{statusMeta.label}</span>
          </span>

          {isSingleMode && resolvedFile ? (
            <span
              className="font-mono text-[11px] text-zinc-200 truncate max-w-[200px]"
              title={resolvedFile.path}
            >
              {resolvedFile.name || resolvedFile.path}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] text-zinc-300 font-medium">
              <GitCompare className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>{resolvedFiles.length} 个变更文件</span>
            </span>
          )}

          {/* 增删统计 */}
          <div className="flex items-center gap-1 font-mono text-[11px] shrink-0">
            <span className="text-emerald-400 font-semibold">
              +{totalAdditions}
            </span>
            <span className="text-rose-400 font-semibold">
              -{totalDeletions}
            </span>
          </div>

          {/* patch_id 短码 */}
          {shortPatchId && (
            <span
              className="px-1.5 py-0.5 rounded bg-black/40 border border-white/[0.06] font-mono text-[10px] text-zinc-400 shrink-0"
              title={`Patch ID: ${patchId}`}
            >
              {shortPatchId}
            </span>
          )}
        </div>

        {/* 右侧：Accept / Reject & Revert 操作按钮组 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isSingleMode ? (
            <>
              <button
                type="button"
                onClick={handleRejectSingle}
                disabled={busyAction !== null || aggregateStatus === "rejected"}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  aggregateStatus === "rejected"
                    ? "bg-rose-500/10 border-rose-500/20 text-rose-300/70"
                    : "bg-rose-500/15 hover:bg-rose-500/25 border-rose-500/30 text-rose-200"
                }`}
                title="回滚磁盘文件并将变更拒收记录同步至 Agent 工作记忆"
              >
                {busyAction === "reject" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Undo2 className="w-3 h-3" />
                )}
                <span>
                  {aggregateStatus === "rejected" ? "已回滚" : "Reject & Revert"}
                </span>
              </button>

              <button
                type="button"
                onClick={handleAcceptSingle}
                disabled={
                  busyAction !== null ||
                  aggregateStatus === "accepted" ||
                  aggregateStatus === "rejected"
                }
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  aggregateStatus === "accepted"
                    ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                    : "bg-emerald-600 hover:bg-emerald-500 border-emerald-500/40 text-white shadow-sm"
                }`}
                title="接受并锁定该文件快照补丁"
              >
                {busyAction === "accept" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                <span>{aggregateStatus === "accepted" ? "Accepted" : "Accept"}</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleRejectBatch}
                disabled={busyAction !== null || aggregateStatus === "rejected"}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border bg-rose-500/15 hover:bg-rose-500/25 border-rose-500/30 text-rose-200 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="回滚全部文件并同步至 Agent 工作记忆"
              >
                {busyAction === "reject_all" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Undo2 className="w-3 h-3" />
                )}
                <span>Reject & Revert</span>
              </button>

              <button
                type="button"
                onClick={handleAcceptBatch}
                disabled={
                  busyAction !== null ||
                  aggregateStatus === "accepted" ||
                  aggregateStatus === "rejected"
                }
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border bg-emerald-600 hover:bg-emerald-500 border-emerald-500/40 text-white shadow-sm transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="批量接受全部待审查补丁"
              >
                {busyAction === "accept_all" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                <span>Accept</span>
              </button>
            </>
          )}

          {/* 单文件视图下，若存在多个待审查文件，额外提供批量按钮 */}
          {showBatchActions && isSingleMode && resolvedFiles.length > 1 && pendingBatchFiles.length > 1 && (
            <button
              type="button"
              onClick={handleAcceptBatch}
              disabled={busyAction !== null}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-zinc-200 transition-colors cursor-pointer disabled:opacity-50"
              title={`一键接受其余全部 ${pendingBatchFiles.length} 个待审查补丁`}
            >
              {busyAction === "accept_all" ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              )}
              <span>全部接受 ({pendingBatchFiles.length})</span>
            </button>
          )}
        </div>
      </div>

      {/* 回滚/工作记忆同步实时提示条 */}
      {(notice || aggregateStatus === "rejected") && (
        <div
          className={`mt-1.5 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border ${
            notice?.type === "error"
              ? "bg-rose-950/40 border-rose-500/30 text-rose-200"
              : notice?.type === "accepted"
              ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-200"
              : "bg-amber-950/35 border-amber-500/30 text-amber-200"
          }`}
        >
          {notice?.type === "error" ? (
            <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
          ) : notice?.type === "accepted" ? (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
          ) : (
            <Sparkles className="w-3.5 h-3.5 shrink-0 text-amber-400" />
          )}
          <span>
            {notice?.text || "已回滚并同步至 Agent 工作记忆"}
          </span>
        </div>
      )}
    </div>
  );
}
