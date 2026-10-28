import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useCanvasStore } from "./useCanvasStore";
import { useUIStore } from "./useUIStore";
import { deleteTerminalSession } from "@/lib/api/terminal";

export type WorkbenchTabKind =
  | "new-tab"
  | "file-explorer"
  | "changes"
  | "terminal"
  | "browser"
  | "subagent-panel";

export interface NewTabConfig {
  id: string;
  kind: "new-tab";
  title: string;
  closable?: boolean;
}

export interface FileExplorerTabConfig {
  id: string;
  kind: "file-explorer";
  title: string;
  selectedFilePath: string | null;
  artifactId: string | null;
  closable?: boolean;
}

export interface DiffFileItem {
  path: string;
  name: string;
  additions: number;
  deletions: number;
  originalContent: string;
  modifiedContent: string;
  unifiedDiff?: string;
}

export interface ChangesTabConfig {
  id: string;
  kind: "changes";
  title: string; // 默认 "变更"
  activeTurnIndex: number; // 对标截图「上一轮 ⌵」
  selectedFilePath: string | null;
  totalAdditions: number;
  totalDeletions: number;
  diffFiles: DiffFileItem[];
  closable?: boolean;
}

export interface TerminalTabConfig {
  id: string;
  kind: "terminal";
  title: string;
  sessionId: string;
  closable?: boolean;
}

export interface BrowserTabConfig {
  id: string;
  kind: "browser";
  title: string;
  url: string; // "genesis://newtab" 或真实网络 URL
  closable?: boolean;
}

export interface SubagentStep {
  index: number;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  status: "running" | "done";
  preview?: string;
  thinking?: string;
  timestamp: string;
}

export interface SubagentInstance {
  id: string;
  agentType: "explore" | "verify";
  displayName: string;
  taskPrompt: string;
  status: "running" | "completed" | "failed";
  steps: SubagentStep[];
  summary?: string;
  thinkingContent?: string;
  createdAt: string;
}

export interface SubagentPanelTabConfig {
  id: string;
  kind: "subagent-panel";
  title: string;
  agents: SubagentInstance[];
  activeAgentId: string | null;
  closable?: boolean;
}

export type WorkbenchTab =
  | NewTabConfig
  | FileExplorerTabConfig
  | ChangesTabConfig
  | TerminalTabConfig
  | BrowserTabConfig
  | SubagentPanelTabConfig;

function extractTaskFocus(taskPrompt: string): string | null {
  if (!taskPrompt) return null;
  // 1. 尝试从 prompt 中提取具体文件名（如 package.json, pyproject.toml, requirements.txt, tsconfig.json 等）
  const fileMatch = taskPrompt.match(/[a-zA-Z0-9_.-]+\.(?:json|toml|txt|ts|tsx|js|jsx|py|yaml|yml)/i);
  if (fileMatch && fileMatch[0].length < 24) {
    return fileMatch[0];
  }
  // 2. 尝试从 prompt 中提取路径（如 components/chat, api/services, Genesis/web 等）
  const pathMatch = taskPrompt.match(/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?/);
  if (pathMatch) {
    const parts = pathMatch[0].split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart.length < 20) {
      return lastPart.replace(/\.[^/.]+$/, "");
    }
  }
  // 3. 尝试从括号或引号中提取重点词
  const bracketMatch = taskPrompt.match(/[【「“"']([^【】「」“”"'\s]{2,10})[】」”"']/);
  if (bracketMatch && bracketMatch[1]) {
    return bracketMatch[1];
  }
  // 4. 常见功能模块词检测
  const lower = taskPrompt.toLowerCase();
  const keywords = [
    { k: "前端依赖", label: "前端依赖" },
    { k: "后端依赖", label: "后端依赖" },
    { k: "前端", label: "前端" },
    { k: "后端", label: "后端" },
    { k: "路由", label: "路由" },
    { k: "状态", label: "状态管理" },
    { k: "组件", label: "组件" },
    { k: "鉴权", label: "鉴权" },
    { k: "auth", label: "Auth" },
    { k: "chat", label: "Chat" },
    { k: "workbench", label: "工作台" },
    { k: "terminal", label: "终端" },
    { k: "preview", label: "预览" },
    { k: "database", label: "数据库" },
    { k: "中间件", label: "中间件" },
  ];
  for (const item of keywords) {
    if (lower.includes(item.k)) return item.label;
  }
  return null;
}

export function inferAgentDisplayName(
  agentType: string,
  taskPrompt: string,
  existingAgents: { displayName?: string; id?: string }[] = [],
  currentAgentId?: string
): string {
  const prompt = (taskPrompt || "").toLowerCase();
  let baseName = "🔍 代码库探索者";

  if (agentType === "verify") {
    if (prompt.includes("test") || prompt.includes("测试")) baseName = "✅ 测试验证工程师";
    else if (prompt.includes("性能") || prompt.includes("performance")) baseName = "✅ 性能诊断工程师";
    else if (prompt.includes("bug") || prompt.includes("error") || prompt.includes("debug") || prompt.includes("排查")) baseName = "✅ 问题排查工程师";
    else baseName = "✅ 运行验证工程师";
  } else {
    // explore
    if (prompt.includes("前端") || prompt.includes("frontend") || prompt.includes("component") || prompt.includes("组件") || prompt.includes("页面")) baseName = "🔍 前端架构分析师";
    else if (prompt.includes("后端") || prompt.includes("backend") || prompt.includes("api") || prompt.includes("server") || prompt.includes("服务")) baseName = "🔍 后端架构分析师";
    else if (prompt.includes("数据库") || prompt.includes("database") || prompt.includes("schema") || prompt.includes("sql")) baseName = "🔍 数据模型分析师";
    else if (prompt.includes("依赖") || prompt.includes("dependency") || prompt.includes("package")) baseName = "🔍 依赖关系分析师";
    else if (prompt.includes("配置") || prompt.includes("config") || prompt.includes("deploy") || prompt.includes("部署")) baseName = "🔍 配置架构分析师";
    else if (prompt.includes("样式") || prompt.includes("css") || prompt.includes("style") || prompt.includes("ui")) baseName = "🔍 UI/UX 分析师";
  }

  // 检查已有列表中是否有重名（排除自身）
  const others = existingAgents.filter((a) => !currentAgentId || a.id !== currentAgentId);
  const nameCollision = others.some(
    (a) => a.displayName === baseName || (a.displayName && a.displayName.startsWith(baseName))
  );

  if (!nameCollision) {
    return baseName;
  }

  // 发生同名冲突时，提取任务焦点进行组合消歧
  const focus = extractTaskFocus(taskPrompt);
  if (focus) {
    const candidate = `${baseName} · ${focus}`;
    if (!others.some((a) => a.displayName === candidate)) {
      return candidate;
    }
  }

  // 若无特征词或依然重名，自动递增数字序号消歧
  let counter = 1;
  while (others.some((a) => a.displayName === `${baseName} #${counter}`)) {
    counter++;
  }
  return `${baseName} #${counter}`;
}

