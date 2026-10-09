import { create } from "zustand";
import { Session, Project } from "@/types";
import { supabase } from "@/lib/supabase/client";
import {
  fetchSessionsApi,
  createSessionApi,
  updateSessionApi,
  deleteSessionApi,
} from "@/lib/api/sessions";
import {
  fetchProjectsApi,
  createProjectApi,
  updateProjectApi,
  deleteProjectApi,
} from "@/lib/api/projects";

const STORAGE_KEY = "genesis_sessions_cache";
const PROJECTS_KEY = "genesis_projects_cache";

const DEFAULT_PROJECTS: Project[] = [];
const DEFAULT_SESSIONS: Session[] = [];

// 提取当前登录用户的唯一 ID，杜绝跨账号共享缓存
function getCurrentUserId(): string | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem("genesis_auth_token");
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
      );
      return payload.sub || null;
    }
  } catch {}
  return null;
}

function getUserStorageKey(baseKey: string): string | null {
  const uid = getCurrentUserId();
  return uid ? `${baseKey}_${uid}` : null;
}

function loadCachedProjects(): Project[] {
  if (typeof window === "undefined") return [];
  const key = getUserStorageKey(PROJECTS_KEY);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return [];
}

function loadCachedSessions(): Session[] {
  if (typeof window === "undefined") return [];
  const key = getUserStorageKey(STORAGE_KEY);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return [];
}

function saveCachedSessions(sessions: Session[]) {
  if (typeof window === "undefined") return;
  const key = getUserStorageKey(STORAGE_KEY);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(sessions));
  } catch {}
}

function saveCachedProjects(projects: Project[]) {
  if (typeof window === "undefined") return;
  const key = getUserStorageKey(PROJECTS_KEY);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(projects));
  } catch {}
}

interface SessionState {
  projects: Project[];
  activeProjectId: string | null;
  sessions: Session[];
  activeSessionId: string | null;
  searchQuery: string;
  isLoading: boolean;
  error: string | null;

  // Composer 配置状态
  selectedModel: string;
  reasoningEffort: "low" | "medium" | "high";
  approvalMode: "approval" | "auto" | "full";

  // 状态机：编辑态与删除弹窗
  editingSessionId: string | null;
  deleteModalSessionId: string | null;
  isDeleteModalOpen: boolean;

  // 正在对话时的停止并归档弹窗
  stopAndArchiveModalSessionId: string | null;
  openStopAndArchiveModal: (sessionId: string) => void;
  closeStopAndArchiveModal: () => void;

  // 删除项目弹窗
  deleteModalProjectId: string | null;
  openDeleteProjectModal: (projectId: string) => void;
  closeDeleteProjectModal: () => void;
  confirmDeleteProject: () => Promise<void>;

  // 归档后的撤销 Toast
  archiveToast: {
    visible: boolean;
    type: "session" | "project";
    id: string;
    title: string;
  } | null;
  showArchiveToast: (type: "session" | "project", id: string, title: string) => void;
  hideArchiveToast: () => void;
  undoArchive: () => Promise<void>;

  // 历史记录与搜索弹窗状态
  isHistoryModalOpen: boolean;
  historyModalTab: "all" | "sessions" | "projects" | "archived";
  openHistoryModal: (initialTab?: "all" | "sessions" | "projects" | "archived") => void;
  closeHistoryModal: () => void;
  setHistoryModalTab: (tab: "all" | "sessions" | "projects" | "archived") => void;

  // 方法
  toggleProjectExpand: (projectId: string) => void;
  setActiveProjectId: (projectId: string | null) => void;
  startNewChat: () => void;
  setSelectedModel: (model: string) => void;
  setReasoningEffort: (effort: "low" | "medium" | "high") => void;
  setApprovalMode: (mode: "approval" | "auto" | "full") => void;
  archiveSession: (id: string) => void;
  unarchiveSession: (id: string) => void;

  fetchSessions: () => Promise<void>;
  createSession: (title?: string, projectId?: string) => Promise<Session>;
  updateSessionTitle: (id: string, newTitle: string) => Promise<void>;
  updateSessionDetails: (
    id: string,
    updates: {
      title?: string;
      project_id?: string | null;
      pinned?: boolean;
      is_archived?: boolean;
    }
  ) => Promise<void>;
  togglePinSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setActiveSessionId: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setEditingSessionId: (id: string | null) => void;
  openDeleteModal: (id: string) => void;
  closeDeleteModal: () => void;
  confirmDelete: () => Promise<void>;
  resetSessionStore: () => void;

