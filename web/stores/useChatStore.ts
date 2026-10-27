import { create } from "zustand";
import { Message, ToolCallItem } from "@/types";
import {
  sendMessageStream,
  stopGenerationApi,
  fetchSessionMessagesApi,
  approveToolCallApi,
  steerChatApi,
} from "@/lib/api/chat";
import { useModelConfigStore } from "./useModelConfigStore";
import { useSessionStore } from "./useSessionStore";
import { useWorkbenchStore, SubagentInstance } from "./useWorkbenchStore";
import { useProcessStore } from "./useProcessStore";
import { useTodoStore } from "./useTodoStore";
import { useUIStore } from "./useUIStore";

export interface PendingPermission {
  sessionId: string;
  approvalId: string;
  toolName: string;
  arguments: Record<string, any>;
  reason: string;
}

export interface QueuedSteeringItem {
  id: string;
  content: string;
  createdAt: number;
  status: "queued" | "guided";
}

interface ChatState {
  messagesBySession: Record<string, Message[]>;
  isStreaming: boolean;
  activeStreamingMessageId: string | null;
  streamingSessionId: string | null;
  abortController: AbortController | null;
  pendingPermission: PendingPermission | null;

  // Codex 级排队系统 (Steering Queue)
  steeringQueueBySession: Record<string, QueuedSteeringItem[]>;
  enqueueSteering: (sessionId: string, content: string) => Promise<boolean>;
  guideSteeringItem: (sessionId: string, id: string) => Promise<boolean>;
  removeSteeringItem: (sessionId: string, id: string) => void;
  clearSteeringQueue: (sessionId: string) => void;
  reorderSteeringQueue: (sessionId: string, fromIndex: number, toIndex: number) => void;

  getMessages: (sessionId: string) => Message[];
  addMessage: (sessionId: string, message: Message) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  editAndResendMessage: (sessionId: string, messageId: string, newContent: string) => Promise<void>;
  regenerateAssistantMessage: (sessionId: string, messageId: string) => Promise<void>;
  sendStreamMessage: (
    sessionId: string,
    content: string,
    skillId?: string | null,
    parentId?: string | null
  ) => Promise<void>;
  sendSteerMessage: (sessionId: string, content: string) => Promise<boolean>;
  respondPermission: (approved: boolean) => Promise<void>;
  stopGeneration: (sessionId: string) => Promise<void>;
  switchSession: (newSessionId: string) => void;
  fetchMessages: (sessionId: string) => Promise<void>;
  setMessages: (sessionId: string, messages: Message[]) => void;
  resetChatStore: () => void;
}

const INITIAL_DEMO_MESSAGES: Record<string, Message[]> = {};

/**
 * 安全收拢指定 session 中所有仍处于 running 状态的子代理实例与步骤，防止界面持续转圈 loading
 */