export interface SessionWorkbenchData {
  tabs: WorkbenchTab[];
  activeTabId: string;
  activeSection: "files" | "browser" | "terminal" | "changes";
  selectedFilePath: string | null;
  previewUrl: string;
  allDiffFiles: DiffFileItem[];
  cachedSubagents?: SubagentInstance[];
}

export function createDefaultSessionWorkbench(
  prefix: string = "tab-file"
): SessionWorkbenchData {
  const fileTabId = `${prefix}-${Date.now()}`;
  return {
    tabs: [
      {
        id: fileTabId,
        kind: "file-explorer",
        title: "文件",
        selectedFilePath: null,
        artifactId: null,
        closable: true,
      },
    ],
    activeTabId: fileTabId,
    activeSection: "files",
    selectedFilePath: null,
    previewUrl: "genesis://newtab",
    allDiffFiles: [],
    cachedSubagents: [],
  };
}

/**
 * 从会话的历史消息中提取并恢复所有已调度的子代理及其执行分析结果
 */
export function extractSubagentsFromMessages(sessionId: string): SubagentInstance[] {
  let messages: any[] = [];
  try {
    const { useChatStore } = require("./useChatStore");
    messages = useChatStore.getState().messagesBySession[sessionId] || [];
  } catch {
    messages = [];
  }

  const result: SubagentInstance[] = [];

  for (const m of messages) {
    if (!m.raw_tool_calls || !Array.isArray(m.raw_tool_calls)) continue;
    for (const tc of m.raw_tool_calls) {
      if (tc.name && tc.name.includes("dispatch_subagent")) {
        const rawId = tc.id || "";
        const agentId = rawId ? (rawId.startsWith("agent-") ? rawId : `agent-${rawId}`) : `agent-${Date.now()}`;
        if (result.some((a) => a.id === agentId)) continue;

        const agentType = (tc.args?.agent_type === "verify" ? "verify" : "explore") as "explore" | "verify";
        const taskPrompt = typeof tc.args?.task_prompt === "string" ? tc.args.task_prompt : "";
        const displayName = inferAgentDisplayName(agentType, taskPrompt, result, agentId);

        let summary: string | undefined = undefined;
        let steps: SubagentStep[] = [];
        let thinkingContent: string | undefined = undefined;

        if (tc.output) {
          let outObj: any = tc.output;
          if (typeof outObj === "string") {
            try {
              outObj = JSON.parse(outObj);
            } catch {
              outObj = { summary: tc.output };
            }
          }
          if (typeof outObj === "object" && outObj !== null) {
            summary = outObj.summary || outObj.result || (outObj.success === false ? outObj.error : undefined);
            if (Array.isArray(outObj.steps)) {
              steps = outObj.steps;
            }
            if (outObj.thinking) {
              thinkingContent = String(outObj.thinking);
            }
          }
        }

        result.push({
          id: agentId,
          agentType,
          displayName,
          taskPrompt,
          status: tc.status === "failed" ? "failed" : "completed",
          steps,
          summary,
          thinkingContent,
          createdAt: m.created_at || new Date().toISOString(),
        });
      }
    }
  }

  return result;
}

interface WorkbenchState {
  // 当前处于活动态的 session ID（未进入具体 session 时如 /chat 首页为 "draft"）
  activeSessionId: string;
  // 会话隔离的右侧工作台数据映射表
  workbenchBySession: Record<string, SessionWorkbenchData>;

  // 当前激活会话的映射属性（向后兼容组件直接解构使用）
  activeSection: "files" | "browser" | "terminal" | "changes";
  selectedFilePath: string | null;
  tabs: WorkbenchTab[];
  activeTabId: string;
  previewUrl: string;
  allDiffFiles: DiffFileItem[];

  // 窗口全局布局属性 (全局共享)
  isFileTreeVisible: boolean;
  isFullscreen: boolean;
  isMaximized: boolean;
  savedWidthBeforeMaximize: number;
  reloadTrigger: number;

  // 会话工作台切换与生命周期管理
  switchSessionWorkbench: (sessionId: string | null) => void;
  deleteSessionWorkbench: (sessionId: string) => void;
  migrateDraftWorkbench: (newSessionId: string) => void;

  // 浏览器预览与热重载状态
  setPreviewUrl: (
    url: string,
    autoSwitchTab?: boolean,
    targetSessionId?: string
  ) => void;
  triggerPreviewReload: () => void;