  addProject: (name: string, description?: string, icon?: string) => Project;
  deleteProject: (projectId: string) => void;
  updateProject: (
    projectId: string,
    updates: {
      name?: string;
      icon?: string;
      description?: string;
      is_archived?: boolean;
      isExpanded?: boolean;
    }
  ) => Promise<void>;
  updateProjectName: (projectId: string, name: string) => void;
  archiveProject: (projectId: string) => void;
  unarchiveProject: (projectId: string) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessions: [],
  activeSessionId: null,
  searchQuery: "",
  isLoading: false,
  error: null,

  selectedModel: "5.5",
  reasoningEffort: "high",
  approvalMode: "approval",

  editingSessionId: null,
  deleteModalSessionId: null,
  isDeleteModalOpen: false,

  stopAndArchiveModalSessionId: null,
  openStopAndArchiveModal: (sessionId: string) =>
    set({ stopAndArchiveModalSessionId: sessionId }),
  closeStopAndArchiveModal: () => set({ stopAndArchiveModalSessionId: null }),

  deleteModalProjectId: null,
  openDeleteProjectModal: (projectId: string) =>
    set({ deleteModalProjectId: projectId }),
  closeDeleteProjectModal: () => set({ deleteModalProjectId: null }),
  confirmDeleteProject: async () => {
    const targetId = get().deleteModalProjectId;
    if (targetId) {
      get().deleteProject(targetId);
      set({ deleteModalProjectId: null });
    }
  },

  archiveToast: null,
  showArchiveToast: (type, id, title) =>
    set({ archiveToast: { visible: true, type, id, title } }),
  hideArchiveToast: () => set({ archiveToast: null }),
  undoArchive: async () => {
    const toast = get().archiveToast;
    if (!toast) return;
    if (toast.type === "session") {
      await get().unarchiveSession(toast.id);
    } else {
      await get().unarchiveProject(toast.id);
    }
    set({ archiveToast: null });
  },

  isHistoryModalOpen: false,
  historyModalTab: "all",
  openHistoryModal: (initialTab = "all") =>
    set({ isHistoryModalOpen: true, historyModalTab: initialTab }),
  closeHistoryModal: () => set({ isHistoryModalOpen: false }),
  setHistoryModalTab: (historyModalTab) => set({ historyModalTab }),