function cleanupRunningSubagents(sessionId: string, targetStatus: "failed" | "completed" = "failed") {
  try {
    const wb = useWorkbenchStore.getState();
    const currentSessionTabs = (sessionId && wb.workbenchBySession[sessionId]?.tabs) || wb.tabs || [];
    for (const t of currentSessionTabs) {
      if (t.kind === "subagent-panel") {
        const panel = t as any;
        for (const agent of (panel.agents || [])) {
          if (agent.status === "running") {
            wb.updateAgentInstance(agent.id, {
              status: targetStatus,
              summary: agent.summary || (targetStatus === "failed" ? "*(已中止)*" : undefined),
            }, sessionId);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[useChatStore] Failed to cleanup running subagents:", e);
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  messagesBySession: INITIAL_DEMO_MESSAGES,
  isStreaming: false,
  activeStreamingMessageId: null,
  streamingSessionId: null,
  abortController: null,
  pendingPermission: null,
  steeringQueueBySession: {},

  enqueueSteering: async (sessionId: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return false;
    const item: QueuedSteeringItem = {
      id: `steer_q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      content: trimmed,
      createdAt: Date.now(),
      status: "queued",
    };

    set((state) => {
      const q = state.steeringQueueBySession[sessionId] || [];
      return {
        steeringQueueBySession: {
          ...state.steeringQueueBySession,
          [sessionId]: [...q, item],
        },
      };
    });

    return true;
  },

  guideSteeringItem: async (sessionId: string, id: string) => {
    const list = get().steeringQueueBySession[sessionId] || [];
    const target = list.find((item) => item.id === id);
    if (!target) return false;

    // 1. 从队列中剔除该项
    get().removeSteeringItem(sessionId, id);

    // 2. 若当前正在运行（isStreaming === true），调用 stopGeneration(sessionId) 打断当前任务，等待 50ms 清空微任务队列
    if (get().isStreaming) {
      await get().stopGeneration(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 3. 立即调用 sendStreamMessage(sessionId, target.content) 发起对该条信息的直接回答
    void get().sendStreamMessage(sessionId, target.content);
    return true;
  },

  removeSteeringItem: (sessionId: string, id: string) => {
    set((state) => ({
      steeringQueueBySession: {
        ...state.steeringQueueBySession,
        [sessionId]: (state.steeringQueueBySession[sessionId] || []).filter((item) => item.id !== id),
      },
    }));
  },

  clearSteeringQueue: (sessionId: string) => {
    set((state) => ({
      steeringQueueBySession: {
        ...state.steeringQueueBySession,
        [sessionId]: [],
      },
    }));
  },

  reorderSteeringQueue: (sessionId: string, fromIndex: number, toIndex: number) => {
    set((state) => {
      const q = [...(state.steeringQueueBySession[sessionId] || [])];
      if (fromIndex < 0 || fromIndex >= q.length || toIndex < 0 || toIndex >= q.length) {
        return state;
      }
      const [moved] = q.splice(fromIndex, 1);
      q.splice(toIndex, 0, moved);
      return {
        steeringQueueBySession: {
          ...state.steeringQueueBySession,
          [sessionId]: q,
        },
      };
    });
  },

  resetChatStore: () => {
    set({
      messagesBySession: {},
      steeringQueueBySession: {},
      isStreaming: false,
      activeStreamingMessageId: null,
      streamingSessionId: null,
      abortController: null,
      pendingPermission: null,
    });
  },

  getMessages: (sessionId: string) => {
    return get().messagesBySession[sessionId] || [];
  },

  addMessage: (sessionId: string, message: Message) => {
    set((state) => {
      const current = state.messagesBySession[sessionId] || [];
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: [...current, message],
        },
      };
    });
  },

  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => {
    set((state) => {
      const current = state.messagesBySession[sessionId] || [];
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: current.map((m) =>
            m.id === messageId ? { ...m, ...updates } : m
          ),
        },
      };
    });
  },

  sendStreamMessage: async (
    sessionId: string,
    content: string,
    skillId?: string | null,
    parentId?: string | null
  ) => {
    const { isStreaming, stopGeneration } = get();
    if (isStreaming) {
      await stopGeneration(sessionId);
    }

    const turnStartTime = Date.now();
    const userMsgId = `user_${turnStartTime}`;
    const aiMsgId = `ai_${turnStartTime + 1}`;

    // 确保右侧工作台同步至当前会话，避免会话未切换导致 Tab 无法渲染
    useWorkbenchStore.getState().switchSessionWorkbench(sessionId);

    const userMsg: Message = {
      id: userMsgId,
      session_id: sessionId,
      parent_id: parentId,
      role: "user",
      content,
      active_skill_id: skillId,
      status: "success",
      created_at: new Date().toISOString(),
    };

    const aiMsg: Message = {
      id: aiMsgId,
      session_id: sessionId,
      parent_id: userMsgId,
      role: "assistant",
      content: "",
      raw_tool_calls: [],
      status: "streaming",
      created_at: new Date().toISOString(),
    };

    const currentMessages = get().messagesBySession[sessionId] || [];
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: [...currentMessages, userMsg, aiMsg],
      },
      isStreaming: true,
      activeStreamingMessageId: aiMsgId,
      streamingSessionId: sessionId,
    }));

    const controller = new AbortController();
    set({ abortController: controller, pendingPermission: null });

    const activeModel = useModelConfigStore.getState().getActiveModel();

    try {
      await sendMessageStream({
        sessionId,
        content,
        parentId: userMsgId,
        skillId,
        model: activeModel?.modelId || "deepseek-chat",
        api_key: activeModel?.apiKey || undefined,
        base_url: activeModel?.baseUrl || undefined,
        provider: activeModel?.provider || "openai",
        max_tokens: activeModel?.maxTokens || undefined,
        context_window: activeModel?.contextWindow || 1048576,
        signal: controller.signal,
        onEvent: (msg) => {
          if (controller.signal.aborted) return;

          switch (msg.event) {
            case "session_info":
              break;

            case "tool_call_start":
            case "tool_start": {
              const data = msg.data;
              if (data?.name && typeof data.name === "string" && data.name.includes("dispatch_subagent")) {
                try {
                  const wb = useWorkbenchStore.getState();
                  wb.switchSessionWorkbench(sessionId);
                  const agentType = data.args?.agent_type === "verify" ? "verify" : "explore";
                  const rawPrompt = data.args?.task_prompt;
                  const taskPrompt = typeof rawPrompt === "string" ? rawPrompt : "正在接收子代理任务参数...";
                  const rawId = data.tool_call_id || "";
                  const agentId = rawId
                    ? (rawId.startsWith("agent-") ? rawId : `agent-${rawId}`)
                    : `agent-${Date.now()}`;
                  wb.openSubagentPanel(sessionId);
                  wb.addAgentInstance(agentId, agentType, taskPrompt, sessionId);
                  useUIStore.getState().openRightSidebar();
                } catch (e) {
                  console.warn("[useChatStore] Failed to init subagent instance:", e);
                }
              }
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) => {
                      if (m.id !== aiMsgId) return m;
                      const toolItem: ToolCallItem = {
                        id: data.tool_call_id,
                        name: data.name,
                        args: data.args || data.arguments || {},
                        status: "running",
                      };
                      return {
                        ...m,
                        raw_tool_calls: [...(m.raw_tool_calls || []), toolItem],
                      };
                    }),
                  },
                };
              });
              break;
            }

            case "workbench_preview": {
              const data = msg.data;
              if (data?.url) {
                try {
                  // 静默记录预览 URL，作用于当前会话独立的右侧工作台
                  useWorkbenchStore.getState().setPreviewUrl(data.url, false, sessionId);
                } catch (e) {
                  console.warn("[useChatStore] Failed to update previewUrl from workbench_preview:", e);
                }
              }
              break;
            }

            case "workbench_file_change": {
              const data = msg.data;
              if (data?.path) {
                try {
                  const filePath = data.path;
                  useWorkbenchStore.getState().recordFileDiff({
                    path: filePath,
                    name: data.name || filePath.split("/").pop() || "modified_file",
                    additions: data.additions || 0,
                    deletions: data.deletions || 0,
                    originalContent: data.original_content || "",
                    modifiedContent: data.modified_content || "",
                    unifiedDiff: data.unified_diff || data.diff || "",
                  }, sessionId);
                  useWorkbenchStore.getState().triggerPreviewReload();
                  if (typeof window !== "undefined") {
                    window.dispatchEvent(new CustomEvent("genesis:workspace-refresh"));
                  }
                } catch (e) {
                  console.warn("[useChatStore] Failed to process workbench_file_change:", e);
                }
              }
              break;
            }

            case "tool_call_result":
            case "tool_result": {
              const data = msg.data;
              if (
                typeof window !== "undefined" &&
                typeof data.name === "string" &&
                data.name.startsWith("workspace__") &&
                !data.is_error
              ) {
                window.dispatchEvent(new CustomEvent("genesis:workspace-refresh"));
                const resObj = (data.result || data.output) as Record<string, any> | undefined;
                if (resObj && typeof resObj === "object") {
                  if (resObj.diff) {
                    try {
                      const filePath = resObj.path || "";
                      useWorkbenchStore.getState().recordFileDiff({
                        path: filePath,
                        name: resObj.name || filePath.split("/").pop() || "modified_file",
                        additions: resObj.additions || 0,
                        deletions: resObj.deletions || 0,
                        originalContent: resObj.original_content || "",
                        modifiedContent: resObj.modified_content || "",
                        unifiedDiff: resObj.diff || "",
                      }, sessionId);
                      useWorkbenchStore.getState().triggerPreviewReload();
                    } catch (e) {
                      console.warn("[useChatStore] Failed to record diff to workbench:", e);
                    }
                  }
                  const targetUrl = resObj.url || resObj.detected_url;
                  if (targetUrl) {
                    try {
                      useWorkbenchStore.getState().setPreviewUrl(targetUrl, false, sessionId);
                    } catch (e) {
                      console.warn("[useChatStore] Failed to set previewUrl from tool result:", e);
                    }
                  }
                  if (resObj.status === "running_in_background" && resObj.pid) {
                    try {
                      useProcessStore.getState().addProcess({
                        pid: resObj.pid,
                        command: resObj.command || "unknown",
                        session_id: sessionId,
                      });
                    } catch (e) {
                      console.warn("[useChatStore] Failed to register background process:", e);
                    }
                  }
                }
              }
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) => {
                      if (m.id !== aiMsgId) return m;
                      const tools = (m.raw_tool_calls || []).map((tc) => {
                        const isMatch =
                          tc.id === data.tool_call_id ||
                          tc.id === data.agent_id ||
                          (data.agent_id && `agent-${tc.id}` === data.agent_id) ||
                          (data.tool_call_id && `agent-${data.tool_call_id}` === tc.id);
                        return isMatch
                          ? {
                              ...tc,
                              output: (data.output || data.result) as unknown as string | Record<string, unknown>,
                              latency_ms: data.latency_ms,
                              status: data.is_error ? ("failed" as const) : ("success" as const),
                            }
                          : tc;
                      });
                      return { ...m, raw_tool_calls: tools };
                    }),
                  },
                };
              });
              break;
            }


            case "reasoning_delta": {
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId
                        ? {
                            ...m,
                            reasoning_content:
                              (m.reasoning_content || "") + data.delta,
                          }
                        : m
                    ),
                  },
                };
              });
              break;
            }

            case "text_delta": {
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId
                        ? { ...m, content: (m.content || "") + data.delta }
                        : m
                    ),
                  },
                };
              });
              break;
            }

            case "usage": {
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId
                        ? {
                            ...m,
                            metrics: {
                              latency_ms: data.latency_ms,
                              tokens: data.tokens,
                            },
                          }
                        : m
                    ),
                  },
                };
              });
              break;
            }

            case "session_title_updated": {
              const data = msg.data;
              if (data?.title) {
                const targetSid = data.session_id || sessionId;
                useSessionStore
                  .getState()
                  .updateSessionDetails(targetSid, { title: data.title });
              }
              break;
            }

            case "permission_request": {
              const data = msg.data;
              set({
                pendingPermission: {
                  sessionId,
                  approvalId: data.approval_id || data.tool_call_id || "",
                  toolName: data.tool_name || data.name || "",
                  arguments: (data.arguments || data.args || {}) as Record<string, any>,
                  reason:
                    data.reason ||
                    "该工具涉及高危文件写操作或命令执行，需用户确认授权",
                },
              });
              break;
            }

            case "mid_task_steered": {
              const data = msg.data as { content?: string };
              const curAiId = get().activeStreamingMessageId;
              const steerText = data?.content || "";

              const currentQueue = get().steeringQueueBySession[sessionId] || [];
              const matchedItem = currentQueue.find((item) => item.content === steerText) || currentQueue[0];
              const remainingQueue = matchedItem
                ? currentQueue.filter((item) => item.id !== matchedItem.id)
                : currentQueue;

              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                // 1. 将前序 assistant 标记为 success
                const updatedList = list.map((m) => {
                  if (m.id === curAiId) {
                    return { ...m, status: "success" as const };
                  }
                  return m;
                });

                // 2. 将出队的插话转为正式的已生效 UserMessage 气泡
                const steerUserMsg: Message = {
                  id: `user_steered_${Date.now()}`,
                  session_id: sessionId,
                  role: "user",
                  content: steerText || matchedItem?.content || "实时转向指令",
                  status: "success",
                  created_at: new Date().toISOString(),
                };

                // 3. 为模型接力转向开启新的 AI assistant 消息气泡接收后续流式输出
                const nextAiId = `ai_steered_${Date.now()}`;
                const nextAiMsg: Message = {
                  id: nextAiId,
                  session_id: sessionId,
                  role: "assistant",
                  content: "",
                  raw_tool_calls: [],
                  status: "streaming",
                  created_at: new Date().toISOString(),
                };

                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: [...updatedList, steerUserMsg, nextAiMsg],
                  },
                  steeringQueueBySession: {
                    ...state.steeringQueueBySession,
                    [sessionId]: remainingQueue,
                  },
                  activeStreamingMessageId: nextAiId,
                };
              });
              break;
            }

            case "workbench_todos": {
              const data = msg.data as { session_id?: string; todos?: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" }> };
              if (data?.todos && data.session_id) {
                useTodoStore.getState().setTodos(data.session_id, data.todos);
              }
              break;
            }

            case "subagent_progress": {
              const data = msg.data as {
                agent_id?: string;
                agent_type?: string;
                task_prompt?: string;
                step?: number;
                max_steps?: number;
                status?: string;
                tool_calls?: string[];
                summary_preview?: string;
                thinking?: string;
                thinking_content?: string;
              };
              if (!data) break;
              const wb = useWorkbenchStore.getState();
              wb.switchSessionWorkbench(sessionId);

              // 确定 agent_id：优先用后端返回的并做前缀规范化
              let agentId = data.agent_id || "unknown";
              if (agentId !== "unknown" && !agentId.startsWith("agent-")) {
                agentId = `agent-${agentId}`;
              }
              const agentType = (data.agent_type === "verify" ? "verify" : "explore") as "explore" | "verify";

              // 确保面板和实例存在
              wb.openSubagentPanel(sessionId);
              const panel = wb.tabs.find(t => t.kind === "subagent-panel") as any;
              if (panel && !panel.agents?.some((a: any) => a.id === agentId)) {
                wb.addAgentInstance(agentId, agentType, data.task_prompt || "", sessionId);
              }

              // 更新 task_prompt 与思考过程 thinkingContent
              const thinking = data.thinking || data.thinking_content || "";
              const instanceUpdates: Partial<SubagentInstance> = {};
              if (data.task_prompt) instanceUpdates.taskPrompt = data.task_prompt;
              if (thinking) instanceUpdates.thinkingContent = thinking;
              if (Object.keys(instanceUpdates).length > 0) {
                wb.updateAgentInstance(agentId, instanceUpdates, sessionId);
              }

              if (data.status === "executing_tools" && data.step) {
                const toolName = data.tool_calls?.[0] || "unknown";
                wb.addAgentStep(agentId, {
                  index: data.step,
                  toolName,
                  status: "running",
                  preview: data.summary_preview,
                  thinking: thinking || undefined,
                  timestamp: new Date().toISOString(),
                }, sessionId);
              } else if (data.status === "step_done" && data.step) {
                wb.addAgentStep(agentId, {
                  index: data.step,
                  toolName: data.tool_calls?.[0] || "unknown",
                  status: "done",
                  preview: data.summary_preview,
                  thinking: thinking || undefined,
                  timestamp: new Date().toISOString(),
                }, sessionId);
              } else if (data.status === "completed") {
                wb.updateAgentInstance(agentId, {
                  status: "completed",
                  summary: data.summary_preview,
                  ...(thinking ? { thinkingContent: thinking } : {}),
                }, sessionId);
              } else if (data.status === "failed") {
                wb.updateAgentInstance(agentId, {
                  status: "failed",
                  summary: data.summary_preview,
                }, sessionId);
              }

              // 同步反哺当前消息流中的 raw_tool_calls，确保左侧时间线立即停止转圈并获得准确任务描述与状态
              const rawTcId = agentId.replace(/^agent-/, "");
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                const hasMatchingTool = list.some((m) =>
                  m.raw_tool_calls?.some((tc) => tc.id === agentId || tc.id === rawTcId)
                );
                if (!hasMatchingTool) return state;

                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) => {
                      if (!m.raw_tool_calls?.some((tc) => tc.id === agentId || tc.id === rawTcId)) {
                        return m;
                      }
                      return {
                        ...m,
                        raw_tool_calls: m.raw_tool_calls.map((tc) => {
                          if (tc.id !== agentId && tc.id !== rawTcId) return tc;
                          const updatedStatus =
                            data.status === "completed"
                              ? ("success" as const)
                              : data.status === "failed"
                              ? ("failed" as const)
                              : tc.status;
                          return {
                            ...tc,
                            status: updatedStatus,
                            output:
                              data.summary_preview && (data.status === "completed" || data.status === "failed")
                                ? { summary: data.summary_preview }
                                : tc.output,
                            args: {
                              ...tc.args,
                              ...(data.task_prompt ? { task_prompt: data.task_prompt } : {}),
                              ...(data.agent_type ? { agent_type: data.agent_type } : {}),
                            },
                          };
                        }),
                      };
                    }),
                  },
                };
              });

              // 确保右栏打开并聚焦面板
              useUIStore.getState().openRightSidebar();
              break;
            }

            case "done": {
              const data = msg.data;
              const durationMs =
                data?.duration_ms !== undefined
                  ? Number(data.duration_ms)
                  : Math.max(100, Date.now() - turnStartTime);
              const tokensObj = data?.tokens as { input?: number; output?: number } | undefined;
              const totalTokens = tokensObj
                ? (tokensObj.input || 0) + (tokensObj.output || 0)
                : undefined;

              // 兜底保障：整轮对话已结束，收拢当前会话所有仍处于 running 状态的 subagent 实例
              cleanupRunningSubagents(sessionId, "completed");

              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId
                        ? {
                            ...m,
                            status: "success",
                            created_at: new Date().toISOString(),
                            metrics: {
                              latency_ms: durationMs,
                              tokens: totalTokens,
                            },
                            raw_tool_calls: (m.raw_tool_calls || []).map((tc) => ({
                              ...tc,
                              status: tc.status === "failed" ? "failed" : "success",
                            })),
                          }
                        : m
                    ),
                  },
                  isStreaming: false,
                  activeStreamingMessageId: null,
                  streamingSessionId: null,
                  abortController: null,
                  pendingPermission: null,
                };
              });

              // 正常完成的 FIFO 自动出队：检查当前 session 的 steeringQueueBySession
              const currentQueue = get().steeringQueueBySession[sessionId] || [];
              if (currentQueue.length > 0) {
                const nextItem = currentQueue[0];
                get().removeSteeringItem(sessionId, nextItem.id);
                setTimeout(() => {
                  void get().sendStreamMessage(sessionId, nextItem.content);
                }, 100);
              }

              break;
            }

            case "error": {
              cleanupRunningSubagents(sessionId, "failed");
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId
                        ? {
                            ...m,
                            status: "failed",
                            content:
                              (m.content || "") +
                              `\n\n*(生成中断: ${data.message || "服务异常"})*`,
                          }
                        : m
                    ),
                  },
                  isStreaming: false,
                  activeStreamingMessageId: null,
                  streamingSessionId: null,
                  abortController: null,
                  pendingPermission: null,
                };
              });
              break;
            }
          }
        },
      });
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        // 用户手动停止，将所有进行中的 todo 重置为 pending，防止界面继续 loading 转圈
        try {
          const todoStore = useTodoStore.getState();
          const currentTodos = todoStore.todosBySession[sessionId] || [];
          if (currentTodos.some((t) => t.status === "in_progress")) {
            todoStore.setTodos(
              sessionId,
              currentTodos.map((t) => (t.status === "in_progress" ? { ...t, status: "pending" } : t))
            );
          }
        } catch {}

        // 用户手动停止，收拢所有 running 中的子代理，彻底停止转圈
        cleanupRunningSubagents(sessionId, "failed");

        // 用户手动停止，保留已有片段
        set((state) => {
          const list = state.messagesBySession[sessionId] || [];
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: list.map((m) =>
                m.id === aiMsgId
                  ? {
                      ...m,
                      status: "success",
                      created_at: new Date().toISOString(),
                      content:
                        (m.content || "") + "\n\n*(用户已手动终止生成)*",
                    }
                  : m
              ),
            },
          };
        });
      } else {
        // 网络/服务连接异常时，同样收拢子代理状态
        cleanupRunningSubagents(sessionId, "failed");

        set((state) => {
          const list = state.messagesBySession[sessionId] || [];
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: list.map((m) =>
                m.id === aiMsgId
                  ? {
                      ...m,
                      status: "failed",
                      content:
                        (m.content || "") +
                        `\n\n*(连接失败: ${err instanceof Error ? err.message : "未知错误"})*`,
                    }
                  : m
              ),
            },
          };
        });
      }
    } finally {
      if (get().abortController === controller) {
        set({
          isStreaming: false,
          activeStreamingMessageId: null,
          streamingSessionId: null,
          abortController: null,
          pendingPermission: null,
        });
      }
    }
  },

  sendSteerMessage: async (sessionId: string, content: string) => {
    const steerId = `steer_${Date.now()}`;
    const steerMsg: Message = {
      id: steerId,
      session_id: sessionId,
      role: "user",
      content,
      status: "streaming", // 标记为排队等待中
      created_at: new Date().toISOString(),
    };

    // 立即向本地消息列表推入排队气泡
    get().addMessage(sessionId, steerMsg);

    try {
      const res = await steerChatApi(sessionId, content);
      if (!res.success) {
        get().updateMessage(sessionId, steerId, {
          status: "failed",
          content: `${content}\n\n*(插话失败: ${res.message || "当前会话未在运行"})*`,
        });
        return false;
      }
      return true;
    } catch (err) {
      get().updateMessage(sessionId, steerId, {
        status: "failed",
        content: `${content}\n\n*(插话请求失败: ${err instanceof Error ? err.message : String(err)})*`,
      });
      return false;
    }
  },

  respondPermission: async (approved: boolean) => {
    const { pendingPermission } = get();
    if (!pendingPermission) return;
    const { sessionId, approvalId } = pendingPermission;
    try {
      await approveToolCallApi(sessionId, approvalId, approved);
    } catch (err) {
      console.error("[useChatStore] Failed to send approval response:", err);
    } finally {
      set({ pendingPermission: null });
    }
  },

  stopGeneration: async (sessionId: string) => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
    }
    // 中止时将当前会话处于 running 的子代理立即置为 failed，防止停止后界面仍死循环转圈
    cleanupRunningSubagents(sessionId, "failed");
    // 中止时将当前会话处于 in_progress 的任务重置为 pending，防止停止后界面仍死循环转圈
    try {
      const todoStore = useTodoStore.getState();
      const currentTodos = todoStore.todosBySession[sessionId] || [];
      if (currentTodos.some((t) => t.status === "in_progress")) {
        todoStore.setTodos(
          sessionId,
          currentTodos.map((t) => (t.status === "in_progress" ? { ...t, status: "pending" } : t))
        );
      }
    } catch {}
    // 中止时将当前会话所有处于 running 的 raw_tool_calls 标记为 failed，防止左侧时间线继续转圈
    set((state) => {
      const list = state.messagesBySession[sessionId] || [];
      const updatedList = list.map((m) => {
        if (!m.raw_tool_calls?.some((tc) => tc.status === "running")) return m;
        return {
          ...m,
          raw_tool_calls: m.raw_tool_calls.map((tc) =>
            tc.status === "running" ? { ...tc, status: "failed" as const } : tc
          ),
        };
      });
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: updatedList,
        },
        isStreaming: false,
        activeStreamingMessageId: null,
        streamingSessionId: null,
        abortController: null,
        pendingPermission: null,
      };
    });
    await stopGenerationApi(sessionId);
  },

  switchSession: (newSessionId: string) => {
    const { isStreaming, streamingSessionId, stopGeneration, fetchMessages } = get();
    // 会话切换熔断保护：若用户切走正在推流的会话，立即熔断上一会话，杜绝串流
    if (isStreaming && streamingSessionId && streamingSessionId !== newSessionId) {
      stopGeneration(streamingSessionId);
    }
    if (newSessionId) {
      fetchMessages(newSessionId);
      useWorkbenchStore.getState().switchSessionWorkbench(newSessionId);
    }
  },

  fetchMessages: async (sessionId: string) => {
    if (!sessionId) return;
    // 若当前会话正在推流中，切勿打断或覆盖
    if (get().isStreaming && get().streamingSessionId === sessionId) {
      return;
    }
    try {
      const res = await fetchSessionMessagesApi(sessionId);
      if (res && Array.isArray(res.items)) {
        const local = get().messagesBySession[sessionId] || [];
        // 若远程返回空但本地已存在消息（例如新建会话刚发送的消息），保留本地状态
        if (res.items.length === 0 && local.length > 0) {
          return;
        }
        const normalized = normalizeSessionMessages(res.items);
        set((state) => ({
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: normalized,
          },
        }));
      }
    } catch (err) {
      console.warn(`[useChatStore] fetchMessages failed for ${sessionId}:`, err);
    }
  },

  editAndResendMessage: async (
    sessionId: string,
    messageId: string,
    newContent: string
  ) => {
    const current = get().messagesBySession[sessionId] || [];
    const index = current.findIndex((m) => m.id === messageId);
    if (index === -1) return;

    // 单线分支物理修剪：截断晚于当前节点的废弃分支
    const target = current[index];
    const pruned = current.slice(0, index);

    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: pruned,
      },
    }));

    // 重新发起提问流
    await get().sendStreamMessage(
      sessionId,
      newContent,
      target.active_skill_id,
      target.parent_id
    );
  },

  regenerateAssistantMessage: async (sessionId: string, messageId: string) => {
    const current = get().messagesBySession[sessionId] || [];
    const index = current.findIndex((m) => m.id === messageId);
    if (index === -1) return;

    const assistantMsg = current[index];
    // 找到该 AI 消息的对应用户提问节点
    const parentUserMsg = current
      .slice(0, index)
      .reverse()
      .find((m) => m.role === "user");

    if (!parentUserMsg || !parentUserMsg.content) return;

    // 截断该 AI 消息及之后的内容
    const pruned = current.slice(0, index);
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: pruned,
      },
    }));

    await get().sendStreamMessage(
      sessionId,
      parentUserMsg.content,
      parentUserMsg.active_skill_id,
      parentUserMsg.id
    );
  },

  setMessages: (sessionId: string, messages: Message[]) => {
    const normalized = normalizeSessionMessages(messages);
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: normalized,
      },
    }));
  },
}));

/**
 * 规整会话消息列表：
 * 1. 提取所有 role === "tool" 消息的执行结果，通过 tool_call_id 精准挂载回对应 assistant 的 raw_tool_calls。
 * 2. 剥离裸露在外部的 role === "tool" 与 "system" 协议消息，确保聊天流仅展示用户与助手的对话卡片。
 */
export function normalizeSessionMessages(messages: Message[]): Message[] {
  const toolResultsMap: Record<string, { output: unknown; isError?: boolean }> = {};

  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      let parsedOutput: unknown = m.content;
      if (typeof m.content === "string") {
        const trimmed = m.content.trim();
        if (
          (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]"))
        ) {
          try {
            parsedOutput = JSON.parse(trimmed);
          } catch {
            parsedOutput = m.content;
          }
        }
      }
      toolResultsMap[m.tool_call_id] = {
        output: parsedOutput,
        isError: m.status === "failed",
      };
    }
  }

  // 1. 挂载工具结果，并滤除 tool/system
  const stepMessages: Message[] = [];
  for (const m of messages) {
    if (m.role === "tool" || m.role === "system") {
      continue;
    }

    if (m.role === "assistant" && m.raw_tool_calls && m.raw_tool_calls.length > 0) {
      const enrichedTools = m.raw_tool_calls.map((tc) => {
        const res = toolResultsMap[tc.id];
        if (res) {
          return {
            ...tc,
            output: (tc.output !== undefined ? tc.output : res.output) as string | Record<string, unknown> | undefined,
            status:
              tc.status && tc.status !== "running"
                ? tc.status
                : res.isError
                ? ("failed" as const)
                : ("success" as const),
          };
        }
        return {
          ...tc,
          status:
            m.status === "streaming"
              ? tc.status || ("running" as const)
              : tc.status || ("success" as const),
        };
      });

      stepMessages.push({
        ...m,
        raw_tool_calls: enrichedTools,
      });
    } else {
      stepMessages.push(m);
    }
  }

  // 2. 业内成熟架构：Turn 级别聚合（同一轮提问下的多步 Assistant 步骤合并为统一卡片）
  const normalized: Message[] = [];
  let lastUserTime = 0;

  for (const item of stepMessages) {
    if (item.role === "user") {
      lastUserTime = item.created_at ? new Date(item.created_at).getTime() : 0;
      normalized.push(item);
      continue;
    }

    if (item.role === "assistant") {
      const prev = normalized.length > 0 ? normalized[normalized.length - 1] : null;

      // 若前一个节点也是 assistant，合并为同一轮完整的 Assistant 回复卡片
      if (prev && prev.role === "assistant") {
        // 合并 raw_tool_calls (按 id 去重并按时序排列)
        const existingTools = prev.raw_tool_calls || [];
        const newTools = item.raw_tool_calls || [];
        const existingIds = new Set(existingTools.map((t) => t.id));
        const mergedTools = [...existingTools];
        for (const t of newTools) {
          if (!existingIds.has(t.id)) {
            mergedTools.push(t);
            existingIds.add(t.id);
          }
        }

        // 合并 content：以换行衔接各步骤说明与最终总结
        let mergedContent = prev.content || "";
        const nextContent = item.content ? item.content.trim() : "";
        if (nextContent) {
          if (!mergedContent.trim()) {
            mergedContent = nextContent;
          } else if (!mergedContent.includes(nextContent)) {
            mergedContent = `${mergedContent.trim()}\n\n${nextContent}`;
          }
        }

        // 合并 reasoning_content
        let mergedReasoning = prev.reasoning_content || "";
        const nextReasoning = item.reasoning_content ? item.reasoning_content.trim() : "";
        if (nextReasoning) {
          if (!mergedReasoning.trim()) {
            mergedReasoning = nextReasoning;
          } else if (!mergedReasoning.includes(nextReasoning)) {
            mergedReasoning = `${mergedReasoning.trim()}\n\n${nextReasoning}`;
          }
        }

        // 指标更新：优先取持久化的 metrics，若无则基于该轮首尾时间差计算
        let mergedMetrics = item.metrics || prev.metrics;
        if (!mergedMetrics && lastUserTime && item.created_at) {
          const itemTime = new Date(item.created_at).getTime();
          const diffMs = Math.max(200, itemTime - lastUserTime);
          if (diffMs > 0 && diffMs < 300000) {
            mergedMetrics = { latency_ms: diffMs };
          }
        }

        prev.id = item.id;
        prev.content = mergedContent || null;
        prev.reasoning_content = mergedReasoning || null;
        prev.raw_tool_calls = mergedTools.length > 0 ? mergedTools : null;
        prev.metrics = mergedMetrics;
        if (item.created_at) {
          prev.created_at = item.created_at;
        }
        if (item.status === "failed") {
          prev.status = "failed";
        }
        continue;
      }

      // 如果当前是第一个 assistant，计算保底 metrics
      if (!item.metrics && lastUserTime && item.created_at) {
        const itemTime = new Date(item.created_at).getTime();
        const diffMs = Math.max(200, itemTime - lastUserTime);
        if (diffMs > 0 && diffMs < 300000) {
          item.metrics = { latency_ms: diffMs };
        }
      }

      normalized.push({ ...item });
    }
  }

  return normalized;
}
