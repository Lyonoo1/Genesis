"use client";

import React, { useState, useEffect } from "react";
import {
  X,
  MessageSquare,
  Folder,
  Pin,
  Archive,
  Trash2,
  Clock,
  Layers,
} from "lucide-react";
import { Session, Project } from "@/types";
import { useSessionStore } from "@/stores/useSessionStore";
import { getProjectIconComponent } from "./EditProjectModal";

interface EditSessionModalProps {
  session: Session | null;
  isOpen: boolean;
  onClose: () => void;
}

function formatToBeijingTime(dateStr?: string): string {
  if (!dateStr) return "-";
  try {
    const d = new Date(dateStr);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return dateStr;
  }
}

export function EditSessionModal({
  session,
  isOpen,
  onClose,
}: EditSessionModalProps) {
  const { projects, updateSessionDetails, deleteSession } = useSessionStore();

  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [pinned, setPinned] = useState(false);
  const [isArchived, setIsArchived] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session) {
      setTitle(session.title || "");
      setProjectId(session.project_id || "");
      setPinned(!!session.pinned);
      setIsArchived(!!session.is_archived);
    }
  }, [session]);

  if (!isOpen || !session) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      await updateSessionDetails(session.id, {
        title: trimmed,
        project_id: projectId || null,
        pinned,
        is_archived: isArchived,
      });
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (window.confirm(`确认删除会话 "${session.title}" 吗？此操作无法撤销。`)) {
      await deleteSession(session.id);
      onClose();
    }
  };

  // 过滤出未归档的项目供选择
  const availableProjects = (projects || []).filter((p) => p && !p.is_archived);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-md bg-[#212124] border border-[#38383E] rounded-2xl shadow-2xl overflow-hidden text-[#ECECED] animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="h-12 px-5 border-b border-[#2E2E33] flex items-center justify-between bg-[#262629]">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-[#8E8E93]" />
            <h3 className="text-sm font-medium text-white">修改对话信息</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSave} className="p-5 space-y-4 text-xs">
          {/* 1. 对话标题 */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#A1A1AA]">
              对话标题 <span className="text-accent-coral">*</span>
            </label>
            <input
              type="text"
              required
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="请输入对话标题"
              className="w-full h-9 px-3 rounded-lg bg-[#18181A] border border-[#323238] text-white text-xs outline-none focus:border-white/30 transition-all placeholder-[#71717A]"
            />
          </div>

          {/* 2. 所属项目选择 */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#A1A1AA] flex items-center gap-1.5">
              <Folder className="w-3.5 h-3.5 text-[#8E8E93]" />
              <span>所属项目</span>
            </label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full h-9 px-3 rounded-lg bg-[#18181A] border border-[#323238] text-white text-xs outline-none focus:border-white/30 transition-all cursor-pointer"
            >
              <option value="" className="bg-[#212124] text-[#A1A1AA]">
                无项目（独立会话）
              </option>
              {availableProjects.map((p) => (
                <option key={p.id} value={p.id} className="bg-[#212124] text-white">
                  📁 {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* 3. 置顶与归档切换 */}
          <div className="p-3 rounded-xl bg-[#18181A] border border-[#323238] space-y-3">
            <label className="flex items-center justify-between cursor-pointer select-none">
              <div className="flex items-center gap-2">
                <Pin className="w-3.5 h-3.5 text-[#8E8E93]" />
                <span className="text-[12px] text-[#ECECED]">置顶此会话</span>
              </div>
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                className="w-4 h-4 rounded bg-[#212124] border-[#383842] text-accent-green focus:ring-0 cursor-pointer"
              />
            </label>

            <div className="border-t border-[#26262B]" />

            <label className="flex items-center justify-between cursor-pointer select-none">
              <div className="flex items-center gap-2">
                <Archive className="w-3.5 h-3.5 text-[#8E8E93]" />
                <span className="text-[12px] text-[#ECECED]">归档此会话</span>
              </div>
              <input
                type="checkbox"
                checked={isArchived}
                onChange={(e) => setIsArchived(e.target.checked)}
                className="w-4 h-4 rounded bg-[#212124] border-[#383842] text-accent-green focus:ring-0 cursor-pointer"
              />
            </label>
          </div>

          {/* 4. 时间元信息 (北京时间) */}
          <div className="px-3 py-2 rounded-lg bg-white/[0.02] border border-[#2E2E33] space-y-1 text-[11px] text-[#7E7E82]">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-[#7E7E82]" />
                创建时间（北京时间）:
              </span>
              <span className="text-[#A1A1AA] font-mono">
                {formatToBeijingTime(session.created_at)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-[#7E7E82]" />
                更新时间（北京时间）:
              </span>
              <span className="text-[#A1A1AA] font-mono">
                {formatToBeijingTime(session.updated_at)}
              </span>
            </div>
          </div>

          {/* 底部按钮组 */}
          <div className="pt-3 border-t border-[#2E2E33] flex items-center justify-between">
            <button
              type="button"
              onClick={handleDelete}
              className="px-3 py-1.5 rounded-lg text-accent-coral hover:bg-accent-coral/10 flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>删除会话</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-1.5 rounded-lg hover:bg-white/[0.06] text-[#A1A1AA] hover:text-white transition-colors"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-1.5 rounded-lg bg-white text-black font-medium hover:bg-white/90 transition-colors disabled:opacity-50"
              >
                {loading ? "保存中..." : "保存修改"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