  // 基础 Section / Tab 管理
  setActiveSection: (section: "files" | "browser" | "terminal" | "changes") => void;
  setActiveTabId: (id: string, sessionId?: string) => void;
  openTab: (tab: WorkbenchTab) => void;
  closeTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<WorkbenchTab>) => void;
  toggleFileTree: () => void;
  toggleFullscreen: () => void;
  toggleMaximize: () => void;
  setIsMaximized: (val: boolean) => void;
  setSavedWidthBeforeMaximize: (w: number) => void;
  reorderTabs: (sourceIndex: number, targetIndex: number) => void;

  openNewTab: () => void;
  switchNewTabToTool: (
    tabId: string,
    tool: "file-explorer" | "terminal" | "browser" | "subagent-panel"
  ) => void;
  openNewFileTab: () => void;
  openNewBrowserTab: (url?: string, title?: string) => void;
  openTerminalTab: (sessionId?: string, title?: string) => void;
  openChangesTab: (
    params?: {
      turnIndex?: number;
      diffFiles?: DiffFileItem[];
      selectedFilePath?: string;
    },
    autoSwitchTab?: boolean,
    targetSessionId?: string
  ) => void;
  recordFileDiff: (file: DiffFileItem, targetSessionId?: string) => void;
  removeFileDiff: (paths: string[], targetSessionId?: string) => void;
  openFileInExplorer: (params: {
    id?: string;
    filePath: string;
    title?: string;
    content?: string;
    language?: string;
    createAsNewTab?: boolean;
  }) => void;
  resetFileExplorerTab: () => void;
  // Subagent panel methods
  openSubagentPanel: (sessionId?: string) => string;
  addAgentInstance: (
    agentId: string,
    agentType: "explore" | "verify",
    taskPrompt: string,
    sessionId?: string
  ) => void;
  updateAgentInstance: (
    agentId: string,
    updates: Partial<SubagentInstance>,
    sessionId?: string
  ) => void;
  addAgentStep: (agentId: string, step: SubagentStep, sessionId?: string) => void;
  setActiveAgent: (agentId: string | null, sessionId?: string) => void;
}

