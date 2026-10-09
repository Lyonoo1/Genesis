"use client";

import React, { useState, useEffect } from "react";
import {
  X,
  Folder,
  Code,
  Terminal,
  Zap,
  Rocket,
  Brain,
  Box,
  Wrench,
  Globe,
  Target,
  Book,
  Bot,
  MessageSquare,
  Trash2,
  Plus,
  HardDrive,
} from "lucide-react";
import { Project } from "@/types";
import { useSessionStore } from "@/stores/useSessionStore";
import {
  saveDirectoryHandle,
  getDirectoryHandle,
} from "@/lib/workspace/localWorkspaceManager";

const PRESET_ICONS = [
  { id: "folder", label: "文件夹", Icon: Folder },
  { id: "code", label: "代码", Icon: Code },
  { id: "terminal", label: "终端", Icon: Terminal },
  { id: "zap", label: "闪电", Icon: Zap },
  { id: "rocket", label: "火箭", Icon: Rocket },
  { id: "brain", label: "智脑", Icon: Brain },
  { id: "box", label: "模块", Icon: Box },
  { id: "wrench", label: "工具", Icon: Wrench },
  { id: "globe", label: "网络", Icon: Globe },
  { id: "target", label: "目标", Icon: Target },
  { id: "book", label: "文档", Icon: Book },
  { id: "bot", label: "智能体", Icon: Bot },
  { id: "message", label: "会话", Icon: MessageSquare },
];

export function getProjectIconComponent(iconName?: string) {
  const match = PRESET_ICONS.find((item) => item.id === iconName);
  return match ? match.Icon : Folder;
}

interface EditProjectModalProps {
  project?: Project | null;
  isOpen: boolean;
  onClose: () => void;
  mode?: "create" | "edit";
}

