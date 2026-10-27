import { create } from "zustand";
import { diffLines } from "diff";
import {
  getDirectoryHandle,
  saveDirectoryHandle,
  verifyPermission,
  writeLocalFile,
} from "@/lib/workspace/localWorkspaceManager";

export interface CanvasSnapshot {
  id: string;
  version: number;
  content: string;
  timestamp: string; // ISO string or formatted timestamp
  description: string;
  linesCount: number;
  additions: number;
  deletions: number;
}

export interface CanvasArtifact {
  id: string;
  title: string;
  language: string;
  filePath: string;
  currentContent: string;
  originalContent: string;
  snapshots: CanvasSnapshot[];
  currentVersionIndex: number; // Index of snapshot currently viewed/active
  isDirty: boolean;
  sessionId?: string;
  messageId?: string;
  lastSavedAt?: string;
  hasDiff?: boolean;
  mdViewMode?: "preview" | "editor" | "split";
}

export type CanvasViewMode = "editor" | "diff";
export type CanvasDiffLayout = "split" | "inline";
export type CanvasDrawerWidth = "normal" | "expanded" | "fullscreen";

export interface CanvasDiskSaveResult {
  success: boolean;
  message: string;
  isFallbackDownload?: boolean;
}

// 辅助方法：根据文件路径智能推断语言
export function inferLanguageFromPath(filePath: string = "", defaultLang = "plaintext"): string {
  const p = filePath.toLowerCase();
  if (p.endsWith(".vue")) return "html";
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".sql")) return "sql";
  if (p.endsWith(".html") || p.endsWith(".htm")) return "html";
  if (p.endsWith(".css") || p.endsWith(".scss") || p.endsWith(".less")) return "css";
  if (p.endsWith(".sh") || p.endsWith(".bash") || p.endsWith(".zsh")) return "shell";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".go")) return "go";
  if (p.endsWith(".rs")) return "rust";
  if (p.endsWith(".java")) return "java";
  if (p.endsWith(".xml") || p.endsWith(".svg")) return "xml";
  return defaultLang;
}

// 辅助方法：规范化语言名称为 Monaco 支持的标准标识
export function normalizeMonacoLanguage(lang: string = ""): string {
  const clean = lang.trim().toLowerCase().replace(/^language-/, "");
  switch (clean) {
    case "js":
    case "jsx":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "py":
      return "python";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "yml":
      return "yaml";
    case "golang":
      return "go";
    case "md":
      return "markdown";
    case "sql":
      return "sql";
    case "json":
      return "json";
    case "html":
      return "html";
    case "vue":
      return "html";
    case "scss":
    case "less":
      return "css";
    case "xml":
    case "svg":
      return "xml";
    case "yaml":
      return "yaml";
    default:
      return clean || "plaintext";
  }
}

