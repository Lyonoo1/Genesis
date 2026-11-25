import { create } from "zustand";
import { Message, ToolCallItem } from "@/types";
import {
  sendMessageStream,
  stopGenerationApi,
  fetchSessionMessagesApi,
  steerChatApi,
} from "@/lib/api/chat";
import {
  AgentLifecycleState,
  ContextTelemetryPayload,
} from "@/types/stream";
import { useModelConfigStore } from "./useModelConfigStore";
import {
  useWorkbenchStore,
  SubagentMode,
  SubagentPanelTabConfig,
  SubagentStatus,
} from "./useWorkbenchStore";
import { useTodoStore } from "./useTodoStore";
import { useConfirmationStore } from "@/components/agent-confirmation/store/useConfirmationStore";

export interface BatchedChatFrame {
  sessionId: string;
  messageId: string;
  textDelta?: string;
  reasoningDelta?: string;
  toolCallDeltas?: Record<string, string>;
  parsedToolCallArgs?: Record<string, Record<string, unknown>>;
}

export interface SubagentToolCallSyncItem {
  agentId: string;
  parentCallId?: string;
  status?: SubagentStatus;
  summary?: string;
  taskPrompt?: string;
  agentType?: SubagentMode;
  writeScope?: string[];
}

export interface QueuedSteeringItem {
  id: string;
  content: string;
  createdAt: number;
  status: "queued" | "guided";
}

interface SessionStreamInfo {
  isStreaming: boolean;
  activeStreamingMessageId: string | null;
  abortController: AbortController | null;
}

interface ChatState {
  messagesBySession: Record<string, Message[]>;
  streamingSessions: Record<string, SessionStreamInfo>;
  isStreamingForSession: (sessionId?: string | null) => boolean;
  getActiveStreamingMessageId: (sessionId?: string | null) => string | null;

  // 顶层全局兼容属性（便于非特定会话组件快速读取）
  isStreaming: boolean;
  activeStreamingMessageId: string | null;
  streamingSessionId: string | null;
  abortController: AbortController | null;

  // 双模态与生命周期状态机
  runModeBySession: Record<string, "plan" | "act">;
  lifecycleStateBySession: Record<string, AgentLifecycleState>;
  proposedPlanBySession: Record<string, { planId: string; plan: string; step?: number } | null>;
  contextTelemetryBySession: Record<string, ContextTelemetryPayload | null>;

  runMode: "plan" | "act";
  lifecycleState: AgentLifecycleState;
  proposedPlan: { planId: string; plan: string; step?: number } | null;
  contextTelemetry: ContextTelemetryPayload | null;

  // Codex 级排队系统 (Steering Queue)
  steeringQueueBySession: Record<string, QueuedSteeringItem[]>;
  enqueueSteering: (sessionId: string, content: string) => Promise<boolean>;
  guideSteeringItem: (sessionId: string, id: string) => Promise<boolean>;
  removeSteeringItem: (sessionId: string, id: string) => void;
  clearSteeringQueue: (sessionId: string) => void;
  reorderSteeringQueue: (sessionId: string, fromIndex: number, toIndex: number) => void;

  setRunMode: (mode: "plan" | "act", sessionId?: string) => void;
  setLifecycleState: (state: AgentLifecycleState, sessionId?: string) => void;
  setProposedPlan: (plan: { planId: string; plan: string; step?: number } | null, sessionId?: string) => void;
  setContextTelemetry: (telemetry: ContextTelemetryPayload | null, sessionId?: string) => void;
  submitPlanDecision: (
    sessionId: string,
    approved: boolean,
    feedback?: string,
    autoContinue?: boolean
  ) => Promise<boolean>;

