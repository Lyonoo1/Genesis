/**
 * 16ms requestAnimationFrame 批量流分发器 (StreamDispatcher)
 *
 * 核心机制：
 * 1. 彻底根除每个 SSE chunk 同步 set(...) 导致的 React 级联重渲染风暴 (Render Storm)。
 * 2. 高频事件 (text_delta, reasoning_delta, tool_call_delta, pty_output / terminal_output, subagent_progress)
 *    在内存缓冲池中按 (session_id, agent_id, message_id) 做字符串拼接与状态归并，
 *    通过 requestAnimationFrame（后台标签页或非浏览器环境回退至 16ms setTimeout）每帧最多触发 1 次 Zustand Store 批量原子更新。
 * 3. 低频关键控制事件 (tool_call_start, tool_call_result, state_transition, plan_proposed,
 *    permission_request, mid_task_steered, preempted, done, error 等) 先执行立即 flush() 保证严格时序，
 *    再按 channel 精准路由至对应 Store Slice。
 * 4. 维护 (session_id, turn_id, agent_id) 的 seq 水位线校验，防止同轮乱序/重复帧覆盖且避免跨轮误丢帧。
 * 5. 支持多路复用子代理流 (agent_id !== "root" && agent_id !== "main") 与主对话流的严格隔离。
 */

import {
  StreamEnvelope,
  StreamChannel,
  isStreamEnvelope,
  AgentLifecycleState,
  ContextTelemetryPayload,
  PlanProposedPayload,
  StateTransitionPayload,
  WorkbenchDiffPayload,
  WorkbenchPtyPayload,
} from "@/types/stream";
import {
  useChatStore,
  BatchedChatFrame,
  SubagentToolCallSyncItem,
} from "@/stores/useChatStore";
import {
  useWorkbenchStore,
  BatchedSubagentUpdate,
  SubagentInstance,
  SubagentMode,
  SubagentPanelTabConfig,
  SubagentStatus,
} from "@/stores/useWorkbenchStore";
import { useProcessStore } from "@/stores/useProcessStore";
import { useTodoStore } from "@/stores/useTodoStore";
import { useSessionStore } from "@/stores/useSessionStore";
import {
  useConfirmationStore,
  buildLegacyPermissionEvent,
} from "@/components/agent-confirmation/store/useConfirmationStore";
import type {
  ConfirmationRequestEvent,
  ConfirmationResolvedEvent,
} from "@/components/agent-confirmation/types/protocol";
import { ToolCallItem } from "@/types";

export interface DispatchContext {
  sessionId: string;
  messageId: string;
  turnStartTime?: number;
}

interface HighFreqBuffer {
  sessionId: string;
  messageId: string;
  textDelta: string;
  reasoningDelta: string;
  toolCallDeltas: Record<string, string>;
  subagentUpdates: Map<string, BatchedSubagentUpdate>;
  ptyChunks: Map<string, string[]>;
}

function normalizeSubagentMode(raw?: unknown): SubagentMode {
  const val = String(raw || "").toLowerCase();
  if (val === "code_worker") return "code_worker";
  if (val === "verify") return "verify";
  return "explore";
}

function normalizeSubagentStatus(raw?: unknown): SubagentStatus | undefined {
  if (!raw) return undefined;
  const val = String(raw).toLowerCase();
  if (val === "completed" || val === "success") return "completed";
  if (val === "failed" || val === "error") return "failed";
  if (val === "terminated" || val === "stopped" || val === "cancelled") {
    return "terminated";
  }
  if (
    val === "running" ||
    val === "started" ||
    val === "thinking" ||
    val === "executing_tools" ||
    val === "step_done"
  ) {
    return "running";
  }
  return undefined;
}

function isSubagentId(agentId?: string | null): boolean {
  return Boolean(agentId && agentId !== "root" && agentId !== "main");
}

function normalizePtySessionId(
  rawSid: unknown,
  fallbackChatSessionId: string
): string {
  const candidate = typeof rawSid === "string" ? rawSid.trim() : "";
  if (candidate) {
    if (candidate.startsWith("pty_") || candidate.startsWith("term-")) {
      return candidate;
    }
    return `pty_${candidate}`;
  }
  const fallback = (fallbackChatSessionId || "default").trim();
  return fallback.startsWith("pty_") ? fallback : `pty_${fallback}`;
}

function inferChannelByEvent(eventName: string, dataObj?: Record<string, unknown>): StreamChannel {
  const explicit = dataObj?.channel;
  if (
    explicit === StreamChannel.CHAT ||
    explicit === StreamChannel.WORKBENCH_DIFF ||
    explicit === StreamChannel.WORKBENCH_PTY ||
    explicit === StreamChannel.PLAN_STATE ||
    explicit === StreamChannel.CONTEXT_TELEMETRY
  ) {
    return explicit;
  }

  if (eventName === "workbench_file_change" || eventName === "workbench_diff") {
    return StreamChannel.WORKBENCH_DIFF;
  }
  if (eventName === "pty_output" || eventName === "terminal_output") {
    return StreamChannel.WORKBENCH_PTY;
  }
  if (eventName === "state_transition" || eventName === "plan_proposed") {
    return StreamChannel.PLAN_STATE;
  }
  if (eventName === "context_telemetry") {
    return StreamChannel.CONTEXT_TELEMETRY;
  }
  return StreamChannel.CHAT;
}

export class StreamDispatcher {
  // seq 水位线：key = `${sessionId}:${turnId}:${agentId}`
  private watermarkMap: Map<string, number> = new Map();
  // 记录每个 session 当前活跃的 turn_id
  private activeTurnBySession: Map<string, string> = new Map();
  // 记录每个 session 已过期/已结束的历史 turn_id，防止延迟幽灵帧破坏当前轮次水位线
  private expiredTurnsBySession: Map<string, Set<string>> = new Map();

  // 流式工具参数 JSON 拼接缓冲与工具名索引：key = `${sessionId}:${messageId}:${toolCallId}`
  private toolCallArgBuffers: Map<string, string> = new Map();
  private toolCallNames: Map<string, string> = new Map();

