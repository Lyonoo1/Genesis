"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Folder,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Trash2,
  Pin,
  Archive,
  Check,
  X,
  SquarePen,
  Edit3,
  HardDrive,
} from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";
import { useChatStore } from "@/stores/useChatStore";
import { Session, Project } from "@/types";
import { EditProjectModal, getProjectIconComponent } from "./EditProjectModal";
import { EditSessionModal } from "./EditSessionModal";
import { saveDirectoryHandle } from "@/lib/workspace/localWorkspaceManager";

export function ProjectTree() {
  const router = useRouter();
  const {
    projects,
    sessions,
    activeSessionId,
    toggleProjectExpand,
    setActiveProjectId,
    setActiveSessionId,
    togglePinSession,
    archiveSession,
    openDeleteModal,
    addProject,
    updateProjectName,
    archiveProject,
    deleteProject,
    createSession,
    editingSessionId,
    setEditingSessionId,
    updateSessionTitle,
    openStopAndArchiveModal,
    showArchiveToast,
    openDeleteProjectModal,
  } = useSessionStore();

  const { isStreaming, streamingSessionId } = useChatStore();

  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [activeProjectMenuId, setActiveProjectMenuId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState("");
  const [editingSessionTitle, setEditingSessionTitle] = useState("");
  const [isProjectsOpen, setIsProjectsOpen] = useState(true);
  const [isRecentOpen, setIsRecentOpen] = useState(true);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [isGlobalProjectMenuOpen, setIsGlobalProjectMenuOpen] = useState(false);

  // 弹窗状态：新建项目、修改项目信息、修改对话信息
  const [isCreateProjectModalOpen, setIsCreateProjectModalOpen] = useState(false);
  const [editingProjectModalTarget, setEditingProjectModalTarget] = useState<Project | null>(null);
  const [editingSessionModalTarget, setEditingSessionModalTarget] = useState<Session | null>(null);

  // 点击空白处或按 Escape 键关闭会话更多操作浮层
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-menu-container]")) {
        return;
      }
      if (activeMenuId) setActiveMenuId(null);
      if (activeProjectMenuId) setActiveProjectMenuId(null);
      if (isGlobalProjectMenuOpen) setIsGlobalProjectMenuOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (activeMenuId) setActiveMenuId(null);
        if (activeProjectMenuId) setActiveProjectMenuId(null);
        if (isGlobalProjectMenuOpen) setIsGlobalProjectMenuOpen(false);
        if (isCreatingProject) {
          setIsCreatingProject(false);
          setNewProjectName("");
        }
        if (editingProjectId) {
          setEditingProjectId(null);
          setEditingProjectName("");
        }
        if (editingSessionId) {
          setEditingSessionId(null);
          setEditingSessionTitle("");
        }
      }
    }
    if (
      activeMenuId ||
      activeProjectMenuId ||
      isGlobalProjectMenuOpen ||
      isCreatingProject ||
      editingProjectId ||
      editingSessionId
    ) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    activeMenuId,
    activeProjectMenuId,
    isGlobalProjectMenuOpen,
    isCreatingProject,
    editingProjectId,
    editingSessionId,
    setEditingSessionId,
  ]);

  const handleSaveProjectName = (projectId: string) => {
    const trimmed = editingProjectName.trim();
    if (trimmed) {
      updateProjectName(projectId, trimmed);
    }
    setEditingProjectId(null);
    setEditingProjectName("");
  };

  const handleConfirmCreateProject = () => {
    const trimmed = newProjectName.trim();
    if (trimmed) {
      addProject(trimmed);
    }
    setIsCreatingProject(false);
    setNewProjectName("");
  };

  // 核心：Codex 同款模式 —— 选择本地代码文件夹创建并绑定项目
  const handleCreateProjectFromFolder = async () => {
    setIsGlobalProjectMenuOpen(false);
    setIsProjectsOpen(true);

    if (typeof window === "undefined" || !("showDirectoryPicker" in window)) {
      setIsCreateProjectModalOpen(true);
      return;
    }

    try {
      const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({
        mode: "readwrite",
      });

      const folderName = handle.name || "本地项目";
      const newProj = addProject(folderName, undefined, "folder");
      if (newProj && newProj.id) {
        await saveDirectoryHandle(newProj.id, handle);
        setActiveProjectId(newProj.id);
        if (!newProj.isExpanded) {
          toggleProjectExpand(newProj.id);
        }

        const newSession = await createSession("新对话", newProj.id);
        if (newSession && newSession.id) {
          router.push(`/chat/${newSession.id}`);
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        console.error("选择文件夹创建项目失败:", err);
        setIsCreateProjectModalOpen(true);
      }
    }
  };

  const handleSaveSessionTitle = (sessionId: string) => {
    const trimmed = editingSessionTitle.trim();
    if (trimmed) {
      updateSessionTitle(sessionId, trimmed);
    }
    setEditingSessionId(null);
    setEditingSessionTitle("");
  };

  const handleStartEditSession = (session: Session) => {
    setEditingSessionId(session.id);
    setEditingSessionTitle(session.title);
    setActiveMenuId(null);
  };

  const handleSelectSession = (session: Session, projectId?: string) => {
    if (projectId) setActiveProjectId(projectId);
    setActiveSessionId(session.id);
    router.push(`/chat/${session.id}`);
  };

  const handleToggleProject = (project: Project) => {
    setActiveProjectId(project.id);
    toggleProjectExpand(project.id);
  };

  // 过滤未归档的会话
  const activeSessions = (sessions || []).filter((s) => s && !s.is_archived);
  // 独立会话（未归属于任何项目的会话）展示在“最近”
  const standaloneSessions = activeSessions.filter((s) => s && !s.project_id);

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3 select-none scrollbar-thin space-y-4">
      {/* 1. 项目分区 (Projects) */}
      <div className="space-y-1">
        <div className="group/project-header relative flex items-center justify-between px-2.5 pb-1 text-[12px] font-medium text-[#7E7E82] h-7">
          <button
            type="button"
            onClick={() => setIsProjectsOpen(!isProjectsOpen)}
            className="flex items-center gap-1 hover:text-[#ECECED] transition-colors cursor-pointer"
          >
            <span>项目</span>
            <ChevronRight
              className={`w-3.5 h-3.5 text-[#7E7E82] transition-all duration-150 ${
                !isProjectsOpen
                  ? "opacity-100"
                  : "opacity-0 group-hover/project-header:opacity-100"
              } ${isProjectsOpen ? "rotate-90" : ""}`}
            />
          </button>

          {/* 右侧更多与新建图标组 (截图同款 ... 与 +，平时隐藏，hover 展现) */}
          <div className="flex items-center gap-1.5 text-[#7E7E82] opacity-0 group-hover/project-header:opacity-100 transition-opacity">
            <button
              type="button"
              data-menu-container
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setIsGlobalProjectMenuOpen(!isGlobalProjectMenuOpen);
              }}
              className="p-0.5 rounded hover:text-[#ECECED] hover:bg-white/[0.06] transition-colors"
              title="项目选项"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleCreateProjectFromFolder();
              }}
              className="p-0.5 rounded hover:text-[#ECECED] hover:bg-white/[0.06] transition-colors cursor-pointer"
              title="选择本地文件夹新建项目 (Codex 模式)"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 下拉浮层：项目全局选项 */}
          {isGlobalProjectMenuOpen && (
            <div
              data-menu-container
              onMouseDown={(e) => e.stopPropagation()}
              className="absolute right-2 top-7 z-50 w-44 py-1 bg-[#1E1E20] border border-hairline rounded-lg shadow-xl text-xs space-y-0.5 animate-in fade-in zoom-in-95"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={handleCreateProjectFromFolder}
                className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
              >
                <HardDrive className="w-3.5 h-3.5 text-accent-green" />
                <span>选择本地文件夹新建</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsGlobalProjectMenuOpen(false);
                  setIsProjectsOpen(true);
                  setIsCreateProjectModalOpen(true);
                }}
                className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#8E8E93] hover:text-white hover:bg-white/[0.06] text-left cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-[#8E8E93]" />
                <span>新建空白项目...</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsGlobalProjectMenuOpen(false);
                  setIsProjectsOpen(true);
                  projects.forEach((p) => {
                    if (!p.isExpanded) toggleProjectExpand(p.id);
                  });
                }}
                className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left"
              >
                <ChevronDown className="w-3.5 h-3.5 text-[#8E8E93]" />
                <span>展开所有项目</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsGlobalProjectMenuOpen(false);
                  projects.forEach((p) => {
                    if (p.isExpanded) toggleProjectExpand(p.id);
                  });
                }}
                className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left"
              >
                <ChevronRight className="w-3.5 h-3.5 text-[#8E8E93]" />
                <span>折叠所有项目</span>
              </button>
            </div>
          )}
        </div>

        {/* 新建项目输入行 (展开态) */}
        {isCreatingProject && (
          <div
            className="px-1 py-1"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-2.5 h-8 rounded-[8px] bg-[#373839] border border-white/20">
              <Folder className="w-4 h-4 text-[#ECECED] stroke-[1.6] shrink-0" />
              <input
                type="text"
                autoFocus
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleConfirmCreateProject();
                  } else if (e.key === "Escape") {
                    setIsCreatingProject(false);
                    setNewProjectName("");
                  }
                }}
                placeholder="项目名称..."
                className="w-full bg-transparent text-[13.5px] text-white placeholder-[#7E7E82] outline-none border-none p-0"
              />
              <div className="flex items-center gap-0.5 shrink-0 text-[#8E8E93]">
                <button
                  type="button"
                  onClick={handleConfirmCreateProject}
                  className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
                  title="确认创建 (Enter)"
                >
                  <Check className="w-3.5 h-3.5 text-accent-green" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsCreatingProject(false);
                    setNewProjectName("");
                  }}
                  className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
                  title="取消 (Esc)"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {isProjectsOpen &&
          (projects || [])
            .filter((p) => p && !p.is_archived)
            .map((project) => {
            const projectSessions = activeSessions.filter(
              (s) => s && s.project_id === project.id
            );

            const isExpanded = !!project.isExpanded;
            const isProjectMenuOpen = activeProjectMenuId === project.id;
            const isEditing = editingProjectId === project.id;

            return (
              <div key={project.id} className="space-y-0.5">
                {/* 项目文件夹头部行 */}
                {isEditing ? (
                  <div
                    className="flex items-center gap-2 px-2.5 h-8 rounded-[8px] bg-[#373839] border border-white/20 w-full"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Folder className="w-4 h-4 text-[#ECECED] stroke-[1.6] shrink-0" />
                    <input
                      type="text"
                      autoFocus
                      value={editingProjectName}
                      onChange={(e) => setEditingProjectName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleSaveProjectName(project.id);
                        } else if (e.key === "Escape") {
                          setEditingProjectId(null);
                        }
                      }}
                      className="w-full bg-transparent text-[13.5px] text-white outline-none border-none p-0"
                    />
                    <div className="flex items-center gap-0.5 shrink-0 text-[#8E8E93]">
                      <button
                        type="button"
                        onClick={() => handleSaveProjectName(project.id)}
                        className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
                        title="确认 (Enter)"
                      >
                        <Check className="w-3.5 h-3.5 text-accent-green" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingProjectId(null)}
                        className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
                        title="取消 (Esc)"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    onClick={() => handleToggleProject(project)}
                    className="group/project relative flex items-center justify-between px-2.5 h-8 rounded-[8px] text-[13.5px] font-normal text-[#ECECED] hover:bg-white/[0.05] transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 pr-2">
                      {React.createElement(getProjectIconComponent(project.icon), {
                        className: "w-4 h-4 text-[#ECECED] stroke-[1.6] shrink-0",
                      })}
                      <span className="truncate">{project.name}</span>
                    </div>

                    {/* 右侧悬浮操作按钮组：参考图二设计，悬浮展现或展开菜单时保持展现 */}
                    <div
                      className={`flex items-center gap-0.5 shrink-0 ${
                        isProjectMenuOpen
                          ? "opacity-100"
                          : "opacity-0 group-hover/project:opacity-100"
                      } transition-opacity`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* 1. 更多操作按钮 (...) */}
                      <div className="relative" data-menu-container>
                        <button
                          type="button"
                          data-menu-container
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveProjectMenuId(
                              isProjectMenuOpen ? null : project.id
                            );
                          }}
                          className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                          title="项目选项"
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </button>

                        {/* 下拉浮层 */}
                        {isProjectMenuOpen && (
                          <div
                            data-menu-container
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-0 top-7 z-50 w-36 py-1 bg-[#1E1E20] border border-hairline rounded-lg shadow-xl text-xs space-y-0.5 animate-in fade-in zoom-in-95"
                          >
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                setActiveProjectMenuId(null);
                                if (!project.isExpanded) {
                                  toggleProjectExpand(project.id);
                                }
                                setActiveProjectId(project.id);
                                const newSess = await createSession("新对话", project.id);
                                if (newSess?.id) {
                                  router.push(`/chat/${newSess.id}`);
                                }
                              }}
                              className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
                            >
                              <Plus className="w-3.5 h-3.5 text-[#8E8E93]" />
                              <span>添加新对话</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingProjectModalTarget(project);
                                setActiveProjectMenuId(null);
                              }}
                              className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5 text-[#8E8E93]" />
                              <span>修改项目信息</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveProjectMenuId(null);
                                archiveProject(project.id);
                                const currentSess = sessions.find((s) => s.id === activeSessionId);
                                if (currentSess?.project_id === project.id) {
                                  const remaining = sessions.filter(
                                    (s) => s.id !== activeSessionId && s.project_id !== project.id && !s.is_archived
                                  );
                                  router.push(remaining.length > 0 ? `/chat/${remaining[0].id}` : "/chat");
                                }
                                showArchiveToast("project", project.id, project.name);
                              }}
                              className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
                            >
                              <Archive className="w-3.5 h-3.5 text-[#8E8E93]" />
                              <span>归档项目</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveProjectMenuId(null);
                                openDeleteProjectModal(project.id);
                              }}
                              className="w-full px-2.5 py-1.5 flex items-center gap-2 text-accent-coral hover:bg-accent-coral/10 text-left cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>删除项目</span>
                            </button>
                          </div>
                        )}
                      </div>

                      {/* 2. 添加新对话按钮 (截图同款 SquarePen 图标) */}
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!project.isExpanded) {
                            toggleProjectExpand(project.id);
                          }
                          setActiveProjectId(project.id);
                          const newSess = await createSession("新对话", project.id);
                          if (newSess?.id) {
                            router.push(`/chat/${newSess.id}`);
                          }
                        }}
                        className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                        title="在当前项目下添加新对话"
                      >
                        <SquarePen className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

              {/* 展开的会话列表：截图同款无竖线、无多余缩进断层，文本对齐文件夹标题 */}
              {isExpanded && (
                <div className="space-y-0.5 my-0.5">
                  {projectSessions.length === 0 ? (
                    <div className="pl-7 py-1 text-[12px] text-codex-subtle">
                      暂无会话
                    </div>
                  ) : (
                    projectSessions.map((session) => {
                      const isActive = activeSessionId === session.id;
                      const isMenuOpen = activeMenuId === session.id;
                      const isEditing = editingSessionId === session.id;

                      if (isEditing) {
                        return (
                          <div
                            key={session.id}
                            className="flex items-center gap-2 pl-7 pr-2.5 h-8 rounded-[8px] bg-[#373839] border border-white/20 w-full"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="text"
                              autoFocus
                              value={editingSessionTitle}
                              onChange={(e) =>
                                setEditingSessionTitle(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  handleSaveSessionTitle(session.id);
                                } else if (e.key === "Escape") {
                                  setEditingSessionId(null);
                                }
                              }}
                              className="w-full bg-transparent text-[13.5px] text-white outline-none border-none p-0"
                            />
                            <div className="flex items-center gap-0.5 shrink-0 text-[#8E8E93]">
                              <button
                                type="button"
                                onClick={() =>
                                  handleSaveSessionTitle(session.id)
                                }
                                className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
                                title="确认 (Enter)"
                              >
                                <Check className="w-3.5 h-3.5 text-accent-green" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingSessionId(null)}
                                className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
                                title="取消 (Esc)"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={session.id}
                          className={`group/session relative flex items-center justify-between pl-7 pr-2.5 h-8 rounded-[8px] text-[13.5px] cursor-pointer transition-colors ${
                            isActive
                              ? "bg-[#373839] text-white font-normal"
                              : "text-[#ECECED] hover:bg-white/[0.05] font-normal"
                          }`}
                          onClick={() =>
                            handleSelectSession(session, project.id)
                          }
                        >
                          <div className="flex items-center gap-1.5 min-w-0 pr-2">
                            {session.pinned && (
                              <Pin className="w-3 h-3 text-accent-coral fill-accent-coral shrink-0 rotate-45" />
                            )}
                            <span className="truncate">{session.title}</span>
                          </div>

                          {/* 悬浮操作菜单与独立归档按钮组 */}
                          <div
                            data-menu-container
                            className={`flex items-center gap-0.5 ${
                              isActive || isMenuOpen
                                ? "opacity-100"
                                : "opacity-0 group-hover/session:opacity-100"
                            } transition-opacity`}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            {/* 1. 更多操作按钮 (...) */}
                            <div className="relative" data-menu-container>
                              <button
                                type="button"
                                data-menu-container
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveMenuId(
                                    isMenuOpen ? null : session.id
                                  );
                                }}
                                className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                                title="更多操作"
                              >
                                <MoreHorizontal className="w-3.5 h-3.5" />
                              </button>

                              {/* 下拉浮层 */}
                              {isMenuOpen && (
                                <div
                                  data-menu-container
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => e.stopPropagation()}
                                  className="absolute right-0 top-7 z-50 w-36 py-1 bg-[#1E1E20] border border-hairline rounded-lg shadow-xl text-xs space-y-0.5 animate-in fade-in zoom-in-95"
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingSessionModalTarget(session);
                                      setActiveMenuId(null);
                                    }}
                                    className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
                                  >
                                    <Edit3 className="w-3.5 h-3.5 text-[#8E8E93]" />
                                    <span>修改对话信息</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      togglePinSession(session.id);
                                      setActiveMenuId(null);
                                    }}
                                    className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
                                  >
                                    <Pin className="w-3.5 h-3.5 text-[#8E8E93]" />
                                    <span>
                                      {session.pinned ? "取消置顶" : "置顶会话"}
                                    </span>
                                  </button>
                                </div>
                              )}
                            </div>

                            {/* 2. 独立直接归档按钮 */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const isExecuting =
                                  isStreaming && streamingSessionId === session.id;
                                if (isExecuting) {
                                  openStopAndArchiveModal(session.id);
                                } else {
                                  archiveSession(session.id);
                                  if (activeSessionId === session.id) {
                                    const remaining = sessions.filter(
                                      (s) => s.id !== session.id && !s.is_archived
                                    );
                                    router.push(remaining.length > 0 ? `/chat/${remaining[0].id}` : "/chat");
                                  }
                                  showArchiveToast("session", session.id, session.title);
                                }
                              }}
                              className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                              title="直接归档对话"
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 2. 最近分区 (Recent) - hover 展现 > 箭头 (截图同款) */}
      <div className="pt-2 group/recent-header">
        <button
          type="button"
          onClick={() => setIsRecentOpen(!isRecentOpen)}
          className="flex items-center gap-1 px-2.5 h-7 text-[12px] font-medium text-[#7E7E82] hover:text-[#ECECED] transition-colors cursor-pointer w-full text-left"
        >
          <span>最近</span>
          <ChevronRight
            className={`w-3.5 h-3.5 text-[#7E7E82] transition-all duration-150 ${
              isRecentOpen
                ? "rotate-90 opacity-100 text-[#ECECED]"
                : "opacity-0 group-hover/recent-header:opacity-100"
            }`}
          />
        </button>

        {isRecentOpen && (
          <div className="space-y-0.5 mt-1 animate-in fade-in duration-150">
            {standaloneSessions.length === 0 ? (
              <div className="pl-2.5 py-1 text-[12px] text-codex-subtle">
                暂无独立对话
              </div>
            ) : (
              standaloneSessions.map((session) => {
                const isActive = activeSessionId === session.id;
                const isMenuOpen = activeMenuId === session.id;
                const isEditing = editingSessionId === session.id;

                if (isEditing) {
                  return (
                    <div
                      key={session.id}
                      className="flex items-center gap-2 px-2.5 h-8 rounded-[8px] bg-[#373839] border border-white/20 w-full"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="text"
                        autoFocus
                        value={editingSessionTitle}
                        onChange={(e) =>
                          setEditingSessionTitle(e.target.value)
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleSaveSessionTitle(session.id);
                          } else if (e.key === "Escape") {
                            setEditingSessionId(null);
                          }
                        }}
                        className="w-full bg-transparent text-[13.5px] text-white outline-none border-none p-0"
                      />
                      <div className="flex items-center gap-0.5 shrink-0 text-[#8E8E93]">
                        <button
                          type="button"
                          onClick={() =>
                            handleSaveSessionTitle(session.id)
                          }
                          className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
                          title="确认 (Enter)"
                        >
                          <Check className="w-3.5 h-3.5 text-accent-green" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingSessionId(null)}
                          className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
                          title="取消 (Esc)"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={session.id}
                    onClick={() =>
                      handleSelectSession(session, session.project_id)
                    }
                    className={`group/recent-session relative flex items-center justify-between px-2.5 h-8 rounded-[8px] text-[13.5px] cursor-pointer transition-colors ${
                      isActive
                        ? "bg-[#373839] text-white font-normal"
                        : "text-[#ECECED] hover:bg-white/[0.05] font-normal"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0 pr-2">
                      {session.pinned && (
                        <Pin className="w-3 h-3 text-accent-coral fill-accent-coral shrink-0 rotate-45" />
                      )}
                      <span className="truncate">{session.title}</span>
                    </div>

                    <div
                      data-menu-container
                      className={`flex items-center gap-0.5 ${
                        isActive || isMenuOpen
                          ? "opacity-100"
                          : "opacity-0 group-hover/recent-session:opacity-100"
                      } transition-opacity`}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {/* 1. 更多操作按钮 (...) */}
                      <div className="relative" data-menu-container>
                        <button
                          type="button"
                          data-menu-container
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveMenuId(isMenuOpen ? null : session.id);
                          }}
                          className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                          title="更多操作"
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </button>

                        {isMenuOpen && (
                          <div
                            data-menu-container
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-0 top-7 z-50 w-36 py-1 bg-[#1E1E20] border border-hairline rounded-lg shadow-xl text-xs space-y-0.5 animate-in fade-in zoom-in-95"
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingSessionModalTarget(session);
                                setActiveMenuId(null);
                              }}
                              className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5 text-[#8E8E93]" />
                              <span>修改对话信息</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePinSession(session.id);
                                setActiveMenuId(null);
                              }}
                              className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
                            >
                              <Pin className="w-3.5 h-3.5 text-[#8E8E93]" />
                              <span>
                                {session.pinned ? "取消置顶" : "置顶会话"}
                              </span>
                            </button>
                          </div>
                        )}
                      </div>

                      {/* 2. 独立直接归档按钮 */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const isExecuting =
                            isStreaming && streamingSessionId === session.id;
                          if (isExecuting) {
                            openStopAndArchiveModal(session.id);
                          } else {
                            archiveSession(session.id);
                            if (activeSessionId === session.id) {
                              const remaining = sessions.filter(
                                (s) => s.id !== session.id && !s.is_archived
                              );
                              router.push(remaining.length > 0 ? `/chat/${remaining[0].id}` : "/chat");
                            }
                            showArchiveToast("session", session.id, session.title);
                          }
                        }}
                        className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                        title="直接归档对话"
                      >
                        <Archive className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* 新建项目弹窗 */}
      <EditProjectModal
        isOpen={isCreateProjectModalOpen}
        mode="create"
        onClose={() => setIsCreateProjectModalOpen(false)}
      />

      {/* 修改项目信息弹窗 */}
      <EditProjectModal
        project={editingProjectModalTarget}
        mode="edit"
        isOpen={!!editingProjectModalTarget}
        onClose={() => setEditingProjectModalTarget(null)}
      />

      {/* 修改对话信息弹窗 */}
      <EditSessionModal
        session={editingSessionModalTarget}
        isOpen={!!editingSessionModalTarget}
        onClose={() => setEditingSessionModalTarget(null)}
      />
    </div>
  );
}
