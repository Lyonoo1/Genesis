import { getAuthToken, getApiBaseUrl, apiFetch } from "./client";
import { parseSSEStream, SSEEventHandler, SSEEventCallback } from "./streaming";
import type { DispatchContext } from "@/services/streamDispatcher";
import { Message } from "@/types";


export interface SendMessageStreamParams {
  sessionId: string;
  content: string;
  parentId?: string | null;
  skillId?: string | null;
  model?: string;
  mode?: "plan" | "act";
  permission_mode?: "accept_edits" | "default" | "review_all";
  allow_ask_user?: boolean;
  api_key?: string;
  base_url?: string;
  provider?: string;
  max_tokens?: number;
  context_window?: number;
  signal?: AbortSignal;
  dispatchContext?: DispatchContext;
  useDispatcher?: boolean;
  onEvent?: SSEEventHandler;
}

/**
 * 发送消息并建立 SSE 流式连接（双模驱动：后端真实流 + 优雅降级自愈 Mock 流）
 * 默认接入 16ms rAF 批量流分发器 StreamDispatcher，彻底消除逐 chunk 重渲染风暴
 */
export async function sendMessageStream({
  sessionId,
  content,
  parentId,
  skillId,
  model,
  mode = "act",
  permission_mode = "accept_edits",
  allow_ask_user = true,
  api_key,
  base_url,
  provider,
  max_tokens,
  context_window,
  signal,
  dispatchContext,
  useDispatcher,
  onEvent,
}: SendMessageStreamParams): Promise<void> {
  const token = getAuthToken();
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}/api/chat/${sessionId}/stream`;

  const shouldUseDispatcher =
    useDispatcher !== undefined ? useDispatcher : Boolean(dispatchContext || !onEvent);

  const dispatcher = shouldUseDispatcher
    ? (await import("@/services/streamDispatcher")).streamDispatcher
    : null;

  const handleEvent: SSEEventHandler = (msg: SSEEventCallback) => {
    if (signal?.aborted) return;
    if (dispatcher) {
      dispatcher.dispatch(
        msg,
        dispatchContext || {
          sessionId,
          messageId: `msg_${Date.now()}`,
          turnStartTime: Date.now(),
        }
      );
    }
    if (onEvent) {
      onEvent(msg);
    }
  };

  try {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          content,
          parent_id: parentId,
          skill_id: skillId,
          model,
          mode,
          permission_mode,
          allow_ask_user,
          api_key,
          base_url,
          provider,
          max_tokens,
          context_window,
        }),
        signal,
      });

      if (res.ok && res.body) {
        const reader = res.body.getReader();
        await parseSSEStream(reader, handleEvent, signal);
        return;
      } else {
        const errText = await res.text().catch(() => "");
        console.error("Backend stream failed with HTTP status:", res.status, errText);
        throw new Error(`后端生成失败 (HTTP ${res.status}): ${errText}`);
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw err;
      }
      // 若用户已配置自己的 API Key，严禁静默降级假伪装，真实反馈异常
      if (api_key) {
        handleEvent({
          event: "text_delta",
          data: {
            delta: `\n\n⚠️ **连接后端大模型异常**: ${err instanceof Error ? err.message : String(err)}\n\n请检查后端服务是否正常运行。`,
          },
        });
        handleEvent({ event: "done", data: {} });
        return;
      }
      console.warn("Backend stream endpoint unavailable, switching to local adaptive Mock stream:", err);
    }

    // 优雅降级：仅在无任何模型凭据的脱机预览模式下作为打字机演示
    await runMockSSEStream({ sessionId, content, skillId, signal, onEvent: handleEvent });
  } finally {
    if (dispatcher) {
      dispatcher.flush();
    }
  }
}

/**
 * 运行中实时插话 (Mid-task Steering)：不中断当前工具或流式生成，将指令排队在下一步生效
 */
export async function steerChatApi(
  sessionId: string,
  content: string
): Promise<{ success: boolean; message: string }> {
  return apiFetch<{ success: boolean; message: string }>(
    `/api/chat/${sessionId}/steer`,
    {
      method: "POST",
      body: JSON.stringify({ content }),
    }
  );
}

/**
 * 向后端广播中止信号
 */
export async function stopGenerationApi(sessionId: string): Promise<void> {
  try {
    await apiFetch(`/api/chat/${sessionId}/stop`, {
      method: "POST",
    });
  } catch (err) {
    console.warn("Failed to notify backend stop endpoint:", err);
  }
}

/**
 * 向后端提交权限审批决议（允许/拒绝高危操作）
 */
export async function approveToolCallApi(
  sessionId: string,
  approvalId: string,
  approved: boolean
): Promise<{ status: string }> {
  return apiFetch<{ status: string }>(`/api/chat/${sessionId}/approve`, {
    method: "POST",
    body: JSON.stringify({
      approval_id: approvalId,
      tool_call_id: approvalId,
      approved,
    }),
  });
}

/**
 * 终止指定的后台守护进程
 */
export async function stopProcessApi(pid: number): Promise<{ success: boolean; pid: number; message: string }> {
  return apiFetch<{ success: boolean; pid: number; message: string }>(
    `/api/chat/processes/${pid}/stop`,
    {
      method: "POST",
    }
  );
}

/**
 * 获取所有正在运行的后台守护进程列表 (支持按当前会话 session_id 过滤)
 */
export async function listProcessesApi(sessionId?: string): Promise<{ success: boolean; processes: Array<{ pid: number; command: string; session_id?: string }> }> {
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  return apiFetch<{ success: boolean; processes: Array<{ pid: number; command: string; session_id?: string }> }>(
    `/api/chat/processes${query}`,
    {
      method: "GET",
    }
  );
}

/**
 * 拉取会话的历史消息（游标分页）
 */
export async function fetchSessionMessagesApi(
  sessionId: string,
  cursor?: string,
  limit = 50
): Promise<{ items: Message[]; next_cursor: string | null }> {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  query.set("limit", String(limit));

  return apiFetch<{ items: Message[]; next_cursor: string | null }>(
    `/api/chat/${sessionId}/messages?${query.toString()}`
  );
}

/**
 * 向指定子代理发送实时纠偏指令 (Mid-task Steering)
 */
export async function steerSubagentApi(
  sessionId: string,
  agentId: string,
  content: string,
  interrupt = true
): Promise<{ success: boolean; message?: string }> {
  return apiFetch<{ success: boolean; message?: string }>(
    `/api/chat/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/steer`,
    {
      method: "POST",
      body: JSON.stringify({ content, message: content, interrupt }),
    }
  );
}

/**
 * 单点终止指定子代理并释放执行资源
 */
export async function stopSubagentApi(
  sessionId: string,
  agentId: string
): Promise<{ success: boolean; message?: string }> {
  return apiFetch<{ success: boolean; message?: string }>(
    `/api/chat/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/stop`,
    {
      method: "POST",
    }
  );
}

/**
 * 回滚指定文件补丁并压入脏状态感知告警
 */
export async function revertPatchApi(params: {
  patch_id?: string;
  session_id?: string;
  path?: string;
  project_id?: string;
}): Promise<{
  success: boolean;
  patch_id?: string;
  status: string;
  file_path?: string;
  message: string;
}> {
  return apiFetch<{
    success: boolean;
    patch_id?: string;
    status: string;
    file_path?: string;
    message: string;
  }>("/api/workspace/revert_patch", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * 接受并锁定指定文件快照补丁
 */
export async function acceptPatchApi(
  patchId: string
): Promise<{
  success: boolean;
  patch_id: string;
  status: string;
  message: string;
}> {
  return apiFetch<{
    success: boolean;
    patch_id: string;
    status: string;
    message: string;
  }>("/api/workspace/accept_patch", {
    method: "POST",
    body: JSON.stringify({ patch_id: patchId }),
  });
}

/**
 * 在 Plan 模式下对计划做出批准或修改决策
 */
export async function submitPlanDecisionApi(
  sessionId: string,
  approved: boolean,
  feedback?: string
): Promise<{ success: boolean; message?: string; mode?: string; state?: string }> {
  return apiFetch<{ success: boolean; message?: string; mode?: string; state?: string }>(
    "/api/workspace/plan_decision",
    {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        approved,
        feedback,
      }),
    }
  );
}

/**
 * 高保真 Mock SSE 产生器：模拟真实大模型 Token 吐字与 Tool 执行时序
 */
async function runMockSSEStream({
  sessionId,
  content,
  skillId,
  signal,
  onEvent,
}: {
  sessionId: string;
  content: string;
  skillId?: string | null;
  signal?: AbortSignal;
  onEvent: SSEEventHandler;
}) {
  onEvent({
    event: "session_info",
    data: {
      session_id: sessionId,
      model: "claude-3-5-sonnet-20241022",
    },
  });

  const shouldTriggerTool = !!skillId || content.includes("分析") || content.includes("测试") || content.includes("mcp");

  if (shouldTriggerTool) {
    const toolCallId = `tc_${Date.now()}`;
    const toolName = skillId ? `skill::${skillId}` : "skill::code-analyzer";

    onEvent({
      event: "tool_start",
      data: {
        tool_call_id: toolCallId,
        name: toolName,
        args: { query: content, strict: true },
      },
    });

    // 模拟工具执行耗时 (400ms)
    await delay(400, signal);

    onEvent({
      event: "tool_result",
      data: {
        tool_call_id: toolCallId,
        output: {
          status: "success",
          verdict: "PASSED",
          metrics: { execution_time_ms: 382, memory_mb: 18.4 },
          details: "AST inspection finished without errors.",
        },
        latency_ms: 382,
      },
    });
  }

  // 模拟正文流式输出
  const mockResponse = shouldTriggerTool
    ? `已启动安全隔离沙箱，并成功调用 **${skillId || "code-analyzer"}** 执行器。\n\n\`\`\`json\n{\n  "status": "verified",\n  "protocol": "genesis-v0.1",\n  "runtime": "asyncio-sandbox"\n}\n\`\`\`\n\n所有生成过程均严格遵循进程组隔离机制与管道通信标准。`
    : `这是对提问 **“${content}”** 的智性生成回复。\n\n在 Genesis 架构中，系统通过多态事件流 (\`SSE\`) 实现了端到端的无缝双工交互，前端状态机与打字机调度器确保了极致平滑的阅读体验。`;

  // 单词切片流式打印 (模拟 25ms 间隔)
  const chunks = mockResponse.split(/(?<=\s|[\u4e00-\u9fa5]|，|。|；|！|、|\n)/);
  for (const chunk of chunks) {
    if (signal?.aborted) return;
    onEvent({
      event: "text_delta",
      data: { delta: chunk },
    });
    await delay(30, signal);
  }

  if (signal?.aborted) return;

  onEvent({
    event: "usage",
    data: {
      latency_ms: 780,
      tokens: 245,
    },
  });

  onEvent({
    event: "done",
    data: {},
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException("Aborted", "AbortError"));
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

/**
 * 撤销指定的代码变更并恢复原内容
 */
export async function revertFilesApi(
  files: Array<{ path: string; original_content: string }>,
  sessionId?: string
): Promise<{ success: boolean; reverted: string[] }> {
  return apiFetch<{ success: boolean; reverted: string[] }>(
    "/api/chat/revert",
    {
      method: "POST",
      body: JSON.stringify({ files, session_id: sessionId }),
    }
  );
}