  // 高频批处理缓冲池：key = `${sessionId}:${messageId}`
  private buffers: Map<string, HighFreqBuffer> = new Map();

  // 调度句柄
  private rafId: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private isFlushScheduled = false;

  private markTurnExpired(sessionId: string, turnId: string): void {
    if (!turnId) return;
    let set = this.expiredTurnsBySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.expiredTurnsBySession.set(sessionId, set);
    }
    set.add(turnId);
    // 防止长期运行内存无限增长，仅保留最近 32 个历史 turn_id
    if (set.size > 32) {
      const oldest = set.values().next().value;
      if (oldest) set.delete(oldest);
    }
    const oldPrefix = `${sessionId}:${turnId}:`;
    for (const key of Array.from(this.watermarkMap.keys())) {
      if (key.startsWith(oldPrefix)) {
        this.watermarkMap.delete(key);
      }
    }
  }

  /**
   * 统一解包标准 StreamEnvelope、parseSSEStream 封装帧 ({ event, data: StreamEnvelope }) 及旧版裸 SSE 载荷
   */
  private normalizeEnvelope(
    rawMessage: unknown,
    context?: DispatchContext
  ): StreamEnvelope<Record<string, unknown>> | null {
    if (!rawMessage || typeof rawMessage !== "object") return null;

    // 1. 直接传入的就是标准 StreamEnvelope
    if (isStreamEnvelope(rawMessage)) {
      return rawMessage;
    }

    // 2. parseSSEStream 传出格式 { event, data }
    const wrapper = rawMessage as { event?: string; data?: unknown };
    if (isStreamEnvelope(wrapper.data)) {
      const inner = wrapper.data;
      return {
        ...inner,
        event: inner.event || wrapper.event || "unknown",
      };
    }

    // 3. 兼容无 seq 的旧事件载荷与离线 Mock 流
    const eventName = wrapper.event || "unknown";
    const dataObj: Record<string, unknown> =
      typeof wrapper.data === "object" && wrapper.data !== null
        ? (wrapper.data as Record<string, unknown>)
        : { raw: wrapper.data };

    const channel = inferChannelByEvent(eventName, dataObj);

    return {
      seq: typeof dataObj.seq === "number" ? dataObj.seq : -1,
      turn_id:
        typeof dataObj.turn_id === "string" && dataObj.turn_id
          ? dataObj.turn_id
          : context?.messageId || context?.sessionId || "legacy_turn",
      agent_id:
        typeof dataObj.agent_id === "string" && dataObj.agent_id
          ? dataObj.agent_id
          : "root",
      parent_call_id:
        typeof dataObj.parent_call_id === "string" ? dataObj.parent_call_id : null,
      channel,
      event: eventName,
      payload: dataObj,
      timestamp:
        typeof dataObj.timestamp === "number" ? dataObj.timestamp : Date.now(),
    };
  }

  /**
   * 分发入口：同时兼容标准 StreamEnvelope、parseSSEStream 包装帧与旧版裸 SSE / Mock 事件
   */
  public dispatch(rawMessage: unknown, context?: DispatchContext): void {
    const envelope = this.normalizeEnvelope(rawMessage, context);
    if (!envelope) return;

    // 1. 严格解析真实 sessionId 与动态 messageId（避免 turn_id 污染 sessionId，且支持 mid_task_steered 换气泡）
    const sessionId =
      context?.sessionId ||
      (typeof envelope.payload?.session_id === "string" &&
      envelope.payload.session_id
        ? envelope.payload.session_id
        : "default");

    const chatState = useChatStore.getState();
    const messageId =
      chatState.getActiveStreamingMessageId(sessionId) ||
      context?.messageId ||
      (typeof envelope.payload?.message_id === "string" &&
      envelope.payload.message_id
        ? envelope.payload.message_id
        : `msg_${Date.now()}`);

    // 2. seq 水位线校验：按 (sessionId, turn_id, agent_id) 严格防乱序/重复帧及过期旧轮次延迟幽灵帧
    if (typeof envelope.seq === "number" && envelope.seq >= 0) {
      const turnId = envelope.turn_id || "default_turn";
      const expiredTurns = this.expiredTurnsBySession.get(sessionId);
      if (expiredTurns?.has(turnId)) {
        // 已过期旧轮次的延迟幽灵帧，直接丢弃且绝不破坏当前活跃轮次水位线
        return;
      }

      const prevTurn = this.activeTurnBySession.get(sessionId);
      if (prevTurn && prevTurn !== turnId) {
        // 合法的新一轮始终从 seq === 1 (或 0) 启动；若突然到达一个非活跃 turn 且 seq > 1，视为残留旧轮次延迟包直接丢弃
        if (envelope.seq > 1) {
          this.markTurnExpired(sessionId, turnId);
          return;
        }
        // 新一轮对话正式开启，将上一轮标记为过期并清理上一轮水位线
        this.markTurnExpired(sessionId, prevTurn);
      }
      this.activeTurnBySession.set(sessionId, turnId);

      const agentKey = envelope.agent_id || "root";
      const watermarkKey = `${sessionId}:${turnId}:${agentKey}`;
      const lastSeq = this.watermarkMap.get(watermarkKey);
      if (lastSeq !== undefined && envelope.seq <= lastSeq) {
        // 丢弃乱序旧帧或重复帧，保护状态机完整性
        return;
      }
      this.watermarkMap.set(watermarkKey, envelope.seq);
    }

    // 3. 区分高频增量流与低频关键控制事件
    if (this.isHighFrequencyEvent(envelope.event)) {
      this.bufferHighFrequencyEvent(sessionId, messageId, envelope);
      this.scheduleBatchFlush();
    } else {
      // 低频关键控制事件：必须先立即 flush() 冲刷缓冲池，保证时序 100% 严格一致
      this.flush();
      this.routeControlEvent(sessionId, messageId, envelope, context);
      if (
        (envelope.event === "done" || envelope.event === "error") &&
        typeof envelope.seq === "number" &&
        envelope.seq >= 0 &&
        envelope.turn_id
      ) {
        this.markTurnExpired(sessionId, envelope.turn_id);
        if (this.activeTurnBySession.get(sessionId) === envelope.turn_id) {
          this.activeTurnBySession.delete(sessionId);
        }
      }
    }
  }

  /**
   * 判断是否为高频增量事件
   */
  private isHighFrequencyEvent(event: string): boolean {
    return (
      event === "text_delta" ||
      event === "reasoning_delta" ||
      event === "tool_call_delta" ||
      event === "pty_output" ||
      event === "terminal_output" ||
      event === "subagent_progress"
    );
  }

  /**
   * 写入高频内存缓冲池（按 sessionId + messageId 聚合，内部按 agent_id 归并）
   */
  private bufferHighFrequencyEvent(
    sessionId: string,
    messageId: string,
    envelope: StreamEnvelope<Record<string, unknown>>
  ): void {
    const bufferKey = `${sessionId}:${messageId}`;
    let buf = this.buffers.get(bufferKey);
    if (!buf) {
      buf = {
        sessionId,
        messageId,
        textDelta: "",
        reasoningDelta: "",
        toolCallDeltas: {},
        subagentUpdates: new Map(),
        ptyChunks: new Map(),
      };
      this.buffers.set(bufferKey, buf);
    }

    const payload = envelope.payload || {};
    const event = envelope.event;
    const effectiveAgentId =
      (typeof payload.agent_id === "string" && payload.agent_id) ||
      envelope.agent_id ||
      "root";
    const fromSubagent = isSubagentId(effectiveAgentId);

    if (event === "text_delta") {
      const delta =
        (typeof payload.delta === "string" ? payload.delta : "") ||
        (typeof payload.text === "string" ? payload.text : "");
      if (!delta) return;

      if (fromSubagent) {
        // 多路复用子代理输出流，写入子代理摘要增量，严禁污染主对话气泡
        const existing = buf.subagentUpdates.get(effectiveAgentId) || {
          agentId: effectiveAgentId,
          parentCallId: envelope.parent_call_id || undefined,
        };
        buf.subagentUpdates.set(effectiveAgentId, {
          ...existing,
          parentCallId: existing.parentCallId || envelope.parent_call_id || undefined,
          summaryDelta: (existing.summaryDelta || "") + delta,
        });
      } else {
        buf.textDelta += delta;
      }
      return;
    }

    if (event === "reasoning_delta") {
      const delta =
        (typeof payload.delta === "string" ? payload.delta : "") ||
        (typeof payload.text === "string" ? payload.text : "");
      if (!delta) return;

      if (fromSubagent) {
        const existing = buf.subagentUpdates.get(effectiveAgentId) || {
          agentId: effectiveAgentId,
          parentCallId: envelope.parent_call_id || undefined,
        };
        buf.subagentUpdates.set(effectiveAgentId, {
          ...existing,
          parentCallId: existing.parentCallId || envelope.parent_call_id || undefined,
          thinkingDelta: (existing.thinkingDelta || "") + delta,
        });
      } else {
        buf.reasoningDelta += delta;
      }
      return;
    }

    if (event === "tool_call_delta") {
      const tcId = (payload.tool_call_id as string) || "unknown";
      const delta = (payload.delta as string) || "";
      if (delta) {
        buf.toolCallDeltas[tcId] = (buf.toolCallDeltas[tcId] || "") + delta;
        const argKey = `${sessionId}:${messageId}:${tcId}`;
        this.toolCallArgBuffers.set(
          argKey,
          (this.toolCallArgBuffers.get(argKey) || "") + delta
        );
      }
      return;
    }

    if (event === "pty_output" || event === "terminal_output") {
      const ptySid = normalizePtySessionId(
        payload.pty_session_id || payload.session_id,
        sessionId
      );
      const chunk =
        (typeof payload.chunk === "string" ? payload.chunk : "") ||
        (typeof payload.output === "string" ? payload.output : "");
      if (chunk) {
        const list = buf.ptyChunks.get(ptySid) || [];
        list.push(chunk);
        buf.ptyChunks.set(ptySid, list);
      }
      return;
    }

    if (event === "subagent_progress") {
      // 保留后端原始 agent_id（如 subagent_1_xxx 或 agent-xxx），严禁篡改前缀导致 steer/stop 404
      const agentId =
        (typeof payload.agent_id === "string" && payload.agent_id) ||
        (fromSubagent ? effectiveAgentId : "unknown");
      if (agentId === "unknown") return;

      const existing = buf.subagentUpdates.get(agentId) || {
        agentId,
        parentCallId: envelope.parent_call_id || undefined,
      };

      const rawMode = payload.mode || payload.agent_type;
      const agentType = rawMode
        ? normalizeSubagentMode(rawMode)
        : existing.agentType;

      const deltaThinking =
        (typeof payload.thinking_delta === "string" ? payload.thinking_delta : "") ||
        "";
      const fullThinking =
        (typeof payload.thinking === "string" ? payload.thinking : "") ||
        (typeof payload.thinking_content === "string" ? payload.thinking_content : "") ||
        undefined;

      const mappedStatus = normalizeSubagentStatus(payload.status);
      const writeScope = Array.isArray(payload.write_scope)
        ? payload.write_scope.map((s: unknown) => String(s))
        : existing.writeScope;

      const hasStep =
        typeof payload.step === "number" &&
        payload.step > 0 &&
        (payload.status === "executing_tools" ||
          payload.status === "step_done" ||
          (Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0));

      buf.subagentUpdates.set(agentId, {
        ...existing,
        parentCallId: existing.parentCallId || envelope.parent_call_id || undefined,
        agentType,
        writeScope,
        taskPrompt:
          (typeof payload.task_prompt === "string" && payload.task_prompt) ||
          existing.taskPrompt,
        thinking: fullThinking !== undefined ? fullThinking : existing.thinking,
        thinkingDelta: deltaThinking
          ? (existing.thinkingDelta || "") + deltaThinking
          : existing.thinkingDelta,
        status: mappedStatus || existing.status,
        currentStep:
          typeof payload.step === "number" ? payload.step : existing.currentStep,
        maxSteps:
          typeof payload.max_steps === "number"
            ? payload.max_steps
            : existing.maxSteps,
        summary:
          typeof payload.summary_preview === "string" &&
          payload.summary_preview &&
          mappedStatus === "completed"
            ? payload.summary_preview
            : existing.summary,
        errorMessage:
          (typeof payload.error_message === "string" && payload.error_message) ||
          (typeof payload.error === "string" && payload.error) ||
          existing.errorMessage,
        errorCode:
          (typeof payload.error_code === "string" && payload.error_code) ||
          existing.errorCode,
        step: hasStep
          ? {
              index: payload.step as number,
              toolName:
                (Array.isArray(payload.tool_calls) && payload.tool_calls[0]) ||
                "tool",
              status:
                payload.status === "step_done" || payload.status === "completed"
                  ? "done"
                  : "running",
              preview:
                typeof payload.summary_preview === "string"
                  ? payload.summary_preview
                  : undefined,
              thinking: fullThinking || deltaThinking || undefined,
            }
          : existing.step,
      });
    }
  }

  /**
   * 16ms 调度机制：浏览器前台优先使用 requestAnimationFrame，后台标签页或非浏览器环境回退至 16ms setTimeout
   */
  private scheduleBatchFlush(): void {
    if (this.isFlushScheduled) return;
    this.isFlushScheduled = true;

    const isBrowser = typeof window !== "undefined";
    const isHidden =
      isBrowser && typeof document !== "undefined" && document.hidden;

    if (
      isBrowser &&
      !isHidden &&
      typeof window.requestAnimationFrame === "function"
    ) {
      this.rafId = window.requestAnimationFrame(() => {
        this.runFlushCycle();
      });
    } else {
      this.timerId = setTimeout(() => {
        this.runFlushCycle();
      }, 16);
    }
  }

  private runFlushCycle(): void {
    this.rafId = null;
    this.timerId = null;
    this.isFlushScheduled = false;
    this.flush();
  }

  /**
   * 立即清空并提交所有缓冲池数据（每帧最多触发 1 次 Zustand Store 批量原子更新）
   */
  public flush(): void {
    if (this.rafId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.isFlushScheduled = false;

    if (this.buffers.size === 0) return;

    const pendingEntries = Array.from(this.buffers.values());
    this.buffers.clear();

    const chatStore = useChatStore.getState();
    const wbStore = useWorkbenchStore.getState();

    for (const buf of pendingEntries) {
      // 0. 尝试解析累积的 tool_call_delta JSON 参数；若为子代理工具，同步补全工作台子代理实例元数据
      const parsedToolCallArgs: Record<string, Record<string, unknown>> = {};
      const deltaIds = Object.keys(buf.toolCallDeltas);
      for (const tcId of deltaIds) {
        const argKey = `${buf.sessionId}:${buf.messageId}:${tcId}`;
        const accumulated = this.toolCallArgBuffers.get(argKey);
        if (!accumulated) continue;
        try {
          const parsed: unknown = JSON.parse(accumulated);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
          ) {
            const parsedObj = parsed as Record<string, unknown>;
            parsedToolCallArgs[tcId] = parsedObj;

            const tcName = this.toolCallNames.get(argKey) || "";
            if (
              tcName.includes("spawn_agent") ||
              tcName.includes("dispatch_subagent")
            ) {
              const targetAgentId = tcName.includes("dispatch_subagent")
                ? tcId.startsWith("agent-")
                  ? tcId
                  : `agent-${tcId}`
                : tcId;
              const existingSub = buf.subagentUpdates.get(targetAgentId) || {
                agentId: targetAgentId,
                parentCallId: tcId,
              };
              const rawMode = parsedObj.mode || parsedObj.agent_type;
              const taskPrompt =
                typeof parsedObj.task === "string"
                  ? parsedObj.task
                  : typeof parsedObj.task_prompt === "string"
                  ? parsedObj.task_prompt
                  : typeof parsedObj.prompt === "string"
                  ? parsedObj.prompt
                  : undefined;
              const writeScope = Array.isArray(parsedObj.write_scope)
                ? parsedObj.write_scope.map((s: unknown) => String(s))
                : undefined;

              buf.subagentUpdates.set(targetAgentId, {
                ...existingSub,
                parentCallId: existingSub.parentCallId || tcId,
                agentType: rawMode
                  ? normalizeSubagentMode(rawMode)
                  : existingSub.agentType,
                taskPrompt: taskPrompt || existingSub.taskPrompt,
                writeScope:
                  writeScope && writeScope.length > 0
                    ? writeScope
                    : existingSub.writeScope,
                maxSteps:
                  typeof parsedObj.max_steps === "number"
                    ? parsedObj.max_steps
                    : existingSub.maxSteps,
              });
            }
          }
        } catch {
          // 仍在流式拼接 JSON 中，等待后续分片
        }
      }

      // 1. 批量提交主聊天文本 / 思考 / 工具增量（单次原子更新）
      if (
        buf.textDelta ||
        buf.reasoningDelta ||
        deltaIds.length > 0 ||
        Object.keys(parsedToolCallArgs).length > 0
      ) {
        const frame: BatchedChatFrame = {
          sessionId: buf.sessionId,
          messageId: buf.messageId,
          textDelta: buf.textDelta || undefined,
          reasoningDelta: buf.reasoningDelta || undefined,
          toolCallDeltas:
            deltaIds.length > 0 ? buf.toolCallDeltas : undefined,
          parsedToolCallArgs:
            Object.keys(parsedToolCallArgs).length > 0
              ? parsedToolCallArgs
              : undefined,
        };
        chatStore.applyBatchedStreamFrame(frame);
      }

      // 2. 批量提交子代理进度更新至工作台，并单次同步反哺主消息 raw_tool_calls
      if (buf.subagentUpdates.size > 0) {
        const updates = Array.from(buf.subagentUpdates.values());
        wbStore.applyBatchedSubagentFrame(buf.sessionId, updates);

        const syncItems: SubagentToolCallSyncItem[] = updates.map((u) => ({
          agentId: u.agentId,
          parentCallId: u.parentCallId,
          status: u.status,
          summary: u.summary,
          taskPrompt: u.taskPrompt,
          agentType: u.agentType,
          writeScope: u.writeScope,
        }));
        chatStore.syncSubagentToolCalls(buf.sessionId, syncItems);
      }

      // 3. 批量提交 PTY 输出至工作台缓冲并派发终端监听事件
      if (buf.ptyChunks.size > 0) {
        for (const [ptySid, chunks] of Array.from(buf.ptyChunks.entries())) {
          const merged = chunks.join("");
          wbStore.appendPtyBuffer(ptySid, merged);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("genesis:pty-output", {
                detail: { ptySessionId: ptySid, chunk: merged },
              })
            );
          }
        }
      }
    }
  }

  /**
   * 精确路由低频关键控制事件
   */
  private routeControlEvent(
    sessionId: string,
    messageId: string,
    envelope: StreamEnvelope<Record<string, unknown>>,
    context?: DispatchContext
  ): void {
    const payload = envelope.payload || {};
    const event = envelope.event;
    const channel = envelope.channel;
    const chatStore = useChatStore.getState();
    const wbStore = useWorkbenchStore.getState();

    // =========================================================================
    // A. Channel: plan_state (双模态状态跃迁 & 计划提案审批)
    // =========================================================================
    if (
      channel === StreamChannel.PLAN_STATE ||
      event === "plan_proposed" ||
      event === "state_transition"
    ) {
      if (event === "plan_proposed") {
        const proposed = payload as unknown as PlanProposedPayload;
        const planText = proposed.plan || "";
        const planId = proposed.plan_id || `plan_${Date.now()}`;
        chatStore.setLifecycleState(
          AgentLifecycleState.AWAITING_PLAN_APPROVAL,
          sessionId
        );
        chatStore.setProposedPlan(
          { planId, plan: planText, step: proposed.step },
          sessionId
        );
        wbStore.setActivePlanState(
          {
            planId,
            plan: planText,
            status: "awaiting_approval",
            step: proposed.step,
          },
          sessionId
        );
      } else if (event === "state_transition") {
        const trans = payload as unknown as StateTransitionPayload;
        if (trans.to_state) {
          chatStore.setLifecycleState(trans.to_state, sessionId);
        }
        if (trans.mode === "plan" || trans.mode === "act") {
          chatStore.setRunMode(trans.mode, sessionId);
        }
      }
      return;
    }

    // =========================================================================
    // B. Channel: context_telemetry (上下文编译遥测)
    // =========================================================================
    if (
      channel === StreamChannel.CONTEXT_TELEMETRY ||
      event === "context_telemetry"
    ) {
      chatStore.setContextTelemetry(
        payload as unknown as ContextTelemetryPayload,
        sessionId
      );
      return;
    }

    // =========================================================================
    // C. Channel: workbench_diff (实时文件变更 Diff)
    // =========================================================================
    if (
      channel === StreamChannel.WORKBENCH_DIFF ||
      event === "workbench_file_change" ||
      event === "workbench_diff"
    ) {
      const diffPayload = payload as unknown as WorkbenchDiffPayload;
      if (diffPayload.path) {
        const realPatchId =
          diffPayload.patch_id || diffPayload.snapshot_id || undefined;
        wbStore.recordFileDiff(
          {
            path: diffPayload.path,
            name:
              diffPayload.name ||
              diffPayload.path.split("/").pop() ||
              "modified_file",
            additions: diffPayload.additions || 0,
            deletions: diffPayload.deletions || 0,
            originalContent: diffPayload.original_content || "",
            modifiedContent: diffPayload.modified_content || "",
            unifiedDiff: diffPayload.unified_diff || diffPayload.diff || "",
            ...(realPatchId
              ? { patchId: realPatchId, patch_id: realPatchId }
              : {}),
            status: "pending",
          },
          sessionId
        );
        wbStore.triggerPreviewReload();
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("genesis:workspace-refresh", {
              detail: { path: diffPayload.path, patchId: realPatchId },
            })
          );
        }
      }
      return;
    }

    // =========================================================================
    // D. Channel: workbench_pty (非增量 PTY 控制事件)
    // =========================================================================
    if (channel === StreamChannel.WORKBENCH_PTY) {
      const ptyPayload = payload as unknown as WorkbenchPtyPayload;
      const chunk = ptyPayload.chunk || ptyPayload.output || "";
      if (chunk) {
        const ptySid = normalizePtySessionId(
          ptyPayload.pty_session_id || ptyPayload.session_id,
          sessionId
        );
        wbStore.appendPtyBuffer(ptySid, chunk);
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("genesis:pty-output", {
              detail: { ptySessionId: ptySid, chunk },
            })
          );
        }
      }
      return;
    }

    // =========================================================================
    // E. Channel: chat 与全局业务控制事件
    // =========================================================================
    const effectiveAgentId =
      (typeof payload.agent_id === "string" && payload.agent_id) ||
      envelope.agent_id ||
      "root";
    const fromSubagent = isSubagentId(effectiveAgentId);

    switch (event) {
      case "session_info": {
        if (payload.mode === "plan" || payload.mode === "act") {
          chatStore.setRunMode(payload.mode, sessionId);
        }
        break;
      }

      case "tool_call_start":
      case "tool_start": {
        const name = (payload.name as string) || "";
        const toolCallId =
          (payload.tool_call_id as string) || `tc_${Date.now()}`;
        const args = (payload.args || payload.arguments || {}) as Record<
          string,
          unknown
        >;

        // 若该 tool_call_start 来自子代理内部工具执行，归入对应子代理步骤而非主消息
        const isInternalSubagentTool =
          fromSubagent &&
          (!envelope.parent_call_id || toolCallId !== envelope.parent_call_id);
        if (isInternalSubagentTool) {
          const targetAgent = this.findSubagent(sessionId, effectiveAgentId);
          const nextIdx = (targetAgent?.steps?.length || 0) + 1;
          wbStore.applyBatchedSubagentFrame(sessionId, [
            {
              agentId: effectiveAgentId,
              parentCallId: envelope.parent_call_id || undefined,
              status: "running",
              step: {
                index: nextIdx,
                toolCallId,
                toolName: name || "tool",
                status: "running",
                preview: this.formatToolArgsPreview(name, args),
              },
            },
          ]);
          break;
        }

        // 登记主代理工具名称并重置流式参数 JSON 缓冲
        const argKey = `${sessionId}:${messageId}:${toolCallId}`;
        this.toolCallNames.set(argKey, name);
        this.toolCallArgBuffers.set(argKey, "");

        // 主代理调用子代理原语：注册子代理实例供内联卡片与右侧栏实时消费
        if (
          name.includes("dispatch_subagent") ||
          name.includes("spawn_agent")
        ) {
          try {
            const mode = normalizeSubagentMode(args.mode || args.agent_type);
            const taskPrompt =
              typeof args.task === "string"
                ? args.task
                : typeof args.task_prompt === "string"
                ? args.task_prompt
                : typeof args.prompt === "string"
                ? args.prompt
                : "";
            const writeScope = Array.isArray(args.write_scope)
              ? args.write_scope.map((s: unknown) => String(s))
              : undefined;
            const initialAgentId = name.includes("dispatch_subagent")
              ? toolCallId.startsWith("agent-")
                ? toolCallId
                : `agent-${toolCallId}`
              : toolCallId;

            wbStore.addAgentInstance(initialAgentId, mode, taskPrompt, sessionId, {
              parentCallId: toolCallId,
              writeScope,
              maxSteps: typeof args.max_steps === "number" ? args.max_steps : 8,
            });
          } catch (e) {
            console.warn("[StreamDispatcher] Failed to init subagent:", e);
          }
        }

        const toolItem: ToolCallItem = {
          id: toolCallId,
          name,
          args,
          status: "running",
        };
        chatStore.appendToolCall(sessionId, messageId, toolItem);
        break;
      }

      case "tool_call_result":
      case "tool_result": {
        const name = (payload.name as string) || "";
        const toolCallId = (payload.tool_call_id as string) || "";
        const payloadAgentId = (payload.agent_id as string) || "";
        const isError = Boolean(payload.is_error);
        const rawOutput =
          payload.result !== undefined ? payload.result : payload.output;
        const resObj =
          typeof rawOutput === "object" && rawOutput !== null
            ? (rawOutput as Record<string, unknown>)
            : undefined;

        // 若是子代理内部工具执行结果，只更新子代理步骤，不污染主消息 raw_tool_calls
        const isInternalSubagentToolResult =
          fromSubagent &&
          (!envelope.parent_call_id || toolCallId !== envelope.parent_call_id) &&
          !name.includes("dispatch_subagent") &&
          !name.includes("spawn_agent");
        if (isInternalSubagentToolResult) {
          const targetAgent = this.findSubagent(sessionId, effectiveAgentId);
          const matchedStep = targetAgent?.steps?.find(
            (s) => s.toolCallId === toolCallId
          );
          const stepIndex = matchedStep?.index || (targetAgent?.steps?.length || 1);
          const preview = isError
            ? String(resObj?.error || "执行失败")
            : this.formatToolResultPreview(name, resObj);

          wbStore.applyBatchedSubagentFrame(sessionId, [
            {
              agentId: effectiveAgentId,
              parentCallId: envelope.parent_call_id || undefined,
              step: {
                index: stepIndex,
                toolCallId,
                toolName: name || matchedStep?.toolName || "tool",
                status: "done",
                preview,
              },
            },
          ]);
          break;
        }

        const doneArgKey = `${sessionId}:${messageId}:${toolCallId}`;
        this.toolCallArgBuffers.delete(doneArgKey);
        this.toolCallNames.delete(doneArgKey);

        // 若是主代理 workspace__spawn_agent 返回了真实 agent_id，立刻将占位实例绑定为真实 subagent_x_xxx
        if (name.includes("spawn_agent") && resObj) {
          const realAgentId =
            typeof resObj.agent_id === "string" ? resObj.agent_id : "";
          if (realAgentId) {
            wbStore.bindSubagentId(
              toolCallId,
              realAgentId,
              {
                agentType: resObj.mode
                  ? normalizeSubagentMode(resObj.mode)
                  : undefined,
                writeScope: Array.isArray(resObj.write_scope)
                  ? resObj.write_scope.map((s: unknown) => String(s))
                  : undefined,
                status: isError
                  ? "failed"
                  : normalizeSubagentStatus(resObj.status) || "running",
              },
              sessionId
            );
          } else if (isError) {
            wbStore.updateAgentInstance(
              toolCallId,
              { status: "failed", summary: String(resObj.error || "派发失败") },
              sessionId
            );
          }
        }

        // 若是主代理 workspace__close_agent 或 wait_agent 返回了状态更新，同步更新工作台子代理状态
        if (name.includes("close_agent") && resObj?.agent_id) {
          wbStore.markSubagentStopped(String(resObj.agent_id), sessionId);
        } else if (name.includes("wait_agent") && resObj?.completed && typeof resObj.completed === "object") {
          const updates: BatchedSubagentUpdate[] = [];
          for (const [aid, rawInfo] of Object.entries(
            resObj.completed as Record<string, unknown>
          )) {
            if (!rawInfo || typeof rawInfo !== "object") continue;
            const info = rawInfo as Record<string, unknown>;
            const mappedStatus = normalizeSubagentStatus(info.status) || "completed";
            updates.push({
              agentId: aid,
              status: mappedStatus,
              summary:
                mappedStatus === "completed" && typeof info.summary === "string"
                  ? info.summary
                  : undefined,
              errorMessage:
                typeof info.error === "string" && info.error
                  ? info.error
                  : undefined,
              errorCode:
                typeof info.error_code === "string" && info.error_code
                  ? info.error_code
                  : undefined,
              currentStep:
                typeof info.steps_taken === "number" ? info.steps_taken : undefined,
            });
          }
          if (updates.length > 0) {
            wbStore.applyBatchedSubagentFrame(sessionId, updates);
          }
        }

        if (
          typeof window !== "undefined" &&
          name.startsWith("workspace__") &&
          !isError
        ) {
          window.dispatchEvent(new CustomEvent("genesis:workspace-refresh"));
        }

        // 提取 Diff（保留后端生成的真实 patch_id）
        if (resObj) {
          const diffStr = resObj.diff || resObj.unified_diff;
          if (diffStr && typeof diffStr === "string") {
            const filePath = typeof resObj.path === "string" ? resObj.path : "";
            const realPatchId =
              typeof resObj.patch_id === "string" && resObj.patch_id
                ? resObj.patch_id
                : undefined;
            if (filePath) {
              wbStore.recordFileDiff(
                {
                  path: filePath,
                  name:
                    (typeof resObj.name === "string" && resObj.name) ||
                    filePath.split("/").pop() ||
                    "modified_file",
                  additions: typeof resObj.additions === "number" ? resObj.additions : 0,
                  deletions: typeof resObj.deletions === "number" ? resObj.deletions : 0,
                  originalContent:
                    typeof resObj.original_content === "string" ? resObj.original_content : "",
                  modifiedContent:
                    typeof resObj.modified_content === "string" ? resObj.modified_content : "",
                  unifiedDiff: diffStr,
                  ...(realPatchId
                    ? { patchId: realPatchId, patch_id: realPatchId }
                    : {}),
                  status: "pending",
                },
                sessionId
              );
              wbStore.triggerPreviewReload();
            }
          }

          const targetUrl = resObj.url || resObj.detected_url;
          if (targetUrl && typeof targetUrl === "string") {
            wbStore.setPreviewUrl(targetUrl, false, sessionId);
          }
          if (resObj.status === "running_in_background" && typeof resObj.pid === "number") {
            useProcessStore.getState().addProcess({
              pid: resObj.pid,
              command: typeof resObj.command === "string" ? resObj.command : "unknown",
              session_id: sessionId,
            });
          }
        }

        chatStore.updateToolCallResult(sessionId, messageId, {
          toolCallId,
          agentId: payloadAgentId || undefined,
          output: rawOutput,
          latencyMs:
            typeof payload.latency_ms === "number"
              ? payload.latency_ms
              : undefined,
          isError,
        });
        break;
      }

      case "usage": {
        chatStore.updateMessageMetrics(sessionId, messageId, {
          latency_ms:
            typeof payload.latency_ms === "number"
              ? payload.latency_ms
              : undefined,
          tokens:
            typeof payload.tokens === "number" ? payload.tokens : undefined,
        });
        break;
      }

      case "workbench_preview": {
        if (payload?.url) {
          wbStore.setPreviewUrl(String(payload.url), false, sessionId);
        }
        break;
      }

      case "workbench_todos": {
        if (Array.isArray(payload?.todos) && (payload.session_id || sessionId)) {
          useTodoStore
            .getState()
            .setTodos(
              String(payload.session_id || sessionId),
              payload.todos as Array<{
                id: string;
                content: string;
                status: "pending" | "in_progress" | "completed";
              }>
            );
        }
        break;
      }

      case "session_title_updated": {
        if (payload?.title) {
          useSessionStore
            .getState()
            .updateSessionDetails(String(payload.session_id || sessionId), {
              title: String(payload.title),
            });
        }
        break;
      }

      case "confirmation_required": {
        const reqEvent: ConfirmationRequestEvent = {
          request_id: String(payload.request_id || ""),
          session_id: String(payload.session_id || sessionId),
          agent_id:
            payload.agent_id !== undefined && payload.agent_id !== null
              ? String(payload.agent_id)
              : null,
          kind: (payload.kind as ConfirmationRequestEvent["kind"]) || "tool_approval",
          ui_hint: payload.ui_hint as ConfirmationRequestEvent["ui_hint"],
          dismissible: payload.dismissible !== false,
          allow_chat_override: payload.allow_chat_override !== false,
          timeout_ms:
            typeof payload.timeout_ms === "number" ? payload.timeout_ms : undefined,
          items: Array.isArray(payload.items)
            ? (payload.items as ConfirmationRequestEvent["items"])
            : [],
        };
        if (reqEvent.request_id && reqEvent.items.length > 0) {
          useConfirmationStore.getState().enqueue(reqEvent);
        }
        break;
      }

      case "confirmation_resolved": {
        const resEvent: ConfirmationResolvedEvent = {
          request_id: String(payload.request_id || ""),
          decision: (payload.decision as ConfirmationResolvedEvent["decision"]) || "dismissed",
        };
        if (resEvent.request_id) {
          useConfirmationStore.getState().resolveRemote(resEvent);
        }
        break;
      }

      case "permission_request": {
        const legacyEvent = buildLegacyPermissionEvent({
          sessionId: String(payload.session_id || sessionId),
          approvalId: String(payload.approval_id || payload.tool_call_id || ""),
          toolName: String(payload.tool_name || payload.name || ""),
          arguments: (payload.arguments || payload.args || {}) as Record<
            string,
            unknown
          >,
          reason:
            typeof payload.reason === "string" && payload.reason
              ? payload.reason
              : undefined,
        });
        useConfirmationStore.getState().enqueue(legacyEvent);
        break;
      }

      case "preempted": {
        chatStore.setLifecycleState(AgentLifecycleState.INTERRUPTED, sessionId);
        break;
      }

      case "mid_task_steered": {
        const steerText = (payload.content as string) || "";
        chatStore.applyMidTaskSteered(sessionId, messageId, steerText);
        break;
      }

      case "done": {
        const turnStartTime = context?.turnStartTime || Date.now() - 1000;
        const durationMs =
          payload.duration_ms !== undefined
            ? Number(payload.duration_ms)
            : Math.max(100, Date.now() - turnStartTime);
        const tokensObj = payload.tokens as
          | { input?: number; output?: number }
          | number
          | undefined;
        const totalTokens =
          typeof tokensObj === "number"
            ? tokensObj
            : tokensObj
            ? (tokensObj.input || 0) + (tokensObj.output || 0)
            : undefined;

        this.cleanupSessionSubagents(sessionId, "completed");
        this.clearToolArgBuffersForSession(sessionId);

        // 保留当前会话自身的 AWAITING_PLAN_APPROVAL 状态，避免 Plan 审批横幅被 done 瞬时覆盖
        const currentLifecycle = chatStore.lifecycleStateBySession[sessionId];
        const finalState: AgentLifecycleState =
          payload.state === AgentLifecycleState.AWAITING_PLAN_APPROVAL ||
          currentLifecycle === AgentLifecycleState.AWAITING_PLAN_APPROVAL
            ? AgentLifecycleState.AWAITING_PLAN_APPROVAL
            : AgentLifecycleState.COMPLETED;

        chatStore.applyStreamDone(sessionId, messageId, {
          durationMs,
          totalTokens,
          finalLifecycleState: finalState,
          mode:
            payload.mode === "plan" || payload.mode === "act"
              ? payload.mode
              : undefined,
        });
        break;
      }

      case "system_notice": {
        const levelRaw = String(payload.level || "warning");
        const level: "info" | "warning" | "error" =
          levelRaw === "info" || levelRaw === "error" ? levelRaw : "warning";
        chatStore.updateMessage(sessionId, messageId, {
          system_notice: {
            level,
            reason: typeof payload.reason === "string" ? payload.reason : undefined,
            message: String(payload.message || "任务阶段性暂停"),
            detail: typeof payload.detail === "string" ? payload.detail : undefined,
            steps_taken:
              typeof payload.steps_taken === "number" ? payload.steps_taken : undefined,
            max_steps:
              typeof payload.max_steps === "number" ? payload.max_steps : undefined,
            can_continue: Boolean(payload.can_continue),
          },
        });
        break;
      }

      case "error": {
        this.cleanupSessionSubagents(sessionId, "failed");
        this.clearToolArgBuffersForSession(sessionId);
        chatStore.applyStreamError(
          sessionId,
          messageId,
          String(payload.message || "服务异常")
        );
        break;
      }

      default:
        break;
    }
  }

  private findSubagent(
    sessionId: string,
    agentId: string
  ): SubagentInstance | null {
    const wb = useWorkbenchStore.getState();
    const tabs = wb.workbenchBySession[sessionId]?.tabs || wb.tabs || [];
    const panel = tabs.find(
      (t): t is SubagentPanelTabConfig => t.kind === "subagent-panel"
    );
    return panel?.agents?.find((a) => a.id === agentId) || null;
  }

  private formatToolArgsPreview(
    name: string,
    args: Record<string, unknown>
  ): string | undefined {
    if (args.path) return String(args.path);
    if (args.query) return `query: ${String(args.query)}`;
    if (args.pattern) return `pattern: ${String(args.pattern)}`;
    if (args.command) return `$ ${String(args.command).slice(0, 80)}`;
    if (name) return name.replace(/^workspace__/, "");
    return undefined;
  }

  private formatToolResultPreview(
    name: string,
    resObj?: Record<string, unknown>
  ): string | undefined {
    if (!resObj) return undefined;
    if (typeof resObj.message === "string") return resObj.message.slice(0, 120);
    if (typeof resObj.path === "string") {
      if (typeof resObj.additions === "number" || typeof resObj.deletions === "number") {
        return `${resObj.path} (+${Number(resObj.additions || 0)}/-${Number(resObj.deletions || 0)})`;
      }
      return resObj.path;
    }
    if (typeof resObj.stdout === "string" && resObj.stdout.trim()) {
      return resObj.stdout.trim().slice(0, 120);
    }
    if (Array.isArray(resObj.matches)) {
      return `命中 ${resObj.matches.length} 处匹配`;
    }
    if (Array.isArray(resObj.files)) {
      return `找到 ${resObj.files.length} 个文件`;
    }
    return name ? `${name.replace(/^workspace__/, "")} 完成` : undefined;
  }

  private cleanupSessionSubagents(
    sessionId: string,
    targetStatus: "failed" | "completed"
  ): void {
    try {
      const wb = useWorkbenchStore.getState();
      const currentSessionTabs =
        (sessionId && wb.workbenchBySession[sessionId]?.tabs) ||
        wb.tabs ||
        [];
      for (const t of currentSessionTabs) {
        if (t.kind === "subagent-panel") {
          const panel = t as SubagentPanelTabConfig;
          for (const agent of panel.agents || []) {
            if (agent.status === "running") {
              wb.updateAgentInstance(
                agent.id,
                {
                  status: targetStatus,
                  summary:
                    agent.summary ||
                    (targetStatus === "failed" ? "*(已中止)*" : undefined),
                },
                sessionId
              );
            }
          }
        }
      }
    } catch (e) {
      console.warn("[StreamDispatcher] Failed to cleanup subagents:", e);
    }
  }

  private clearToolArgBuffersForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of Array.from(this.toolCallArgBuffers.keys())) {
      if (key.startsWith(prefix)) {
        this.toolCallArgBuffers.delete(key);
      }
    }
    for (const key of Array.from(this.toolCallNames.keys())) {
      if (key.startsWith(prefix)) {
        this.toolCallNames.delete(key);
      }
    }
  }

  /**
   * 清理指定会话的水位线与残留缓冲
   */
  public clearSession(sessionId: string): void {
    this.flush();
    const prefix = `${sessionId}:`;
    for (const key of Array.from(this.watermarkMap.keys())) {
      if (key.startsWith(prefix)) {
        this.watermarkMap.delete(key);
      }
    }
    this.activeTurnBySession.delete(sessionId);
    this.expiredTurnsBySession.delete(sessionId);
    this.clearToolArgBuffersForSession(sessionId);
  }

  /**
   * 重置分发器全部水位线与缓冲
   */
  public reset(): void {
    this.flush();
    this.watermarkMap.clear();
    this.activeTurnBySession.clear();
    this.expiredTurnsBySession.clear();
    this.toolCallArgBuffers.clear();
    this.toolCallNames.clear();
    this.buffers.clear();
  }
}

export const streamDispatcher = new StreamDispatcher();