// 辅助方法：从原始代码与修改代码计算行数增删统计
export function calculateDiffStats(
  original: string,
  modified: string
): { additions: number; deletions: number } {
  if (original === modified) {
    return { additions: 0, deletions: 0 };
  }
  try {
    const changes = diffLines(original, modified);
    let additions = 0;
    let deletions = 0;
    for (const part of changes) {
      if (part.added) {
        additions += part.count || 0;
      } else if (part.removed) {
        deletions += part.count || 0;
      }
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

// 辅助方法：格式化当前时间为北京时间易读字符串
export function formatCurrentTime(): string {
  return new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// 辅助方法：浏览器降级下载文件
export function triggerFileDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "artifact.txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface CanvasState {
  isOpen: boolean;
  activeArtifactId: string | null;
  openTabIds: string[];
  artifacts: Record<string, CanvasArtifact>;
  viewMode: CanvasViewMode;
  diffLayout: CanvasDiffLayout;
  compareSnapshotIndex: number | null; // 对比的目标快照索引，null 时默认对比原始版本(v1)
  drawerWidth: CanvasDrawerWidth;
  customWidthPx: number;
  isReadOnly: boolean;
  isWordWrap: boolean;
  isMinimap: boolean;
  isFileTreeOpen: boolean;

  // 动作定义
  openArtifact: (params: {
    id?: string;
    title?: string;
    language?: string;
    filePath?: string;
    content: string;
    sessionId?: string;
    messageId?: string;
    description?: string;
  }) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setMdViewMode: (mode: "preview" | "editor" | "split", id?: string) => void;
  acceptDiff: (id?: string) => void;
  revertDiff: (id?: string) => void;
  toggleFileTree: () => void;
  setFileTreeOpen: (open: boolean) => void;
  closeCanvas: () => void;
  toggleFullscreen: () => void;
  setDrawerWidth: (width: CanvasDrawerWidth) => void;
  setCustomWidthPx: (width: number) => void;
  setViewMode: (mode: CanvasViewMode) => void;
  setDiffLayout: (layout: CanvasDiffLayout) => void;
  setCompareSnapshotIndex: (index: number | null) => void;
  updateCurrentContent: (content: string) => void;
  updateFilePath: (filePath: string) => void;
  updateTitle: (title: string) => void;
  createSnapshot: (description?: string) => void;
  restoreSnapshot: (index: number) => void;
  setIsReadOnly: (readOnly: boolean) => void;
  toggleWordWrap: () => void;
  toggleMinimap: () => void;
  getActiveArtifact: () => CanvasArtifact | null;
  markSaved: () => void;
  saveToLocalDisk: (projectId?: string | null) => Promise<CanvasDiskSaveResult>;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  isOpen: false,
  activeArtifactId: null,
  openTabIds: [],
  artifacts: {},
  viewMode: "editor",
  diffLayout: "split",
  compareSnapshotIndex: null,
  drawerWidth: "normal",
  customWidthPx: 260,
  isReadOnly: false,
  isWordWrap: true,
  isMinimap: false,
  isFileTreeOpen: true,

  toggleFileTree: () =>
    set((state) => ({ isFileTreeOpen: !state.isFileTreeOpen })),

  setFileTreeOpen: (isFileTreeOpen) => set({ isFileTreeOpen }),

  setActiveTab: (id) =>
    set((state) => {
      const currentTabs = state.openTabIds || [];
      const openTabIds = currentTabs.includes(id) ? currentTabs : [...currentTabs, id];
      return {
        isOpen: true,
        activeArtifactId: id,
        openTabIds,
      };
    }),

  closeTab: (id) =>
    set((state) => {
      const currentTabs = state.openTabIds || [];
      const remainingTabs = currentTabs.filter((t) => t !== id);
      let nextActiveId = state.activeArtifactId;

      if (state.activeArtifactId === id) {
        if (remainingTabs.length > 0) {
          const closedIndex = currentTabs.indexOf(id);
          const nextIndex = Math.min(closedIndex, remainingTabs.length - 1);
          nextActiveId = remainingTabs[nextIndex];
        } else {
          nextActiveId = null;
        }
      }

      return {
        openTabIds: remainingTabs,
        activeArtifactId: nextActiveId,
      };
    }),

  setMdViewMode: (mode, id) =>
    set((state) => {
      const targetId = id || state.activeArtifactId;
      if (!targetId || !state.artifacts[targetId]) return state;
      const current = state.artifacts[targetId];
      return {
        artifacts: {
          ...state.artifacts,
          [targetId]: {
            ...current,
            mdViewMode: mode,
          },
        },
      };
    }),

  acceptDiff: (id) =>
    set((state) => {
      const targetId = id || state.activeArtifactId;
      if (!targetId || !state.artifacts[targetId]) return state;
      const current = state.artifacts[targetId];
      const newVersion = current.snapshots.length + 1;
      const lines = current.currentContent.split("\n").length;
      const newSnapshot: CanvasSnapshot = {
        id: `snap_${Date.now()}_${newVersion}`,
        version: newVersion,
        content: current.currentContent,
        timestamp: formatCurrentTime(),
        description: `接受更改 Accept (v${newVersion})`,
        linesCount: lines,
        additions: 0,
        deletions: 0,
      };

      return {
        viewMode: "editor",
        compareSnapshotIndex: null,
        artifacts: {
          ...state.artifacts,
          [targetId]: {
            ...current,
            originalContent: current.currentContent,
            isDirty: false,
            hasDiff: false,
            snapshots: [...current.snapshots, newSnapshot],
            currentVersionIndex: current.snapshots.length,
          },
        },
      };
    }),

  revertDiff: (id) =>
    set((state) => {
      const targetId = id || state.activeArtifactId;
      if (!targetId || !state.artifacts[targetId]) return state;
      const current = state.artifacts[targetId];

      return {
        viewMode: "editor",
        compareSnapshotIndex: null,
        artifacts: {
          ...state.artifacts,
          [targetId]: {
            ...current,
            currentContent: current.originalContent,
            isDirty: false,
            hasDiff: false,
          },
        },
      };
    }),

  openArtifact: (params) => {
    let title = params.title || "";
    let filePath = params.filePath || "";
    const inferred = inferLanguageFromPath(filePath || title || "");
    const rawLang = params.language || inferred;
    const normalizedLang = normalizeMonacoLanguage(rawLang);

    if (!title && filePath) {
      title = filePath.split("/").pop() || filePath;
    } else if (!title) {
      const extMap: Record<string, string> = {
        typescript: "artifact.ts",
        javascript: "artifact.js",
        python: "main.py",
        sql: "query.sql",
        json: "config.json",
        markdown: "document.md",
        html: "index.html",
        css: "style.css",
        shell: "script.sh",
        rust: "main.rs",
        go: "main.go",
      };
      title = extMap[normalizedLang] || "snippet.txt";
    }

    if (!filePath) {
      filePath = title;
    }

    const isMd =
      normalizedLang === "markdown" ||
      filePath.toLowerCase().endsWith(".md") ||
      title.toLowerCase().endsWith(".md");

    set((state) => {
      // 智能识别现有 Artifact：优先 params.id，其次匹配 filePath，再次匹配 title
      let targetId = params.id || null;
      if (!targetId) {
        const foundEntry = Object.entries(state.artifacts).find(([, art]) => {
          if (filePath && art.filePath === filePath) return true;
          if (title && art.title === title) return true;
          return false;
        });
        if (foundEntry) {
          targetId = foundEntry[0];
        }
      }

      if (!targetId) {
        targetId = `art_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      }

      const currentTabs = state.openTabIds || [];
      const updatedTabIds = currentTabs.includes(targetId)
        ? currentTabs
        : [...currentTabs, targetId];

      const existing = state.artifacts[targetId];
      if (existing) {
        // 如果内容完全一致，仅激活并置顶
        if (existing.currentContent === params.content) {
          return {
            isOpen: true,
            activeArtifactId: targetId,
            openTabIds: updatedTabIds,
          };
        }

        // 如果用户在画布中有未保存脏修改，先将草稿存入快照防止修改丢失
        const snapshots = [...existing.snapshots];
        if (existing.isDirty) {
          const draftVer = snapshots.length + 1;
          const draftPrev =
            snapshots[snapshots.length - 1]?.content || existing.originalContent;
          const draftStats = calculateDiffStats(draftPrev, existing.currentContent);
          snapshots.push({
            id: `snap_${Date.now()}_draft_${draftVer}`,
            version: draftVer,
            content: existing.currentContent,
            timestamp: formatCurrentTime(),
            description: `画布本地编辑草稿 (v${draftVer})`,
            linesCount: existing.currentContent.split("\n").length,
            additions: draftStats.additions,
            deletions: draftStats.deletions,
          });
        }

        const lines = params.content.split("\n").length;
        const prevContent =
          snapshots[snapshots.length - 1]?.content || existing.originalContent;
        const stats = calculateDiffStats(prevContent, params.content);
        const newVersion = snapshots.length + 1;
        const newSnapshot: CanvasSnapshot = {
          id: `snap_${Date.now()}_${newVersion}`,
          version: newVersion,
          content: params.content,
          timestamp: formatCurrentTime(),
          description:
            params.description || `AI 更新 (v${newVersion})`,
          linesCount: lines,
          additions: stats.additions,
          deletions: stats.deletions,
        };

        const updated: CanvasArtifact = {
          ...existing,
          title: title || existing.title,
          filePath: filePath || existing.filePath,
          language: normalizedLang || existing.language,
          currentContent: params.content,
          snapshots: [...snapshots, newSnapshot],
          currentVersionIndex: snapshots.length,
          isDirty: true,
          hasDiff: true,
          mdViewMode: existing.mdViewMode || (isMd ? "preview" : undefined),
          sessionId: params.sessionId || existing.sessionId,
          messageId: params.messageId || existing.messageId,
        };

        return {
          isOpen: true,
          activeArtifactId: targetId,
          openTabIds: updatedTabIds,
          artifacts: {
            ...state.artifacts,
            [targetId]: updated,
          },
        };
      }

      // 初始化全新 Artifact
      const lines = params.content.split("\n").length;
      const initialSnapshot: CanvasSnapshot = {
        id: `snap_${Date.now()}_1`,
        version: 1,
        content: params.content,
        timestamp: formatCurrentTime(),
        description: params.description || "初始版本 (从对话生成)",
        linesCount: lines,
        additions: lines,
        deletions: 0,
      };

      const newArtifact: CanvasArtifact = {
        id: targetId,
        title,
        language: normalizedLang,
        filePath,
        currentContent: params.content,
        originalContent: params.content,
        snapshots: [initialSnapshot],
        currentVersionIndex: 0,
        isDirty: false,
        hasDiff: false,
        mdViewMode: isMd ? "preview" : undefined,
        sessionId: params.sessionId,
        messageId: params.messageId,
        lastSavedAt: undefined,
      };

      return {
        isOpen: true,
        activeArtifactId: targetId,
        openTabIds: updatedTabIds,
        artifacts: {
          ...state.artifacts,
          [targetId]: newArtifact,
        },
      };
    });
  },

  closeCanvas: () => set({ isOpen: false }),

  toggleFullscreen: () =>
    set((state) => ({
      drawerWidth: state.drawerWidth === "fullscreen" ? "normal" : "fullscreen",
    })),

  setDrawerWidth: (drawerWidth) => set({ drawerWidth }),

  setCustomWidthPx: (customWidthPx) =>
    set({ customWidthPx: Math.max(260, Math.min(1400, customWidthPx)) }),

  setViewMode: (viewMode) => set({ viewMode }),

  setDiffLayout: (diffLayout) => set({ diffLayout }),

  setCompareSnapshotIndex: (compareSnapshotIndex) =>
    set({ compareSnapshotIndex }),

  updateCurrentContent: (content) =>
    set((state) => {
      const { activeArtifactId, artifacts } = state;
      if (!activeArtifactId || !artifacts[activeArtifactId]) return state;

      const currentArtifact = artifacts[activeArtifactId];
      const activeSnapshot =
        currentArtifact.snapshots[currentArtifact.currentVersionIndex] ||
        currentArtifact.snapshots[0];
      const isDirty = activeSnapshot
        ? activeSnapshot.content !== content
        : content !== currentArtifact.originalContent;
      const hasDiff = content !== currentArtifact.originalContent;

      return {
        artifacts: {
          ...artifacts,
          [activeArtifactId]: {
            ...currentArtifact,
            currentContent: content,
            isDirty,
            hasDiff,
          },
        },
      };
    }),

  updateFilePath: (filePath) =>
    set((state) => {
      const { activeArtifactId, artifacts } = state;
      if (!activeArtifactId || !artifacts[activeArtifactId]) return state;
      const current = artifacts[activeArtifactId];
      const title = filePath.split("/").pop() || filePath;
      const ext = title.includes(".") ? title.split(".").pop() : "";
      const inferredLang = ext ? normalizeMonacoLanguage(ext) : current.language;
      return {
        artifacts: {
          ...artifacts,
          [activeArtifactId]: {
            ...current,
            filePath,
            title,
            language: inferredLang || current.language,
          },
        },
      };
    }),

  updateTitle: (title) =>
    set((state) => {
      const { activeArtifactId, artifacts } = state;
      if (!activeArtifactId || !artifacts[activeArtifactId]) return state;
      const current = artifacts[activeArtifactId];
      return {
        artifacts: {
          ...artifacts,
          [activeArtifactId]: {
            ...current,
            title,
          },
        },
      };
    }),

  createSnapshot: (description) =>
    set((state) => {
      const { activeArtifactId, artifacts } = state;
      if (!activeArtifactId || !artifacts[activeArtifactId]) return state;

      const current = artifacts[activeArtifactId];
      const newVersion = current.snapshots.length + 1;
      const lines = current.currentContent.split("\n").length;
      const prevSnapshot = current.snapshots[current.snapshots.length - 1];
      const prevContent = prevSnapshot ? prevSnapshot.content : current.originalContent;
      const stats = calculateDiffStats(
        prevContent,
        current.currentContent
      );

      const snapshot: CanvasSnapshot = {
        id: `snap_${Date.now()}_${newVersion}`,
        version: newVersion,
        content: current.currentContent,
        timestamp: formatCurrentTime(),
        description: description || `快照版本 v${newVersion} (手动保存)`,
        linesCount: lines,
        additions: stats.additions,
        deletions: stats.deletions,
      };

      return {
        artifacts: {
          ...artifacts,
          [activeArtifactId]: {
            ...current,
            snapshots: [...current.snapshots, snapshot],
            currentVersionIndex: current.snapshots.length,
            isDirty: false,
          },
        },
      };
    }),

  restoreSnapshot: (index) =>
    set((state) => {
      const { activeArtifactId, artifacts } = state;
      if (!activeArtifactId || !artifacts[activeArtifactId]) return state;

      const current = artifacts[activeArtifactId];
      const targetSnapshot = current.snapshots[index];
      if (!targetSnapshot) return state;

      return {
        artifacts: {
          ...artifacts,
          [activeArtifactId]: {
            ...current,
            currentContent: targetSnapshot.content,
            currentVersionIndex: index,
            isDirty: false,
            hasDiff: targetSnapshot.content !== current.originalContent,
          },
        },
      };
    }),

  setIsReadOnly: (isReadOnly) => set({ isReadOnly }),

  toggleWordWrap: () => set((state) => ({ isWordWrap: !state.isWordWrap })),

  toggleMinimap: () => set((state) => ({ isMinimap: !state.isMinimap })),

  getActiveArtifact: () => {
    const { activeArtifactId, artifacts } = get();
    if (!activeArtifactId) return null;
    return artifacts[activeArtifactId] || null;
  },

  markSaved: () =>
    set((state) => {
      const { activeArtifactId, artifacts } = state;
      if (!activeArtifactId || !artifacts[activeArtifactId]) return state;
      const current = artifacts[activeArtifactId];
      return {
        artifacts: {
          ...artifacts,
          [activeArtifactId]: {
            ...current,
            originalContent: current.currentContent,
            isDirty: false,
            hasDiff: false,
            lastSavedAt: formatCurrentTime(),
          },
        },
      };
    }),

  saveToLocalDisk: async (projectId) => {
    const artifact = get().getActiveArtifact();
    if (!artifact) {
      return { success: false, message: "当前无可保存的画布文件" };
    }

    const targetKey = projectId || "genesis-default-workspace";

    // 1. 尝试直接获取本地工作区句柄 (优先 targetKey，未找到时尝试默认 workspace)
    try {
      let handle = await getDirectoryHandle(targetKey);
      if (!handle && targetKey !== "genesis-default-workspace") {
        handle = await getDirectoryHandle("genesis-default-workspace");
      }

      if (handle) {
        const hasPermission = await verifyPermission(handle, true);
        if (hasPermission) {
          await writeLocalFile(
            handle,
            artifact.filePath || artifact.title,
            artifact.currentContent
          );
          get().markSaved();
          get().createSnapshot(`已写回磁盘 (${artifact.filePath || artifact.title})`);
          return {
            success: true,
            message: `成功写回本地磁盘 [${handle.name}]: ${artifact.filePath || artifact.title}`,
          };
        }
      }
    } catch (err: unknown) {
      console.warn("直接写入本地磁盘遇到异常，尝试唤醒目录选择器:", err);
    }

    // 2. 如果尚未关联或无权限，且浏览器支持 showDirectoryPicker，则唤起目录选择
    if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
      try {
        const pickerHandle: FileSystemDirectoryHandle = await (
          window as Window & {
            showDirectoryPicker: (options?: {
              mode?: "read" | "readwrite";
            }) => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker({ mode: "readwrite" });

        if (pickerHandle) {
          // 持久化保存至 IndexedDB，后续写回直接复用
          await saveDirectoryHandle(targetKey, pickerHandle);
          if (targetKey !== "genesis-default-workspace") {
            await saveDirectoryHandle("genesis-default-workspace", pickerHandle);
          }

          await writeLocalFile(
            pickerHandle,
            artifact.filePath || artifact.title,
            artifact.currentContent
          );
          get().markSaved();
          get().createSnapshot(`已写回磁盘 (${artifact.filePath || artifact.title})`);
          return {
            success: true,
            message: `成功保存至文件夹 [${pickerHandle.name}]: ${
              artifact.filePath || artifact.title
            }`,
          };
        }
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          err.name === "AbortError"
        ) {
          return { success: false, message: "用户取消了保存操作" };
        }
      }
    }

    // 3. 终极容错降级：触发文件流下载
    triggerFileDownload(
      artifact.filePath.split("/").pop() || artifact.title,
      artifact.currentContent
    );
    get().markSaved();
    return {
      success: true,
      message: `已自动触发本地下载: ${artifact.title}`,
      isFallbackDownload: true,
    };
  },
}));
