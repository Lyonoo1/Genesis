"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  History,
  Search,
  MessageSquare,
  Archive,
  ArchiveRestore,
  Trash2,
  ExternalLink,
  Edit2,
  Check,
  X,
  Clock,
  Folder,
  AlertTriangle,
} from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";

function formatTimeAgo(dateString?: string): string {
  if (!dateString) return "刚刚";
  try {
    const diff = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(dateString).toLocaleDateString("zh-CN");
  } catch {
    return "刚刚";
  }
}

export function HistoryTab() {
  const router = useRouter();
  const {
    sessions,
    projects,
    setActiveSessionId,
    archiveSession,
    unarchiveSession,
    deleteSession,
    updateSessionDetails,
  } = useSessionStore();

  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "active" | "archived">(
    "all"
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // 过滤会话
  const filteredSessions = useMemo(() => {
    return (sessions || []).filter((s) => {
      if (!s) return false;
      const matchesSearch = s.title
        ?.toLowerCase()
        .includes(search.toLowerCase());

      if (filterMode === "active") {
        return !s.is_archived && matchesSearch;
      }
      if (filterMode === "archived") {
        return Boolean(s.is_archived) && matchesSearch;
      }
      return matchesSearch;
    });
  }, [sessions, search, filterMode]);

  const activeCount = useMemo(
    () => (sessions || []).filter((s) => !s.is_archived).length,
    [sessions]
  );
  const archivedCount = useMemo(
    () => (sessions || []).filter((s) => s.is_archived).length,
    [sessions]
  );

  const handleStartEdit = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingTitle(currentTitle);
  };

  const handleSaveEdit = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (editingTitle.trim()) {
      await updateSessionDetails(id, { title: editingTitle.trim() });
    }
    setEditingId(null);
  };

  const handleEnterSession = (id: string) => {
    setActiveSessionId(id);
    router.push("/chat");
  };

  const handleClearAll = async () => {
    for (const s of sessions) {
      await deleteSession(s.id);
    }
    setShowClearConfirm(false);
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* 标题 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
            <History className="w-6 h-6 text-purple-400" />
            <span>历史会话与已归档</span>
          </h2>
          <p className="text-xs text-[#8E8E93] mt-1.5 leading-relaxed">
            查看、检索与管理所有本地和已同步的会话历史。点击任意会话可立即继续对话。
          </p>
        </div>

        {sessions.length > 0 && (
          <button
            type="button"
            onClick={() => setShowClearConfirm(true)}
            className="self-start sm:self-auto h-7 px-3 rounded-lg text-xs font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>清空所有记录</span>
          </button>
        )}
      </div>

      {/* 搜索与筛选控制栏 */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* 搜索框 */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话标题..."
            className="w-full h-9 pl-9 pr-4 rounded-xl bg-[#18181b]/70 border border-[#27272a] text-xs text-white placeholder-[#71717A] focus:outline-none focus:border-purple-500/50 transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#71717A] hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* 筛选标签胶囊 */}
        <div className="flex items-center gap-1 p-1 bg-[#18181b]/70 border border-[#27272a] rounded-xl self-start sm:self-auto text-xs">
          <button
            type="button"
            onClick={() => setFilterMode("all")}
            className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
              filterMode === "all"
                ? "bg-white/[0.1] text-white font-medium"
                : "text-[#8E8E93] hover:text-white"
            }`}
          >
            全部 ({sessions.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("active")}
            className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
              filterMode === "active"
                ? "bg-white/[0.1] text-white font-medium"
                : "text-[#8E8E93] hover:text-white"
            }`}
          >
            活跃 ({activeCount})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("archived")}
            className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
              filterMode === "archived"
                ? "bg-white/[0.1] text-white font-medium"
                : "text-[#8E8E93] hover:text-white"
            }`}
          >
            已归档 ({archivedCount})
          </button>
        </div>
      </div>

      {/* 会话列表卡片 */}
      <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl overflow-hidden divide-y divide-[#27272a]/60">
        {filteredSessions.length === 0 ? (
          <div className="py-16 text-center text-xs text-[#71717A] space-y-2">
            <MessageSquare className="w-8 h-8 text-[#52525B] mx-auto opacity-50" />
            <p className="font-medium text-[#A1A1AA]">未找到相关会话记录</p>
            <p className="text-[11px] text-[#52525B]">
              {search
                ? "尝试输入其他关键字进行搜索"
                : "在工作区开启新对话后，记录将自动在此展示"}
            </p>
          </div>
        ) : (
          filteredSessions.map((s) => {
            const isEditing = editingId === s.id;
            const project = projects.find((p) => p.id === s.project_id);

            const timeAgo = formatTimeAgo(s.updated_at);

            return (
              <div
                key={s.id}
                onClick={() => !isEditing && handleEnterSession(s.id)}
                className="group px-5 py-3.5 flex items-center justify-between hover:bg-white/[0.02] transition-colors cursor-pointer"
              >
                <div className="min-w-0 flex-1 pr-4">
                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <div
                        className="flex items-center gap-1.5 flex-1 max-w-md"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveEdit(s.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          autoFocus
                          className="h-7 px-2 text-xs rounded-lg bg-[#141416] border border-blue-500 text-white w-full focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={(e) => handleSaveEdit(s.id, e)}
                          className="p-1 rounded hover:bg-white/[0.1] text-emerald-400"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(null);
                          }}
                          className="p-1 rounded hover:bg-white/[0.1] text-[#71717A]"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-xs font-medium text-white truncate group-hover:text-blue-400 transition-colors">
                          {s.title}
                        </span>
                        {s.is_archived && (
                          <span className="px-1.5 py-0.2 text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded shrink-0">
                            已归档
                          </span>
                        )}
                        {project && (
                          <span className="px-1.5 py-0.2 text-[9px] bg-white/[0.06] text-[#A1A1AA] rounded flex items-center gap-1 shrink-0 font-mono">
                            <Folder className="w-2.5 h-2.5" />
                            <span>{project.name}</span>
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-3 text-[11px] text-[#71717A] mt-1 font-mono">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3 text-[#52525B]" />
                      <span>{timeAgo}</span>
                    </span>
                    <span>•</span>
                    <span>ID: {s.id.slice(0, 8)}...</span>
                  </div>
                </div>

                {/* 右侧悬浮操作栏 */}
                <div
                  className="flex items-center gap-1 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => handleEnterSession(s.id)}
                    className="h-7 px-2.5 rounded-lg text-xs font-medium text-white/80 hover:text-white bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.06] flex items-center gap-1 transition-colors cursor-pointer"
                    title="进入该会话"
                  >
                    <span>进入</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>

                  <button
                    type="button"
                    onClick={(e) => handleStartEdit(s.id, s.title, e)}
                    className="p-1.5 rounded-lg text-[#71717A] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
                    title="重命名"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>

                  {s.is_archived ? (
                    <button
                      type="button"
                      onClick={() => unarchiveSession(s.id)}
                      className="p-1.5 rounded-lg text-[#71717A] hover:text-amber-400 hover:bg-amber-400/10 transition-colors cursor-pointer"
                      title="取消归档"
                    >
                      <ArchiveRestore className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => archiveSession(s.id)}
                      className="p-1.5 rounded-lg text-[#71717A] hover:text-amber-400 hover:bg-amber-400/10 transition-colors cursor-pointer"
                      title="归档会话"
                    >
                      <Archive className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {deletingId === s.id ? (
                    <div className="flex items-center gap-1 bg-red-500/20 px-2 py-0.5 rounded-lg border border-red-500/30">
                      <span className="text-[10px] text-red-300">确定删除?</span>
                      <button
                        type="button"
                        onClick={() => {
                          deleteSession(s.id);
                          setDeletingId(null);
                        }}
                        className="text-red-400 hover:text-red-200 font-bold text-xs"
                      >
                        是
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletingId(null)}
                        className="text-[#A1A1AA] hover:text-white text-xs ml-1"
                      >
                        否
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDeletingId(s.id)}
                      className="p-1.5 rounded-lg text-[#71717A] hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                      title="永久删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 清空全部确认弹窗 */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-[420px] max-w-full bg-[#18181b] border border-red-500/40 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-red-400">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h3 className="text-base font-semibold text-white">
                确认清空所有历史会话？
              </h3>
            </div>
            <p className="text-xs text-[#A1A1AA] leading-relaxed">
              此操作将永久删除全部 {sessions.length} 个历史会话记录以及其相关联的对话消息，删除后将无法恢复。
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                className="h-8 px-4 rounded-xl text-xs font-medium text-[#A1A1AA] hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleClearAll}
                className="h-8 px-4 rounded-xl text-xs font-medium bg-red-600 hover:bg-red-500 text-white shadow-sm transition-colors"
              >
                确认彻底清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