  // 供 StreamDispatcher 调用的批量/原子状态更新 Actions
  applyBatchedStreamFrame: (frame: BatchedChatFrame) => void;
  appendToolCall: (sessionId: string, messageId: string, toolCall: ToolCallItem) => void;
  updateToolCallResult: (
    sessionId: string,
    messageId: string,
    params: {
      toolCallId: string;
      agentId?: string;
      output: unknown;
      latencyMs?: number;
      isError: boolean;
    }
  ) => void;
  syncSubagentToolCalls: (sessionId: string, items: SubagentToolCallSyncItem[]) => void;
  updateMessageMetrics: (
    sessionId: string,
    messageId: string,
    metrics: { latency_ms?: number; tokens?: number }
  ) => void;
  applyMidTaskSteered: (sessionId: string, messageId: string, steerText: string) => void;
  applyStreamDone: (
    sessionId: string,
    messageId: string,
    params: {
      durationMs: number;
      totalTokens?: number;
      finalLifecycleState: AgentLifecycleState;
      mode?: "plan" | "act";
    }
  ) => void;
  applyStreamError: (sessionId: string, messageId: string, errorMessage: string) => void;

  getMessages: (sessionId: string) => Message[];
  addMessage: (sessionId: string, message: Message) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  editAndResendMessage: (sessionId: string, messageId: string, newContent: string) => Promise<void>;
  regenerateAssistantMessage: (sessionId: string, messageId: string) => Promise<void>;
  sendStreamMessage: (
    sessionId: string,
    content: string,
    skillId?: string | null,
    parentId?: string | null,
    mode?: "plan" | "act"
  ) => Promise<void>;
  sendSteerMessage: (sessionId: string, content: string) => Promise<boolean>;
  stopGeneration: (sessionId: string) => Promise<void>;
  switchSession: (newSessionId: string) => void;
  fetchMessages: (sessionId: string) => Promise<void>;
  setMessages: (sessionId: string, messages: Message[]) => void;
  resetChatStore: () => void;
}

const INITIAL_DEMO_MESSAGES: Record<string, Message[]> = {};

function isSessionCurrentlyActive(sessionId?: string | null): boolean {
  if (!sessionId) return true;
  const activeWbSid = useWorkbenchStore.getState().activeSessionId;
  return !activeWbSid || activeWbSid === sessionId;
}

/**
 * 安全收拢指定 session 中所有仍处于 running 状态的子代理实例与步骤，防止界面持续转圈 loading
 */