const DEFAULT_INITIAL_SESSION = "draft";
const initialDefaultData = createDefaultSessionWorkbench(DEFAULT_INITIAL_SESSION);

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set, get) => {
      // 内部辅助方法：修改指定或当前 session 的 workbench 数据，并联动更新顶层兼容属性
      const mutateSession = (
        updater: (data: SessionWorkbenchData) => Partial<SessionWorkbenchData>,
        explicitSid?: string
      ) => {
        set((state) => {
          const sid = explicitSid || state.activeSessionId || DEFAULT_INITIAL_SESSION;
          const current =
            state.workbenchBySession[sid] ||
            createDefaultSessionWorkbench(sid);
          const partial = updater(current);
          const updated: SessionWorkbenchData = { ...current, ...partial };
          const nextMap = {
            ...state.workbenchBySession,
            [sid]: updated,
          };
          // 若修改的是当前活跃会话，同步顶层兼容属性以触发组件响应
          if (sid === (state.activeSessionId || DEFAULT_INITIAL_SESSION)) {
            return {
              workbenchBySession: nextMap,
              tabs: updated.tabs,
              activeTabId: updated.activeTabId,
              activeSection: updated.activeSection,
              selectedFilePath: updated.selectedFilePath,
              previewUrl: updated.previewUrl,
              allDiffFiles: updated.allDiffFiles,
            };
          }
          return {
            workbenchBySession: nextMap,
          };
        });
      };

      return {
        activeSessionId: DEFAULT_INITIAL_SESSION,
        workbenchBySession: {
          [DEFAULT_INITIAL_SESSION]: initialDefaultData,
        },

        activeSection: initialDefaultData.activeSection,
        selectedFilePath: initialDefaultData.selectedFilePath,
        previewUrl: initialDefaultData.previewUrl,
        reloadTrigger: 0,
        allDiffFiles: initialDefaultData.allDiffFiles,
        tabs: initialDefaultData.tabs,
        activeTabId: initialDefaultData.activeTabId,
        isFileTreeVisible: true,
        isFullscreen: false,
        isMaximized: false,
        savedWidthBeforeMaximize: 260,

        switchSessionWorkbench: (sessionId: string | null) => {
          const targetId = sessionId || DEFAULT_INITIAL_SESSION;
          const { activeSessionId, workbenchBySession } = get();
          if (activeSessionId === targetId && workbenchBySession[targetId]) {
            return;
          }
          let existing =
            workbenchBySession[targetId] ||
            createDefaultSessionWorkbench(targetId);
          if (
            existing.tabs.length === 1 &&
            existing.tabs[0].kind === "new-tab"
          ) {
            const fileTabId = `tab-file-${Date.now()}`;
            existing = {
              ...existing,
              tabs: [
                {
                  id: fileTabId,
                  kind: "file-explorer",
                  title: "文件",
                  selectedFilePath: null,
                  artifactId: null,
                  closable: true,
                },
              ],
              activeTabId: fileTabId,
              activeSection: "files",
            };
          }
          set((state) => ({
            activeSessionId: targetId,
            workbenchBySession: {
              ...state.workbenchBySession,
              [targetId]: existing,
            },
            tabs: existing.tabs,
            activeTabId: existing.activeTabId,
            activeSection: existing.activeSection,
            selectedFilePath: existing.selectedFilePath,
            previewUrl: existing.previewUrl,
            allDiffFiles: existing.allDiffFiles,
          }));
        },

        deleteSessionWorkbench: (sessionId: string) => {
          set((state) => {
            const nextMap = { ...state.workbenchBySession };
            delete nextMap[sessionId];
            return { workbenchBySession: nextMap };
          });
        },

        migrateDraftWorkbench: (newSessionId: string) => {
          if (!newSessionId || newSessionId === DEFAULT_INITIAL_SESSION) return;
          set((state) => {
            const draftData = state.workbenchBySession[DEFAULT_INITIAL_SESSION];
            if (draftData) {
              const targetData = state.workbenchBySession[newSessionId] || draftData;
              const nextMap = {
                ...state.workbenchBySession,
                [newSessionId]: targetData,
              };
              delete nextMap[DEFAULT_INITIAL_SESSION];
              return {
                activeSessionId: newSessionId,
                workbenchBySession: nextMap,
                tabs: targetData.tabs,
                activeTabId: targetData.activeTabId,
                activeSection: targetData.activeSection,
                selectedFilePath: targetData.selectedFilePath,
                previewUrl: targetData.previewUrl,
                allDiffFiles: targetData.allDiffFiles,
              };
            }
            return {};
          });
        },

        setActiveSection: (activeSection) => {
          mutateSession(() => ({ activeSection }));
        },

        setActiveTabId: (id, targetSessionId) => {
          if (targetSessionId && get().activeSessionId !== targetSessionId) {
            get().switchSessionWorkbench(targetSessionId);
          }
          mutateSession((data) => {
            const target = data.tabs.find((t) => t.id === id);
            let section = data.activeSection;
            if (target) {
              if (target.kind === "file-explorer") section = "files";
              else if (target.kind === "browser") section = "browser";
              else if (target.kind === "terminal") section = "terminal";
              else if (target.kind === "changes") section = "changes";
            }
            return { activeTabId: id, activeSection: section };
          }, targetSessionId);
        },

        toggleFileTree: () =>
          set((s) => ({ isFileTreeVisible: !s.isFileTreeVisible })),
        toggleFullscreen: () =>
          set((s) => ({ isFullscreen: !s.isFullscreen })),
        toggleMaximize: () =>
          set((s) => ({ isMaximized: !s.isMaximized })),
        setIsMaximized: (val) => set({ isMaximized: val }),
        setSavedWidthBeforeMaximize: (w) =>
          set({ savedWidthBeforeMaximize: w }),

        reorderTabs: (sourceIndex, targetIndex) => {
          if (
            sourceIndex === targetIndex ||
            sourceIndex < 0 ||
            targetIndex < 0
          )
            return;
          mutateSession((data) => {
            const newTabs = [...data.tabs];
            const [moved] = newTabs.splice(sourceIndex, 1);
            newTabs.splice(targetIndex, 0, moved);
            return { tabs: newTabs };
          });
        },

        openTab: (tab) => {
          mutateSession((data) => {
            const existing = data.tabs.find((t) => t.id === tab.id);
            if (existing) {
              return { activeTabId: tab.id };
            }
            return {
              tabs: [...data.tabs, tab],
              activeTabId: tab.id,
            };
          });
        },

        closeTab: (id) => {
          const { tabs } = get();
          const targetTab = tabs.find((t) => t.id === id);

          // 关闭终端标签页时，彻底销毁终端会话并杀死其下所有进程
          if (
            targetTab &&
            targetTab.kind === "terminal" &&
            targetTab.sessionId
          ) {
            deleteTerminalSession(targetTab.sessionId).catch((err) => {
              console.warn("[closeTab] 终止终端进程失败或已关闭:", err);
            });
          }

          mutateSession((data) => {
            const targetIndex = data.tabs.findIndex((t) => t.id === id);
            const closingTab = data.tabs[targetIndex];
            const newTabs = data.tabs.filter((t) => t.id !== id);

            // 若关闭的是协作代理面板，必须将当前所有子代理记录完整缓存到 cachedSubagents 中，防止记录被物理销毁
            const extraUpdates: Partial<SessionWorkbenchData> = {};
            if (closingTab && closingTab.kind === "subagent-panel") {
              const panel = closingTab as SubagentPanelTabConfig;
              if (panel.agents && panel.agents.length > 0) {
                extraUpdates.cachedSubagents = panel.agents;
              }
            }

            // 如果全部关闭（或关闭了最后一个标签页），立即回退并展示干净的单「新标签页」
            if (newTabs.length === 0) {
              const fallbackTab: NewTabConfig = {
                id: `tab-new-${Date.now()}`,
                kind: "new-tab",
                title: "新标签页",
                closable: true,
              };
              return {
                ...extraUpdates,
                tabs: [fallbackTab],
                activeTabId: fallbackTab.id,
                selectedFilePath: null,
              };
            }

            let nextActiveId = data.activeTabId;
            if (data.activeTabId === id) {
              const nextIndex = Math.max(0, targetIndex - 1);
              nextActiveId = newTabs[nextIndex]?.id || newTabs[0]?.id || "";
            }

            return {
              ...extraUpdates,
              tabs: newTabs,
              activeTabId: nextActiveId,
            };
          });
        },

        updateTab: (id, updates) => {
          mutateSession((data) => ({
            tabs: data.tabs.map((tab) =>
              tab.id === id ? ({ ...tab, ...updates } as WorkbenchTab) : tab
            ),
          }));
        },

        openNewTab: () => {
          const newId = `tab-new-${Date.now()}`;
          const newTab: NewTabConfig = {
            id: newId,
            kind: "new-tab",
            title: "新标签页",
            closable: true,
          };
          get().openTab(newTab);
        },

        switchNewTabToTool: (
          tabId: string,
          tool: "file-explorer" | "terminal" | "browser" | "subagent-panel"
        ) => {
          mutateSession((data) => {
            if (tool === "file-explorer") {
              return {
                activeSection: "files",
                tabs: data.tabs.map((t) =>
                  t.id === tabId
                    ? {
                        id: tabId,
                        kind: "file-explorer" as const,
                        title: "文件",
                        selectedFilePath: null,
                        artifactId: null,
                        closable: true,
                      }
                    : t
                ),
              };
            } else if (tool === "terminal") {
              return {
                activeSection: "terminal",
                tabs: data.tabs.map((t) =>
                  t.id === tabId
                    ? {
                        id: tabId,
                        kind: "terminal" as const,
                        title: "终端",
                        sessionId: `term-${Date.now()}`,
                        closable: true,
                      }
                    : t
                ),
              };
            } else if (tool === "browser") {
              return {
                activeSection: "browser",
                tabs: data.tabs.map((t) =>
                  t.id === tabId
                    ? {
                        id: tabId,
                        kind: "browser" as const,
                        title: "浏览器",
                        url: "genesis://newtab",
                        closable: true,
                      }
                    : t
                ),
              };
            } else if (tool === "subagent-panel") {
              const sid = get().activeSessionId || DEFAULT_INITIAL_SESSION;
              let restoredAgents: SubagentInstance[] = data.cachedSubagents || [];
              if (restoredAgents.length === 0) {
                restoredAgents = extractSubagentsFromMessages(sid);
              }
              return {
                tabs: data.tabs.map((t) =>
                  t.id === tabId
                    ? {
                        id: tabId,
                        kind: "subagent-panel" as const,
                        title: "协作代理",
                        agents: restoredAgents,
                        activeAgentId: restoredAgents[0]?.id || null,
                        closable: true,
                      }
                    : t
                ),
                activeTabId: tabId,
                cachedSubagents: restoredAgents.length > 0 ? restoredAgents : data.cachedSubagents,
              };
            }
            return {};
          });
        },

        openNewFileTab: () => {
          const { tabs } = get();
          const emptyFileTab = tabs.find(
            (t) => t.kind === "file-explorer" && !t.selectedFilePath
          );
          if (emptyFileTab) {
            mutateSession(() => ({
              activeSection: "files",
              activeTabId: emptyFileTab.id,
              selectedFilePath: null,
            }));
            return;
          }
          const newTabId = `tab-file-${Date.now()}`;
          const newTab: FileExplorerTabConfig = {
            id: newTabId,
            kind: "file-explorer",
            title: "文件",
            selectedFilePath: null,
            artifactId: null,
            closable: true,
          };
          get().openTab(newTab);
          mutateSession(() => ({ activeSection: "files" }));
        },

        setPreviewUrl: (
          url: string,
          autoSwitchTab: boolean = true,
          targetSessionId?: string
        ) => {
          let targetTabId: string | null = null;
          let tabTitle = "浏览器";
          if (url && url !== "genesis://newtab") {
            try {
              const u = new URL(url);
              tabTitle = u.port ? `:${u.port}` : u.hostname || "预览";
            } catch {
              tabTitle = "预览";
            }
          }

          mutateSession((data) => {
            const exactTab = data.tabs.find(
              (t) => t.kind === "browser" && t.url === url
            );
            const activeTab = data.tabs.find((t) => t.id === data.activeTabId);
            const canReplaceActiveTab =
              activeTab &&
              (activeTab.kind === "new-tab" ||
                (activeTab.kind === "browser" &&
                  (!activeTab.url || activeTab.url === "genesis://newtab")));
            const anyBrowserTab = data.tabs.find((t) => t.kind === "browser");

            if (exactTab) {
              targetTabId = exactTab.id;
              return { previewUrl: url };
            } else if (canReplaceActiveTab && activeTab) {
              targetTabId = activeTab.id;
              return {
                previewUrl: url,
                tabs: data.tabs.map((t) =>
                  t.id === activeTab.id
                    ? { ...t, kind: "browser" as const, title: tabTitle, url }
                    : t
                ),
              };
            } else if (anyBrowserTab) {
              targetTabId = anyBrowserTab.id;
              return {
                previewUrl: url,
                tabs: data.tabs.map((t) =>
                  t.id === anyBrowserTab.id ? { ...t, url, title: tabTitle } : t
                ),
              };
            } else {
              const newTabId = `tab-browser-${Date.now()}`;
              targetTabId = newTabId;
              const newTab: BrowserTabConfig = {
                id: newTabId,
                kind: "browser",
                title: tabTitle,
                url,
                closable: true,
              };
              return {
                previewUrl: url,
                tabs: [...data.tabs, newTab],
              };
            }
          }, targetSessionId);

          if (autoSwitchTab && targetTabId) {
            const isCurrentSession =
              !targetSessionId ||
              targetSessionId === (get().activeSessionId || DEFAULT_INITIAL_SESSION);
            if (isCurrentSession) {
              mutateSession(() => ({
                activeSection: "browser",
                activeTabId: targetTabId!,
              }));
              useUIStore.getState().openRightSidebar("preview");
            }
          }
        },

        triggerPreviewReload: () => {
          set((state) => ({ reloadTrigger: state.reloadTrigger + 1 }));
        },

        openNewBrowserTab: (
          url = "genesis://newtab",
          title = "浏览器"
        ) => {
          const newTabId = `tab-browser-${Date.now()}`;
          const newTab: BrowserTabConfig = {
            id: newTabId,
            kind: "browser",
            title,
            url,
            closable: true,
          };
          mutateSession(() => ({
            activeSection: "browser",
            previewUrl: url,
          }));
          get().openTab(newTab);
        },

        openTerminalTab: (sessionId, title) => {
          const finalSessionId = sessionId || `term-${Date.now()}`;
          const finalTitle = title || "终端";
          const newTab: TerminalTabConfig = {
            id: `tab-term-${Date.now()}`,
            kind: "terminal",
            title: finalTitle,
            sessionId: finalSessionId,
            closable: true,
          };
          mutateSession(() => ({ activeSection: "terminal" }));
          get().openTab(newTab);
        },

        openChangesTab: (
          params,
          autoSwitchTab = true,
          targetSessionId?: string
        ) => {
          mutateSession((data) => {
            const existingChanges = data.tabs.find(
              (t) => t.kind === "changes"
            ) as ChangesTabConfig | undefined;

            const diffFiles =
              params?.diffFiles || existingChanges?.diffFiles || [];
            const totalAdditions = diffFiles.reduce(
              (acc, f) => acc + f.additions,
              0
            );
            const totalDeletions = diffFiles.reduce(
              (acc, f) => acc + f.deletions,
              0
            );
            const selectedFilePath =
              params?.selectedFilePath ||
              existingChanges?.selectedFilePath ||
              diffFiles[0]?.path ||
              null;

            if (existingChanges) {
              return {
                ...(autoSwitchTab
                  ? {
                      activeSection: "changes" as const,
                      activeTabId: existingChanges.id,
                    }
                  : {}),
                tabs: data.tabs.map((t) =>
                  t.id === existingChanges.id
                    ? {
                        ...t,
                        activeTurnIndex:
                          params?.turnIndex ?? existingChanges.activeTurnIndex,
                        diffFiles,
                        totalAdditions,
                        totalDeletions,
                        selectedFilePath,
                      }
                    : t
                ),
              };
            } else {
              const newTab: ChangesTabConfig = {
                id: "tab-changes",
                kind: "changes",
                title: "变更",
                activeTurnIndex: params?.turnIndex ?? 1,
                selectedFilePath,
                totalAdditions,
                totalDeletions,
                diffFiles,
                closable: true,
              };
              return {
                ...(autoSwitchTab
                  ? {
                      activeSection: "changes" as const,
                      activeTabId: newTab.id,
                    }
                  : {}),
                tabs: [...data.tabs, newTab],
              };
            }
          }, targetSessionId);
        },

        recordFileDiff: (file, targetSessionId) => {
          mutateSession((data) => {
            const idx = data.allDiffFiles.findIndex((f) => f.path === file.path);
            const nextFiles =
              idx >= 0
                ? data.allDiffFiles.map((f, i) => (i === idx ? file : f))
                : [...data.allDiffFiles, file];

            const existingChanges = data.tabs.find(
              (t) => t.kind === "changes"
            ) as ChangesTabConfig | undefined;

            if (existingChanges) {
              const totalAdditions = nextFiles.reduce(
                (acc, f) => acc + f.additions,
                0
              );
              const totalDeletions = nextFiles.reduce(
                (acc, f) => acc + f.deletions,
                0
              );
              return {
                allDiffFiles: nextFiles,
                tabs: data.tabs.map((t) =>
                  t.id === existingChanges.id
                    ? {
                        ...t,
                        diffFiles: nextFiles,
                        totalAdditions,
                        totalDeletions,
                      }
                    : t
                ),
              };
            } else {
              return { allDiffFiles: nextFiles };
            }
          }, targetSessionId);
        },

        removeFileDiff: (paths: string[], targetSessionId?: string) => {
          const pathSet = new Set(paths);
          mutateSession((data) => {
            const nextFiles = data.allDiffFiles.filter((f) => !pathSet.has(f.path));
            const totalAdditions = nextFiles.reduce(
              (acc, f) => acc + f.additions,
              0
            );
            const totalDeletions = nextFiles.reduce(
              (acc, f) => acc + f.deletions,
              0
            );

            return {
              allDiffFiles: nextFiles,
              tabs: data.tabs.map((t) =>
                t.kind === "changes"
                  ? {
                      ...t,
                      diffFiles: nextFiles,
                      totalAdditions,
                      totalDeletions,
                      selectedFilePath:
                        t.selectedFilePath && pathSet.has(t.selectedFilePath)
                          ? nextFiles[0]?.path || null
                          : t.selectedFilePath,
                    }
                  : t
              ),
            };
          }, targetSessionId);
        },

        openFileInExplorer: ({
          id,
          filePath,
          title,
          content,
          language,
          createAsNewTab,
        }) => {
          const { tabs, activeTabId } = get();
          const fileName = title || filePath.split("/").pop() || "未知文件";

          const canvas = useCanvasStore.getState();
          const artId = id || filePath || `art-${Date.now()}`;
          canvas.openArtifact({
            id: artId,
            title: fileName,
            filePath,
            content: content || "",
            language,
          });

          // 1. 如果已存在打开相同文件的 Tab 且未指定强制新建，直接激活
          if (!createAsNewTab) {
            const existing = tabs.find(
              (t) =>
                t.kind === "file-explorer" && t.selectedFilePath === filePath
            );
            if (existing) {
              mutateSession(() => ({
                activeSection: "files",
                activeTabId: existing.id,
                selectedFilePath: filePath,
              }));
              return;
            }
          }

          // 2. 如果未指定强制新建，且当前激活的是文件 Tab 或新标签页，在当前 Tab 原地切换文件
          const currentTab = tabs.find((t) => t.id === activeTabId);
          if (
            !createAsNewTab &&
            currentTab &&
            (currentTab.kind === "file-explorer" ||
              currentTab.kind === "new-tab")
          ) {
            mutateSession((data) => ({
              activeSection: "files",
              selectedFilePath: filePath,
              tabs: data.tabs.map((t) =>
                t.id === currentTab.id
                  ? {
                      ...t,
                      kind: "file-explorer" as const,
                      title: fileName,
                      selectedFilePath: filePath,
                      artifactId: artId,
                      closable: true,
                    }
                  : t
              ),
            }));
            return;
          }

          // 3. 否则创建新文件 Tab
          const newTabId = `tab-file-${Date.now()}`;
          const newTab: FileExplorerTabConfig = {
            id: newTabId,
            kind: "file-explorer",
            title: fileName,
            selectedFilePath: filePath,
            artifactId: artId,
            closable: true,
          };
          get().openTab(newTab);
          mutateSession(() => ({
            activeSection: "files",
            selectedFilePath: filePath,
          }));
        },

        resetFileExplorerTab: () => {
          mutateSession((data) => ({
            selectedFilePath: null,
            tabs: data.tabs.map((t) =>
              t.kind === "file-explorer"
                ? {
                    ...t,
                    title: "文件",
                    selectedFilePath: null,
                    artifactId: null,
                  }
                : t
            ),
          }));
        },

        openSubagentPanel: (sessionId) => {
          if (sessionId && get().activeSessionId !== sessionId) {
            get().switchSessionWorkbench(sessionId);
          }
          const sid = sessionId || get().activeSessionId || DEFAULT_INITIAL_SESSION;
          const currentData =
            get().workbenchBySession[sid] ||
            createDefaultSessionWorkbench(sid);
          const existingPanel = currentData.tabs.find(
            (t) => t.kind === "subagent-panel"
          ) as SubagentPanelTabConfig | undefined;

          if (existingPanel) {
            if (currentData.activeTabId !== existingPanel.id) {
              mutateSession(
                () => ({
                  activeTabId: existingPanel.id,
                }),
                sid
              );
            }
            useUIStore.getState().openRightSidebar();
            return existingPanel.id;
          }

          // 核心恢复策略：优先从当前 session 的缓存恢复；若为空，则从历史会话消息中提取恢复
          let restoredAgents: SubagentInstance[] = currentData.cachedSubagents || [];
          if (restoredAgents.length === 0) {
            restoredAgents = extractSubagentsFromMessages(sid);
          }

          const panelTabId = `tab-subagent-panel-${Date.now()}`;
          const newPanelTab: SubagentPanelTabConfig = {
            id: panelTabId,
            kind: "subagent-panel",
            title: "协作代理",
            agents: restoredAgents,
            activeAgentId: restoredAgents[0]?.id || null,
            closable: true,
          };

          mutateSession((data) => {
            const hasOnlyDefaultNewTab =
              data.tabs.length === 0 ||
              (data.tabs.length === 1 && data.tabs[0].kind === "new-tab");
            const newTabs = hasOnlyDefaultNewTab
              ? [newPanelTab]
              : [...data.tabs, newPanelTab];
            return {
              tabs: newTabs,
              activeTabId: panelTabId,
              cachedSubagents: restoredAgents.length > 0 ? restoredAgents : data.cachedSubagents,
            };
          }, sid);

          useUIStore.getState().openRightSidebar();
          return panelTabId;
        },

        addAgentInstance: (agentId, agentType, taskPrompt, sessionId) => {
          get().openSubagentPanel(sessionId);
          const sid = sessionId || get().activeSessionId || DEFAULT_INITIAL_SESSION;
          const currentData = get().workbenchBySession[sid] || createDefaultSessionWorkbench(sid);
          const panelTab = currentData.tabs.find((t) => t.kind === "subagent-panel") as SubagentPanelTabConfig | undefined;
          const existingAgents = panelTab?.agents || currentData.cachedSubagents || [];
          const displayName = inferAgentDisplayName(agentType, taskPrompt, existingAgents, agentId);

          mutateSession((data) => {
            let nextAgents: SubagentInstance[] = [];
            const nextTabs = data.tabs.map((t) => {
              if (t.kind === "subagent-panel") {
                const panel = t as SubagentPanelTabConfig;
                const existingAgentIndex = panel.agents.findIndex(
                  (a) => a.id === agentId
                );
                if (existingAgentIndex >= 0) {
                  nextAgents = panel.agents.map((a, idx) =>
                    idx === existingAgentIndex
                      ? {
                          ...a,
                          agentType,
                          taskPrompt: taskPrompt || a.taskPrompt,
                          displayName: displayName || a.displayName,
                        }
                      : a
                  );
                } else {
                  const newAgent: SubagentInstance = {
                    id: agentId,
                    agentType,
                    displayName,
                    taskPrompt,
                    status: "running",
                    steps: [],
                    createdAt: new Date().toISOString(),
                  };
                  nextAgents = [...panel.agents, newAgent];
                }
                return {
                  ...panel,
                  agents: nextAgents,
                  activeAgentId: agentId,
                };
              }
              return t;
            });

            return {
              tabs: nextTabs,
              cachedSubagents: nextAgents.length > 0 ? nextAgents : data.cachedSubagents,
            };
          }, sid);
        },

        updateAgentInstance: (agentId, updates, sessionId) => {
          const sid = sessionId || get().activeSessionId || DEFAULT_INITIAL_SESSION;
          mutateSession((data) => {
            let updatedList: SubagentInstance[] = [];
            const nextTabs = data.tabs.map((t) => {
              if (t.kind === "subagent-panel") {
                const panel = t as SubagentPanelTabConfig;
                const nextAgents = panel.agents.map((a) => {
                  if (a.id === agentId) {
                    const updated = { ...a, ...updates };
                    if (updates.taskPrompt && !updates.displayName) {
                      updated.displayName = inferAgentDisplayName(
                        updated.agentType,
                        updated.taskPrompt,
                        panel.agents,
                        agentId
                      );
                    }
                    if (updates.status === "completed" || updates.status === "failed") {
                      updated.steps = updated.steps.map((s) => ({
                        ...s,
                        status: "done" as const,
                      }));
                    }
                    return updated;
                  }
                  return a;
                });
                updatedList = nextAgents;
                return {
                  ...panel,
                  agents: nextAgents,
                };
              }
              return t;
            });

            return {
              tabs: nextTabs,
              cachedSubagents: updatedList.length > 0 ? updatedList : data.cachedSubagents,
            };
          }, sid);
        },

        addAgentStep: (agentId, step, sessionId) => {
          const sid = sessionId || get().activeSessionId || DEFAULT_INITIAL_SESSION;
          mutateSession((data) => {
            let updatedList: SubagentInstance[] = [];
            const nextTabs = data.tabs.map((t) => {
              if (t.kind === "subagent-panel") {
                const panel = t as SubagentPanelTabConfig;
                const nextAgents = panel.agents.map((a) => {
                  if (a.id === agentId) {
                    const existingIndex = a.steps.findIndex(
                      (s) => s.index === step.index
                    );
                    let updatedSteps: SubagentStep[];
                    if (existingIndex >= 0) {
                      updatedSteps = a.steps.map((s, idx) =>
                        idx === existingIndex ? { ...s, ...step } : s
                      );
                    } else {
                      // 前序步骤自动置为已完成
                      const prevFinished = a.steps.map((s) => ({
                        ...s,
                        status: "done" as const,
                      }));
                      updatedSteps = [...prevFinished, step];
                    }
                    return { ...a, steps: updatedSteps };
                  }
                  return a;
                });
                updatedList = nextAgents;
                return {
                  ...panel,
                  agents: nextAgents,
                };
              }
              return t;
            });

            return {
              tabs: nextTabs,
              cachedSubagents: updatedList.length > 0 ? updatedList : data.cachedSubagents,
            };
          }, sid);
        },

        setActiveAgent: (agentId, sessionId) => {
          const sid = sessionId || get().activeSessionId || DEFAULT_INITIAL_SESSION;
          mutateSession((data) => ({
            tabs: data.tabs.map((t) => {
              if (t.kind === "subagent-panel") {
                return {
                  ...t,
                  activeAgentId: agentId,
                };
              }
              return t;
            }),
          }), sid);
        },
      };
    },
    {
      name: "genesis-workbench-tabs-state",
      partialize: (state) => ({
        activeSessionId: state.activeSessionId,
        workbenchBySession: state.workbenchBySession,
        isFileTreeVisible: state.isFileTreeVisible,
        isFullscreen: state.isFullscreen,
        isMaximized: state.isMaximized,
        savedWidthBeforeMaximize: state.savedWidthBeforeMaximize,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const targetId = state.activeSessionId || DEFAULT_INITIAL_SESSION;
        let map = state.workbenchBySession || {};

        // 1. 兼容历史数据迁移 (若旧版 localStorage 只有顶层的 tabs)
        if (
          !state.workbenchBySession ||
          Object.keys(state.workbenchBySession).length === 0
        ) {
          const oldTabs = (state as any).tabs;
          if (Array.isArray(oldTabs) && oldTabs.length > 0) {
            const migrated: SessionWorkbenchData = {
              tabs: oldTabs.map((t: any) => ({ ...t, closable: true })),
              activeTabId: (state as any).activeTabId || oldTabs[0].id,
              activeSection: (state as any).activeSection || "files",
              selectedFilePath: (state as any).selectedFilePath || null,
              previewUrl: (state as any).previewUrl || "genesis://newtab",
              allDiffFiles: (state as any).allDiffFiles || [],
            };
            map = { [targetId]: migrated };
          }
        }

        // 2. 迁移旧版 kind: "subagent" 的 tab 数据为统一的 "subagent-panel"
        Object.keys(map).forEach((sid) => {
          const sessionData = map[sid];
          if (sessionData?.tabs) {
            const oldSubagentTabs = sessionData.tabs.filter(
              (t: any) => t.kind === "subagent"
            );
            if (oldSubagentTabs.length > 0) {
              const migratedAgents: SubagentInstance[] = oldSubagentTabs.map(
                (t: any) => ({
                  id: t.id,
                  agentType: t.agentType || "explore",
                  displayName: inferAgentDisplayName(
                    t.agentType || "explore",
                    t.taskPrompt || ""
                  ),
                  taskPrompt: t.taskPrompt || "",
                  status: t.status || "completed",
                  steps: t.steps || [],
                  summary: t.summary,
                  createdAt: new Date().toISOString(),
                })
              );

              const existingPanelIndex = sessionData.tabs.findIndex(
                (t: any) => t.kind === "subagent-panel"
              );
              if (existingPanelIndex >= 0) {
                const existingPanel = sessionData.tabs[
                  existingPanelIndex
                ] as SubagentPanelTabConfig;
                const existingAgentIds = new Set(
                  existingPanel.agents.map((a) => a.id)
                );
                const mergedAgents = [
                  ...existingPanel.agents,
                  ...migratedAgents.filter((a) => !existingAgentIds.has(a.id)),
                ];
                sessionData.tabs[existingPanelIndex] = {
                  ...existingPanel,
                  agents: mergedAgents,
                };
                sessionData.tabs = sessionData.tabs.filter(
                  (t: any) => t.kind !== "subagent"
                );
              } else {
                const panelTab: SubagentPanelTabConfig = {
                  id: `tab-subagent-panel-${Date.now()}`,
                  kind: "subagent-panel",
                  title: "协作代理",
                  agents: migratedAgents,
                  activeAgentId:
                    migratedAgents[migratedAgents.length - 1]?.id || null,
                  closable: true,
                };
                sessionData.tabs = [
                  ...sessionData.tabs.filter((t: any) => t.kind !== "subagent"),
                  panelTab,
                ];
              }
            }
          }
        });

        // 3. 保证每个 session 的 tabs 都有至少一个标签页，且 closable: true
        Object.keys(map).forEach((sid) => {
          if (!map[sid].tabs || map[sid].tabs.length === 0) {
            map[sid] = createDefaultSessionWorkbench(sid);
          } else {
            map[sid].tabs = map[sid].tabs.map((t) => ({
              ...t,
              closable: true,
            }));
          }
        });

        if (!map[targetId]) {
          map[targetId] = createDefaultSessionWorkbench(targetId);
        }

        const current = map[targetId];
        useWorkbenchStore.setState({
          activeSessionId: targetId,
          workbenchBySession: map,
          tabs: current.tabs,
          activeTabId: current.activeTabId,
          activeSection: current.activeSection,
          selectedFilePath: current.selectedFilePath,
          previewUrl: current.previewUrl,
          allDiffFiles: current.allDiffFiles,
        });
      },
    }
  )
);