  toggleProjectExpand: (projectId) => {
    const target = get().projects.find((p) => p.id === projectId);
    const nextExpanded = target ? !target.isExpanded : true;
    const next = get().projects.map((p) =>
      p.id === projectId ? { ...p, isExpanded: nextExpanded } : p
    );
    set({ projects: next });
    saveCachedProjects(next);

    (async () => {
      try {
        await supabase
          .from("projects")
          .update({
            is_expanded: nextExpanded,
            updated_at: new Date().toISOString(),
          })
          .eq("id", projectId);
      } catch (err) {
        console.error("Supabase toggle project expand error:", err);
      }
    })();
  },

  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),

  addProject: (name, description, icon) => {
    const trimmed = name.trim() || "新项目";
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "00000000-0000-0000-0000-" + Date.now().toString().padStart(12, "0");
    const newProject: Project = {
      id,
      name: trimmed,
      icon,
      description,
      isExpanded: true,
      is_archived: false,
    };
    const next = [newProject, ...get().projects];
    set({ projects: next, activeProjectId: id });
    saveCachedProjects(next);

    // 异步双写持久化：FastAPI 与 Supabase
    (async () => {
      try {
        await createProjectApi({ id, name: trimmed, icon, description });
      } catch (err) {
        console.warn("createProjectApi failed, falling back to Supabase direct:", err);
      }

      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user?.id) return;
        const userId = user.id;
        const { error } = await supabase.from("projects").insert({
          id,
          user_id: userId,
          name: trimmed,
          icon: icon || null,
          description: description || null,
          is_expanded: true,
          is_archived: false,
        });
        if (error) {
          console.error("Supabase insert project error:", error);
        }
      } catch (err) {
        console.error("Supabase insert project error:", err);
      }
    })();

    return newProject;
  },

  updateProject: async (projectId, updates) => {
    const next = get().projects.map((p) =>
      p.id === projectId ? { ...p, ...updates } : p
    );
    set({ projects: next });
    saveCachedProjects(next);

    try {
      await updateProjectApi(projectId, updates);
    } catch (err) {
      console.warn("updateProjectApi failed, falling back to Supabase direct:", err);
    }

    try {
      const dbUpdates: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };
      if (updates.name !== undefined) dbUpdates.name = updates.name;
      if (updates.icon !== undefined) dbUpdates.icon = updates.icon;
      if (updates.description !== undefined) dbUpdates.description = updates.description;
      if (updates.is_archived !== undefined) dbUpdates.is_archived = updates.is_archived;
      if (updates.isExpanded !== undefined) dbUpdates.is_expanded = updates.isExpanded;

      const { error } = await supabase
        .from("projects")
        .update(dbUpdates)
        .eq("id", projectId);
      if (error) {
        console.error("Supabase update project error:", error);
      }
    } catch (err) {
      console.error("Supabase update project error:", err);
    }
  },

  updateProjectName: (projectId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    get().updateProject(projectId, { name: trimmed });
  },

  archiveProject: (projectId) => {
    get().updateProject(projectId, { is_archived: true });
    if (get().activeProjectId === projectId) {
      set({ activeProjectId: null });
    }
  },

  unarchiveProject: (projectId) => {
    get().updateProject(projectId, { is_archived: false });
  },

  deleteProject: (projectId) => {
    const next = get().projects.filter((p) => p.id !== projectId);
    set({
      projects: next,
      activeProjectId:
        get().activeProjectId === projectId ? null : get().activeProjectId,
    });
    saveCachedProjects(next);

    (async () => {
      try {
        await deleteProjectApi(projectId);
      } catch (err) {
        console.warn("deleteProjectApi failed:", err);
      }

      try {
        const { error } = await supabase
          .from("projects")
          .delete()
          .eq("id", projectId);
        if (error) {
          console.error("Supabase delete project error:", error);
        }
      } catch (err) {
        console.error("Supabase delete project error:", err);
      }
    })();
  },

  startNewChat: () => {
    set({ activeSessionId: null, activeProjectId: null });
  },

  resetSessionStore: () => {
    set({
      sessions: [],
      projects: [],
      activeSessionId: null,
      activeProjectId: null,
      editingSessionId: null,
      searchQuery: "",
    });
  },

  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setReasoningEffort: (reasoningEffort) => set({ reasoningEffort }),
  setApprovalMode: (approvalMode) => set({ approvalMode }),

  archiveSession: async (id) => {
    const next = get().sessions.map((s) =>
      s.id === id ? { ...s, is_archived: true } : s
    );
    const wasActive = get().activeSessionId === id;
    const remaining = next.filter((s) => !s.is_archived);
    set({
      sessions: next,
      activeSessionId: wasActive
        ? remaining.length > 0
          ? remaining[0].id
          : null
        : get().activeSessionId,
    });
    saveCachedSessions(next);

    try {
      await updateSessionApi(id, { is_archived: true });
    } catch (err) {
      console.warn("Remote archiveSession failed, saved locally:", err);
    }

    try {
      await supabase
        .from("sessions")
        .update({ is_archived: true, updated_at: new Date().toISOString() })
        .eq("id", id);
    } catch (err) {
      console.error("Supabase archiveSession error:", err);
    }
  },

  unarchiveSession: async (id) => {
    const next = get().sessions.map((s) =>
      s.id === id ? { ...s, is_archived: false } : s
    );
    set({ sessions: next });
    saveCachedSessions(next);

    try {
      await updateSessionApi(id, { is_archived: false });
    } catch (err) {
      console.warn("Remote unarchiveSession failed, saved locally:", err);
    }

    try {
      await supabase
        .from("sessions")
        .update({ is_archived: false, updated_at: new Date().toISOString() })
        .eq("id", id);
    } catch (err) {
      console.error("Supabase unarchiveSession error:", err);
    }
  },

  fetchSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const [remoteSessions, remoteProjects] = await Promise.all([
        fetchSessionsApi().catch(() => null),
        fetchProjectsApi().catch(() => null),
      ]);

      // 1. 解析项目列表：优先 API，失败才回退本地缓存
      let projectsToSet: Project[] = [];
      if (Array.isArray(remoteProjects)) {
        projectsToSet = remoteProjects;
      } else {
        projectsToSet = loadCachedProjects();
      }

      // 2. 解析会话列表：优先 API，失败才回退本地缓存
      let sessionsToSet: Session[] = [];
      if (Array.isArray(remoteSessions)) {
        sessionsToSet = remoteSessions;
      } else {
        sessionsToSet = loadCachedSessions();
      }

      set({
        sessions: sessionsToSet,
        projects: projectsToSet,
        isLoading: false,
      });
      saveCachedSessions(sessionsToSet);
      saveCachedProjects(projectsToSet);
      return;
    } catch (err: unknown) {
      console.warn("fetchSessions fallback to local cache:", err);
    }

    const cachedSessions = loadCachedSessions();
    const cachedProjects = loadCachedProjects();
    set({
      sessions: cachedSessions,
      projects: cachedProjects,
      isLoading: false,
    });
  },

  createSession: async (title = "新对话", projectId?: string) => {
    const now = new Date().toISOString();
    const tempId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "00000000-0000-0000-0000-" + Date.now().toString().padStart(12, "0");

    const targetProject = projectId ? projectId : undefined;

    const newSession: Session = {
      id: tempId,
      project_id: targetProject,
      title,
      pinned: false,
      is_archived: false,
      created_at: now,
      updated_at: now,
    };

    // 自动展开目标项目
    const updatedProjects = targetProject
      ? get().projects.map((p) =>
          p.id === targetProject ? { ...p, isExpanded: true } : p
        )
      : get().projects;

    // 乐观更新
    const prevSessions = get().sessions;
    const updatedSessions = [newSession, ...prevSessions];
    set({
      projects: updatedProjects,
      sessions: updatedSessions,
      activeSessionId: newSession.id,
      activeProjectId: targetProject || null,
      editingSessionId: null,
    });
    saveCachedSessions(updatedSessions);
    saveCachedProjects(updatedProjects);

    // 异步双写持久化：FastAPI 与 Supabase (非阻塞，绝不卡死前端发送)
    (async () => {
      try {
        if (targetProject) {
          const projObj = get().projects.find((p) => p.id === targetProject);
          if (projObj) {
            const { data: existingProj } = await supabase
              .from("projects")
              .select("id")
              .eq("id", targetProject)
              .maybeSingle();
            if (!existingProj) {
              const {
                data: { user },
              } = await supabase.auth.getUser();
              if (user?.id) {
                await supabase.from("projects").insert({
                  id: projObj.id,
                  user_id: user.id,
                  name: projObj.name,
                  icon: projObj.icon || null,
                  description: projObj.description || null,
                  is_expanded: true,
                  is_archived: false,
                });
              }
            }
          }
        }

        const remote = await createSessionApi({
          id: tempId,
          title,
          project_id: targetProject,
        });
        if (remote && remote.id) {
          set((state) => {
            const synced = state.sessions.map((s) =>
              s.id === tempId ? { ...remote, project_id: targetProject } : s
            );
            saveCachedSessions(synced);
            return {
              sessions: synced,
              activeSessionId:
                state.activeSessionId === tempId
                  ? remote.id
                  : state.activeSessionId,
            };
          });
        }
      } catch (err) {
        console.warn("Remote createSession failed, continuing with local session:", err);
      }

      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user?.id) {
          await supabase.from("sessions").insert({
            id: tempId,
            user_id: user.id,
            project_id: targetProject || null,
            title,
            pinned: false,
            is_archived: false,
            created_at: now,
            updated_at: now,
          });
        }
      } catch (err) {
        console.error("Supabase direct insert session error:", err);
      }
    })();

    return newSession;
  },

  updateSessionDetails: async (id, updates) => {
    const currentSessions = get().sessions;
    const target = currentSessions.find((s) => s.id === id);
    if (!target) return;

    const now = new Date().toISOString();
    const updated = currentSessions.map((s) =>
      s.id === id
        ? {
            ...s,
            ...(updates.title !== undefined ? { title: updates.title } : {}),
            ...(updates.project_id !== undefined ? { project_id: updates.project_id || undefined } : {}),
            ...(updates.pinned !== undefined ? { pinned: updates.pinned } : {}),
            ...(updates.is_archived !== undefined ? { is_archived: updates.is_archived } : {}),
            updated_at: now,
          }
        : s
    );

    if (updates.pinned !== undefined) {
      updated.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
    }

    // 若转移到某个项目，自动展开目标项目
    let updatedProjects = get().projects;
    if (updates.project_id) {
      updatedProjects = updatedProjects.map((p) =>
        p.id === updates.project_id ? { ...p, isExpanded: true } : p
      );
    }

    set({ sessions: updated, projects: updatedProjects, editingSessionId: null });
    saveCachedSessions(updated);
    saveCachedProjects(updatedProjects);

    try {
      await updateSessionApi(id, updates);
    } catch (err) {
      console.warn("Remote updateSessionDetails failed, saved locally:", err);
    }

    try {
      const dbUpdates: Record<string, any> = { updated_at: now };
      if (updates.title !== undefined) dbUpdates.title = updates.title;
      if (updates.project_id !== undefined) dbUpdates.project_id = updates.project_id || null;
      if (updates.pinned !== undefined) dbUpdates.pinned = updates.pinned;
      if (updates.is_archived !== undefined) dbUpdates.is_archived = updates.is_archived;

      const { error } = await supabase
        .from("sessions")
        .update(dbUpdates)
        .eq("id", id);
      if (error) {
        console.error("Supabase updateSessionDetails error:", error);
      }
    } catch (err) {
      console.error("Supabase updateSessionDetails error:", err);
    }
  },

  updateSessionTitle: async (id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) {
      set({ editingSessionId: null });
      return;
    }
    await get().updateSessionDetails(id, { title: trimmed });
  },

  togglePinSession: async (id: string) => {
    const currentSessions = get().sessions;
    const target = currentSessions.find((s) => s.id === id);
    if (!target) return;

    const nextPinned = !target.pinned;
    const now = new Date().toISOString();
    const updated = currentSessions.map((s) =>
      s.id === id ? { ...s, pinned: nextPinned, updated_at: now } : s
    );
    // 置顶排序逻辑：pinned 为 true 的排在前面，再按 updated_at 倒序
    updated.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    set({ sessions: updated });
    saveCachedSessions(updated);

    try {
      await updateSessionApi(id, { pinned: nextPinned });
    } catch (err) {
      console.warn("Remote togglePinSession failed, saved locally:", err);
    }

    try {
      await supabase
        .from("sessions")
        .update({ pinned: nextPinned, updated_at: now })
        .eq("id", id);
    } catch (err) {
      console.error("Supabase togglePinSession error:", err);
    }
  },

  deleteSession: async (id: string) => {
    const currentSessions = get().sessions;
    const remaining = currentSessions.filter((s) => s.id !== id);
    const wasActive = get().activeSessionId === id;
    const nextActive = wasActive
      ? remaining.length > 0
        ? remaining[0].id
        : null
      : get().activeSessionId;

    set({
      sessions: remaining,
      activeSessionId: nextActive,
      isDeleteModalOpen: false,
      deleteModalSessionId: null,
    });
    saveCachedSessions(remaining);

    try {
      await deleteSessionApi(id);
    } catch (err) {
      console.warn("Remote deleteSession failed, removed locally:", err);
    }

    try {
      await supabase.from("sessions").delete().eq("id", id);
    } catch (err) {
      console.error("Supabase deleteSession error:", err);
    }
  },

  setActiveSessionId: (id: string | null) => {
    set({ activeSessionId: id, editingSessionId: null });
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  setEditingSessionId: (id: string | null) => {
    set({ editingSessionId: id });
  },

  openDeleteModal: (id: string) => {
    set({ isDeleteModalOpen: true, deleteModalSessionId: id });
  },

  closeDeleteModal: () => {
    set({ isDeleteModalOpen: false, deleteModalSessionId: null });
  },

  confirmDelete: async () => {
    const targetId = get().deleteModalSessionId;
    if (targetId) {
      await get().deleteSession(targetId);
    }
  },
}));