function cleanupRunningSubagents(sessionId: string, targetStatus: "failed" | "completed" = "failed") {
  try {
    const wb = useWorkbenchStore.getState();
    const currentSessionTabs = (sessionId && wb.workbenchBySession[sessionId]?.tabs) || wb.tabs || [];
    for (const t of currentSessionTabs) {
      if (t.kind === "subagent-panel") {
        const panel = t as SubagentPanelTabConfig;
        for (const agent of panel.agents || []) {
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

function computeStreamingState(
  streamingSessions: Record<string, SessionStreamInfo>
) {
  const activeKeys = Object.keys(streamingSessions).filter(
    (k) => streamingSessions[k]?.isStreaming
  );
  const isStreaming = activeKeys.length > 0;
  const currentKey = activeKeys[0] || null;
  const current = currentKey ? streamingSessions[currentKey] : null;
  return {
    streamingSessions,
    isStreaming,
    streamingSessionId: currentKey,
    activeStreamingMessageId: current?.activeStreamingMessageId || null,
    abortController: current?.abortController || null,
  };
}

export const useChatStore = create<ChatState>((set, get) => ({
  messagesBySession: INITIAL_DEMO_MESSAGES,
  streamingSessions: {},
  isStreamingForSession: (sessionId) => {
    if (!sessionId) return get().isStreaming;
    return !!get().streamingSessions[sessionId]?.isStreaming;
  },
  getActiveStreamingMessageId: (sessionId) => {
    if (!sessionId) return get().activeStreamingMessageId;
    return get().streamingSessions[sessionId]?.activeStreamingMessageId || null;
  },
  isStreaming: false,
  activeStreamingMessageId: null,
  streamingSessionId: null,
  abortController: null,
  steeringQueueBySession: {},

  runModeBySession: {},
  lifecycleStateBySession: {},
  proposedPlanBySession: {},
  contextTelemetryBySession: {},
  runMode: "act",
  lifecycleState: AgentLifecycleState.IDLE,
  proposedPlan: null,
  contextTelemetry: null,

  setRunMode: (mode, sessionId) => {
    set((state) => {
      const sid = sessionId || useWorkbenchStore.getState().activeSessionId || "draft";
      const syncGlobal = !sessionId || isSessionCurrentlyActive(sid);
      return {
        ...(syncGlobal ? { runMode: mode } : {}),
        runModeBySession: {
          ...state.runModeBySession,
          [sid]: mode,
        },
      };
    });
  },

  setLifecycleState: (lifecycleState, sessionId) => {
    set((state) => {
      const sid = sessionId || useWorkbenchStore.getState().activeSessionId || "draft";
      const syncGlobal = !sessionId || isSessionCurrentlyActive(sid);
      return {
        ...(syncGlobal ? { lifecycleState } : {}),
        lifecycleStateBySession: {
          ...state.lifecycleStateBySession,
          [sid]: lifecycleState,
        },
      };
    });
  },

  setProposedPlan: (proposedPlan, sessionId) => {
    set((state) => {
      const sid = sessionId || useWorkbenchStore.getState().activeSessionId || "draft";
      const syncGlobal = !sessionId || isSessionCurrentlyActive(sid);
      return {
        ...(syncGlobal ? { proposedPlan } : {}),
        proposedPlanBySession: {
          ...state.proposedPlanBySession,
          [sid]: proposedPlan,
        },
      };
    });
  },

  setContextTelemetry: (contextTelemetry, sessionId) => {
    set((state) => {
      const sid = sessionId || useWorkbenchStore.getState().activeSessionId || "draft";
      const syncGlobal = !sessionId || isSessionCurrentlyActive(sid);
      return {
        ...(syncGlobal ? { contextTelemetry } : {}),
        contextTelemetryBySession: {
          ...state.contextTelemetryBySession,
          [sid]: contextTelemetry,
        },
      };
    });
  },

  submitPlanDecision: async (sessionId, approved, feedback, autoContinue = true) => {
    try {
      const { submitPlanDecisionApi } = await import("@/lib/api/chat");
      await submitPlanDecisionApi(sessionId, approved, feedback);
      const nextMode: "plan" | "act" = approved ? "act" : "plan";
      const nextLifecycle = approved
        ? AgentLifecycleState.COMPILING_CONTEXT
        : AgentLifecycleState.PLANNING;
      const syncGlobal = isSessionCurrentlyActive(sessionId);

      set((state) => ({
        ...(syncGlobal
          ? {
              runMode: nextMode,
              lifecycleState: nextLifecycle,
              proposedPlan: null,
            }
          : {}),
        runModeBySession: {
          ...state.runModeBySession,
          [sessionId]: nextMode,
        },
        lifecycleStateBySession: {
          ...state.lifecycleStateBySession,
          [sessionId]: nextLifecycle,
        },
        proposedPlanBySession: {
          ...state.proposedPlanBySession,
          [sessionId]: null,
        },
      }));

      useWorkbenchStore
        .getState()
        .setActivePlanState(
          approved
            ? null
            : {
                planId: `plan_rev_${Date.now()}`,
                plan: feedback || "",
                status: "rejected",
              },
          sessionId
        );

      // 决策通过后自动衔接下一轮 Act 执行或 Plan 重构流
      if (autoContinue && sessionId && !get().isStreamingForSession(sessionId)) {
        if (approved) {
          void get().sendStreamMessage(
            sessionId,
            "计划已批准，请切换至 Act 模式按计划逐步实施执行。",
            null,
            null,
            "act"
          );
        } else if (feedback && feedback.trim()) {
          void get().sendStreamMessage(
            sessionId,
            `请根据以下修改意见修订实现计划：\n${feedback.trim()}`,
            null,
            null,
            "plan"
          );
        }
      }

      return true;
    } catch (err) {
      console.error("[useChatStore] submitPlanDecision failed:", err);
      return false;
    }
  },

  applyBatchedStreamFrame: (frame: BatchedChatFrame) => {
    const {
      sessionId,
      messageId,
      textDelta,
      reasoningDelta,
      toolCallDeltas,
      parsedToolCallArgs,
    } = frame;
    set((state) => {
      const currentMessages = state.messagesBySession[sessionId];
      if (!currentMessages || currentMessages.length === 0) return state;

      // 优先精确命中 messageId，若因 steer 切消息兜底回退到最后一个 streaming assistant 消息
      let msgIndex = currentMessages.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) {
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          if (currentMessages[i].role === "assistant" && currentMessages[i].status === "streaming") {
            msgIndex = i;
            break;
          }
        }
      }
      if (msgIndex === -1) return state;

      const targetMsg = currentMessages[msgIndex];
      const nextContent = textDelta
        ? (targetMsg.content || "") + textDelta
        : targetMsg.content || "";
      const nextReasoning = reasoningDelta
        ? (targetMsg.reasoning_content || "") + reasoningDelta
        : targetMsg.reasoning_content || "";

      const hasDeltas = Boolean(
        toolCallDeltas && Object.keys(toolCallDeltas).length > 0
      );
      const hasParsed = Boolean(
        parsedToolCallArgs && Object.keys(parsedToolCallArgs).length > 0
      );

      let nextToolCalls = targetMsg.raw_tool_calls;
      if ((hasDeltas || hasParsed) && targetMsg.raw_tool_calls) {
        nextToolCalls = targetMsg.raw_tool_calls.map((tc) => {
          const parsed = parsedToolCallArgs?.[tc.id];
          const delta = toolCallDeltas?.[tc.id];
          if (!parsed && !delta) return tc;

          const baseArgs: Record<string, unknown> = { ...(tc.args || {}) };
          if (parsed) {
            delete baseArgs.raw_delta;
            return {
              ...tc,
              args: {
                ...baseArgs,
                ...parsed,
              },
            };
          }

          if (delta) {
            const combined = ((baseArgs.raw_delta as string) || "") + delta;
            try {
              const maybeParsed: unknown = JSON.parse(combined);
              if (
                typeof maybeParsed === "object" &&
                maybeParsed !== null &&
                !Array.isArray(maybeParsed)
              ) {
                delete baseArgs.raw_delta;
                return {
                  ...tc,
                  args: {
                    ...baseArgs,
                    ...(maybeParsed as Record<string, unknown>),
                  },
                };
              }
            } catch {
              // 半截 JSON，暂存 raw_delta 等待后续分片补全
            }
            return {
              ...tc,
              args: {
                ...baseArgs,
                raw_delta: combined,
              },
            };
          }

          return tc;
        });
      }

      const updatedMsg: Message = {
        ...targetMsg,
        content: nextContent,
        reasoning_content: nextReasoning || undefined,
        raw_tool_calls: nextToolCalls,
      };

      const updatedMessages = currentMessages.slice();
      updatedMessages[msgIndex] = updatedMsg;

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: updatedMessages,
        },
      };
    });
  },

  appendToolCall: (sessionId, messageId, toolCall) => {
    set((state) => {
      const list = state.messagesBySession[sessionId];
      if (!list) return state;
      const msgIdx = list.findIndex((m) => m.id === messageId);
      if (msgIdx === -1) return state;
      const target = list[msgIdx];
      const existingTools = target.raw_tool_calls || [];
      const dupIdx = existingTools.findIndex((t) => t.id === toolCall.id);
      const nextTools =
        dupIdx >= 0
          ? existingTools.map((t, i) => (i === dupIdx ? { ...t, ...toolCall } : t))
          : [...existingTools, toolCall];
      const nextList = list.slice();
      nextList[msgIdx] = { ...target, raw_tool_calls: nextTools };
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: nextList,
        },
      };
    });
  },

  updateToolCallResult: (sessionId, messageId, params) => {
    const { toolCallId, agentId, output, latencyMs, isError } = params;
    set((state) => {
      const list = state.messagesBySession[sessionId];
      if (!list) return state;
      const msgIdx = list.findIndex((m) => m.id === messageId);
      if (msgIdx === -1) return state;
      const target = list[msgIdx];
      if (!target.raw_tool_calls || target.raw_tool_calls.length === 0) return state;

      const nextTools = target.raw_tool_calls.map((tc) => {
        const isMatch =
          tc.id === toolCallId ||
          (agentId && tc.id === agentId) ||
          (agentId && `agent-${tc.id}` === agentId) ||
          (toolCallId && `agent-${toolCallId}` === tc.id);
        if (!isMatch) return tc;
        return {
          ...tc,
          output: output as string | Record<string, unknown> | undefined,
          latency_ms: latencyMs ?? tc.latency_ms,
          status: isError ? ("failed" as const) : ("success" as const),
        };
      });

      const nextList = list.slice();
      nextList[msgIdx] = { ...target, raw_tool_calls: nextTools };
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: nextList,
        },
      };
    });
  },

  syncSubagentToolCalls: (sessionId, items) => {
    if (!items || items.length === 0) return;
    set((state) => {
      const list = state.messagesBySession[sessionId];
      if (!list || list.length === 0) return state;

      let changed = false;
      const nextList = list.map((m) => {
        if (!m.raw_tool_calls || m.raw_tool_calls.length === 0) return m;
        let msgChanged = false;
        const nextTools = m.raw_tool_calls.map((tc) => {
          const matched = items.find((item) => {
            const rawId = item.agentId.replace(/^agent-/, "");
            return (
              tc.id === item.agentId ||
              tc.id === rawId ||
              (item.parentCallId && tc.id === item.parentCallId)
            );
          });
          if (!matched) return tc;

          const updatedStatus =
            matched.status === "completed"
              ? ("success" as const)
              : matched.status === "failed" || matched.status === "terminated"
              ? ("failed" as const)
              : tc.status;

          const nextArgs = {
            ...(tc.args || {}),
            ...(matched.taskPrompt ? { task_prompt: matched.taskPrompt } : {}),
            ...(matched.agentType ? { agent_type: matched.agentType, mode: matched.agentType } : {}),
            ...(matched.writeScope ? { write_scope: matched.writeScope } : {}),
          };

          const nextOutput =
            matched.summary &&
            (matched.status === "completed" ||
              matched.status === "failed" ||
              matched.status === "terminated")
              ? typeof tc.output === "object" && tc.output !== null
                ? { ...(tc.output as Record<string, unknown>), summary: matched.summary, agent_id: matched.agentId }
                : { summary: matched.summary, agent_id: matched.agentId }
              : tc.output;

          msgChanged = true;
          changed = true;
          return {
            ...tc,
            status: updatedStatus,
            args: nextArgs,
            output: nextOutput,
          };
        });
        return msgChanged ? { ...m, raw_tool_calls: nextTools } : m;
      });

      if (!changed) return state;
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: nextList,
        },
      };
    });
  },

  updateMessageMetrics: (sessionId, messageId, metrics) => {
    set((state) => {
      const list = state.messagesBySession[sessionId];
      if (!list) return state;
      const msgIdx = list.findIndex((m) => m.id === messageId);
      if (msgIdx === -1) return state;
      const nextList = list.slice();
      nextList[msgIdx] = {
        ...nextList[msgIdx],
        metrics: {
          ...(nextList[msgIdx].metrics || {}),
          ...metrics,
        },
      };
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: nextList,
        },
      };
    });
  },

  applyMidTaskSteered: (sessionId, messageId, steerText) => {
    set((state) => {
      const curQueue = state.steeringQueueBySession[sessionId] || [];
      const matched =
        curQueue.find((item) => item.content === steerText) || curQueue[0];
      const remaining = matched
        ? curQueue.filter((item) => item.id !== matched.id)
        : curQueue;

      const resolvedContent = steerText || matched?.content || "实时转向指令";
      const list = state.messagesBySession[sessionId] || [];

      // 查找 sendSteerMessage 乐观推入的待确认 steer_ 气泡（从后往前找最近一条）
      let optimisticSteerIdx = -1;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const msg = list[i];
        if (
          msg.role === "user" &&
          msg.id.startsWith("steer_") &&
          msg.status === "streaming" &&
          msg.content === resolvedContent
        ) {
          optimisticSteerIdx = i;
          break;
        }
      }

      const updatedList = list.map((m, idx) => {
        if (m.id === messageId) return { ...m, status: "success" as const };
        if (idx === optimisticSteerIdx) {
          return { ...m, status: "success" as const };
        }
        return m;
      });

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

      const nextMessages =
        optimisticSteerIdx !== -1
          ? [...updatedList, nextAiMsg]
          : [
              ...updatedList,
              {
                id: `user_steered_${Date.now()}`,
                session_id: sessionId,
                role: "user" as const,
                content: resolvedContent,
                status: "success" as const,
                created_at: new Date().toISOString(),
              },
              nextAiMsg,
            ];

      const curSessionStream = state.streamingSessions[sessionId];
      const nextStreamingSessions = curSessionStream
        ? {
            ...state.streamingSessions,
            [sessionId]: {
              ...curSessionStream,
              activeStreamingMessageId: nextAiId,
            },
          }
        : state.streamingSessions;

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: nextMessages,
        },
        steeringQueueBySession: {
          ...state.steeringQueueBySession,
          [sessionId]: remaining,
        },
        ...computeStreamingState(nextStreamingSessions),
      };
    });
  },

  applyStreamDone: (sessionId, messageId, params) => {
    const { durationMs, totalTokens, finalLifecycleState, mode } = params;
    set((state) => {
      const list = state.messagesBySession[sessionId] || [];
      const nextStreaming = { ...state.streamingSessions };
      delete nextStreaming[sessionId];
      const syncGlobal = isSessionCurrentlyActive(sessionId);

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: list.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  status: "success",
                  created_at: new Date().toISOString(),
                  metrics: {
                    latency_ms: durationMs,
                    tokens: totalTokens ?? m.metrics?.tokens,
                  },
                  raw_tool_calls: (m.raw_tool_calls || []).map((tc) => ({
                    ...tc,
                    status: tc.status === "failed" ? "failed" : "success",
                  })),
                }
              : m
          ),
        },
        ...computeStreamingState(nextStreaming),
        ...(syncGlobal ? { lifecycleState: finalLifecycleState } : {}),
        lifecycleStateBySession: {
          ...state.lifecycleStateBySession,
          [sessionId]: finalLifecycleState,
        },
        ...(mode
          ? {
              ...(syncGlobal ? { runMode: mode } : {}),
              runModeBySession: {
                ...state.runModeBySession,
                [sessionId]: mode,
              },
            }
          : {}),
      };
    });

    // 正常完成的 FIFO 自动出队（等待 Plan 审批时暂停自动出队）
    if (finalLifecycleState !== AgentLifecycleState.AWAITING_PLAN_APPROVAL) {
      const q = get().steeringQueueBySession[sessionId] || [];
      if (q.length > 0) {
        const nextItem = q[0];
        get().removeSteeringItem(sessionId, nextItem.id);
        setTimeout(() => {
          void get().sendStreamMessage(sessionId, nextItem.content);
        }, 100);
      }
    }
  },

  applyStreamError: (sessionId, messageId, errorMessage) => {
    useConfirmationStore.getState().resolveAllForSession(sessionId);
    set((state) => {
      const list = state.messagesBySession[sessionId] || [];
      const nextStreaming = { ...state.streamingSessions };
      delete nextStreaming[sessionId];
      const syncGlobal = isSessionCurrentlyActive(sessionId);

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: list.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  status: "failed",
                  content:
                    (m.content || "") + `\n\n*(生成中断: ${errorMessage})*`,
                }
              : m
          ),
        },
        ...computeStreamingState(nextStreaming),
        ...(syncGlobal ? { lifecycleState: AgentLifecycleState.INTERRUPTED } : {}),
        lifecycleStateBySession: {
          ...state.lifecycleStateBySession,
          [sessionId]: AgentLifecycleState.INTERRUPTED,
        },
      };
    });
  },

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
    useConfirmationStore.getState().resetStore();
    set({
      messagesBySession: {},
      streamingSessions: {},
      steeringQueueBySession: {},
      isStreaming: false,
      activeStreamingMessageId: null,
      streamingSessionId: null,
      abortController: null,
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
    parentId?: string | null,
    mode?: "plan" | "act"
  ) => {
    // Chat Override 乐观关闭该会话可能残留的确认气泡
    useConfirmationStore.getState().resolveAllForSession(sessionId);

    const sessionStreaming = get().streamingSessions[sessionId]?.isStreaming;
    if (sessionStreaming) {
      await get().stopGeneration(sessionId);
    }

    const effectiveMode: "plan" | "act" =
      mode || get().runModeBySession[sessionId] || get().runMode || "act";

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

    const controller = new AbortController();
    const currentMessages = get().messagesBySession[sessionId] || [];
    const nextInitialState =
      effectiveMode === "plan"
        ? AgentLifecycleState.PLANNING
        : AgentLifecycleState.COMPILING_CONTEXT;

    set((state) => {
      const nextStreamingSessions = {
        ...state.streamingSessions,
        [sessionId]: {
          isStreaming: true,
          activeStreamingMessageId: aiMsgId,
          abortController: controller,
        },
      };
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: [...currentMessages, userMsg, aiMsg],
        },
        ...computeStreamingState(nextStreamingSessions),
        runMode: effectiveMode,
        runModeBySession: {
          ...state.runModeBySession,
          [sessionId]: effectiveMode,
        },
        lifecycleState: nextInitialState,
        lifecycleStateBySession: {
          ...state.lifecycleStateBySession,
          [sessionId]: nextInitialState,
        },
      };
    });

    const activeModel = useModelConfigStore.getState().getActiveModel();
    const confirmPrefs = useConfirmationStore.getState();

    try {
      await sendMessageStream({
        sessionId,
        content,
        parentId: userMsgId,
        skillId,
        model: activeModel?.modelId || "deepseek-chat",
        mode: effectiveMode,
        permission_mode: confirmPrefs.permissionMode,
        allow_ask_user: confirmPrefs.allowAskUser,
        api_key: activeModel?.apiKey || undefined,
        base_url: activeModel?.baseUrl || undefined,
        provider: activeModel?.provider || "openai",
        max_tokens: activeModel?.maxTokens || undefined,
        context_window: activeModel?.contextWindow || undefined,
        signal: controller.signal,
        useDispatcher: true,
        dispatchContext: {
          sessionId,
          messageId: aiMsgId,
          turnStartTime,
        },
      });
    } catch (err: unknown) {
      // 先刷新尚未落盘的 rAF 缓冲，避免最后几帧文本丢失
      try {
        const { streamDispatcher } = await import("@/services/streamDispatcher");
        streamDispatcher.flush();
      } catch {}

      const activeAiId = get().getActiveStreamingMessageId(sessionId) || aiMsgId;

      if (controller.signal.aborted) {
        // 用户手动停止，将所有进行中的 todo 重置为 pending，防止界面继续 loading 转圈
        try {
          const todoStore = useTodoStore.getState();
          const currentTodos = todoStore.todosBySession[sessionId] || [];
          if (currentTodos.some((t) => t.status === "in_progress")) {
            todoStore.setTodos(
              sessionId,
              currentTodos.map((t) =>
                t.status === "in_progress" ? { ...t, status: "pending" } : t
              )
            );
          }
        } catch {}

        // 用户手动停止，收拢所有 running 中的子代理，彻底停止转圈
        cleanupRunningSubagents(sessionId, "failed");

        // 用户手动停止，保留已有片段
        set((state) => {
          const list = state.messagesBySession[sessionId] || [];
          const syncGlobal = isSessionCurrentlyActive(sessionId);
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: list.map((m) =>
                m.id === activeAiId
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
            ...(syncGlobal ? { lifecycleState: AgentLifecycleState.INTERRUPTED } : {}),
            lifecycleStateBySession: {
              ...state.lifecycleStateBySession,
              [sessionId]: AgentLifecycleState.INTERRUPTED,
            },
          };
        });
      } else {
        // 网络/服务连接异常时，同样收拢子代理状态
        cleanupRunningSubagents(sessionId, "failed");

        set((state) => {
          const list = state.messagesBySession[sessionId] || [];
          const syncGlobal = isSessionCurrentlyActive(sessionId);
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: list.map((m) =>
                m.id === activeAiId
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
            ...(syncGlobal ? { lifecycleState: AgentLifecycleState.INTERRUPTED } : {}),
            lifecycleStateBySession: {
              ...state.lifecycleStateBySession,
              [sessionId]: AgentLifecycleState.INTERRUPTED,
            },
          };
        });
      }
    } finally {
      if (get().streamingSessions[sessionId]) {
        set((state) => {
          const nextStreamingSessions = { ...state.streamingSessions };
          delete nextStreamingSessions[sessionId];
          return {
            ...computeStreamingState(nextStreamingSessions),
          };
        });
      }
    }
  },

  sendSteerMessage: async (sessionId: string, content: string) => {
    // Chat Override：发送 steering 前乐观关闭当前会话挂起气泡与纠偏横幅
    useConfirmationStore.getState().resolveAllForSession(sessionId);

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

  stopGeneration: async (sessionId: string) => {
    useConfirmationStore.getState().resolveAllForSession(sessionId);
    try {
      const { streamDispatcher } = await import("@/services/streamDispatcher");
      streamDispatcher.flush();
    } catch {}
    const sessionStream = get().streamingSessions[sessionId];
    if (sessionStream?.abortController) {
      sessionStream.abortController.abort();
    } else if (get().abortController && get().streamingSessionId === sessionId) {
      get().abortController?.abort();
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
      const nextStreamingSessions = { ...state.streamingSessions };
      delete nextStreamingSessions[sessionId];
      const syncGlobal = isSessionCurrentlyActive(sessionId);
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: updatedList,
        },
        ...computeStreamingState(nextStreamingSessions),
        ...(syncGlobal ? { lifecycleState: AgentLifecycleState.INTERRUPTED } : {}),
        lifecycleStateBySession: {
          ...state.lifecycleStateBySession,
          [sessionId]: AgentLifecycleState.INTERRUPTED,
        },
      };
    });
    await stopGenerationApi(sessionId);
  },

  switchSession: (newSessionId: string) => {
    const { fetchMessages } = get();
    // 关键改造：切走正在推流的会话时，不再调用 stopGeneration！
    // 允许上一会话继续在后台接收 SSE 流并写入 messagesBySession，实现完全多会话并发。
    if (newSessionId) {
      set((state) => ({
        runMode: state.runModeBySession[newSessionId] || "act",
        lifecycleState:
          state.lifecycleStateBySession[newSessionId] || AgentLifecycleState.IDLE,
        proposedPlan: state.proposedPlanBySession[newSessionId] || null,
        contextTelemetry: state.contextTelemetryBySession[newSessionId] || null,
      }));
      fetchMessages(newSessionId);
      useWorkbenchStore.getState().switchSessionWorkbench(newSessionId);
    }
  },

  fetchMessages: async (sessionId: string) => {
    if (!sessionId) return;
    // 若当前会话正在推流中，切勿打断或覆盖
    if (get().isStreamingForSession(sessionId)) {
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