export function EditProjectModal({
  project,
  isOpen,
  onClose,
  mode = project ? "edit" : "create",
}: EditProjectModalProps) {
  const { addProject, updateProject, deleteProject, sessions } = useSessionStore();

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("folder");
  const [description, setDescription] = useState("");
  const [isArchived, setIsArchived] = useState(false);
  const [loading, setLoading] = useState(false);

  const [selectedFolderHandle, setSelectedFolderHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [selectedFolderName, setSelectedFolderName] = useState<string>("");

  const isCreate = mode === "create" || !project;

  useEffect(() => {
    if (isOpen) {
      if (project && !isCreate) {
        setName(project.name || "");
        setIcon(project.icon || "folder");
        setDescription(project.description || "");
        setIsArchived(!!project.is_archived);
        getDirectoryHandle(project.id).then((handle) => {
          if (handle) {
            setSelectedFolderHandle(handle);
            setSelectedFolderName(handle.name);
          } else {
            setSelectedFolderHandle(null);
            setSelectedFolderName("");
          }
        });
      } else {
        setName("");
        setIcon("folder");
        setDescription("");
        setIsArchived(false);
        setSelectedFolderHandle(null);
        setSelectedFolderName("");
      }
    }
  }, [isOpen, project, isCreate]);

  if (!isOpen) return null;

  const projectSessions = project
    ? (sessions || []).filter((s) => s && s.project_id === project.id)
    : [];

  const handlePickFolder = async () => {
    if (typeof window === "undefined" || !("showDirectoryPicker" in window)) {
      alert("当前浏览器不支持访问本地文件夹，请使用 Chrome/Edge/Arc。");
      return;
    }
    try {
      const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({
        mode: "readwrite",
      });
      if (handle) {
        setSelectedFolderHandle(handle);
        setSelectedFolderName(handle.name);
        if (!name.trim()) {
          setName(handle.name);
        }
      }
    } catch (e: any) {
      // ignore abort
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      if (isCreate) {
        const newProj = addProject(trimmed, description.trim() || undefined, icon);
        if (selectedFolderHandle && newProj?.id) {
          await saveDirectoryHandle(newProj.id, selectedFolderHandle);
        }
      } else if (project) {
        await updateProject(project.id, {
          name: trimmed,
          icon,
          description: description.trim() || undefined,
          is_archived: isArchived,
        });
        if (selectedFolderHandle) {
          await saveDirectoryHandle(project.id, selectedFolderHandle);
        }
      }
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = () => {
    if (!project) return;
    if (window.confirm(`确认删除项目 "${project.name}" 吗？该操作不会删除项目下的会话。`)) {
      deleteProject(project.id);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-md bg-[#212124] border border-[#38383E] rounded-2xl shadow-2xl overflow-hidden text-[#ECECED] animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="h-12 px-5 border-b border-[#2E2E33] flex items-center justify-between bg-[#262629]">
          <div className="flex items-center gap-2">
            {isCreate ? (
              <Plus className="w-4 h-4 text-accent-green" />
            ) : (
              <Folder className="w-4 h-4 text-[#8E8E93]" />
            )}
            <h3 className="text-sm font-medium text-white">
              {isCreate ? "新建项目" : "修改项目信息"}
            </h3>
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
          {/* 本地代码文件夹关联 (Codex 模式) */}
          <div className="p-3 rounded-xl bg-[#18181A] border border-[#323238] flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0 pr-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                <HardDrive className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-white truncate">
                  {selectedFolderName || "未关联本地代码目录"}
                </div>
                <div className="text-[10.5px] text-[#71717A] truncate">
                  {selectedFolderName
                    ? "代码将以此本地目录作为真实工作区"
                    : "选择电脑上的项目代码文件夹"}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={handlePickFolder}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-[11px] font-medium transition-colors shrink-0 cursor-pointer"
            >
              {selectedFolderName ? "更换文件夹" : "选择本地文件夹"}
            </button>
          </div>

          {/* 1. 项目名称 */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#A1A1AA]">
              项目名称 <span className="text-accent-coral">*</span>
            </label>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入项目名称"
              className="w-full h-9 px-3 rounded-lg bg-[#18181A] border border-[#323238] text-white text-xs outline-none focus:border-white/30 transition-all placeholder-[#71717A]"
            />
          </div>

          {/* 2. 项目图标选择 */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#A1A1AA]">
              项目图标
            </label>
            <div className="grid grid-cols-7 gap-1.5 p-2 rounded-xl bg-[#18181A] border border-[#323238]">
              {PRESET_ICONS.map((item) => {
                const isSelected = icon === item.id;
                const IconComp = item.Icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setIcon(item.id)}
                    className={`h-8 rounded-lg flex items-center justify-center transition-all ${
                      isSelected
                        ? "bg-[#383842] text-white ring-1 ring-white/30"
                        : "text-[#8E8E93] hover:text-white hover:bg-white/[0.05]"
                    }`}
                    title={item.label}
                  >
                    <IconComp className="w-4 h-4" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. 项目说明 / 描述 */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#A1A1AA]">
              项目描述与备注
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要记录项目背景、目标或提示词规范（选填）"
              className="w-full p-2.5 rounded-lg bg-[#18181A] border border-[#323238] text-white text-xs outline-none focus:border-white/30 transition-all placeholder-[#71717A] resize-none leading-relaxed"
            />
          </div>

          {/* 4. 归档切换与元信息 (仅编辑模式显示) */}
          {!isCreate && project && (
            <div className="pt-2 border-t border-[#2E2E33] flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isArchived}
                  onChange={(e) => setIsArchived(e.target.checked)}
                  className="w-3.5 h-3.5 rounded bg-[#18181A] border-[#383842] text-accent-green focus:ring-0 cursor-pointer"
                />
                <span className="text-[12px] text-[#A1A1AA]">归档此项目</span>
              </label>

              <div className="flex items-center gap-2 text-[11px] text-[#71717A]">
                <span>共 {projectSessions.length} 个会话</span>
              </div>
            </div>
          )}

          {/* 底部按钮组 */}
          <div className="pt-3 border-t border-[#2E2E33] flex items-center justify-between">
            {!isCreate && project ? (
              <button
                type="button"
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-lg text-accent-coral hover:bg-accent-coral/10 flex items-center gap-1.5 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>删除项目</span>
              </button>
            ) : (
              <div />
            )}

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
                {loading
                  ? isCreate
                    ? "创建中..."
                    : "保存中..."
                  : isCreate
                  ? "创建项目"
                  : "保存修改"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
