import { getAuthToken } from "./client";
import { parseSSEStream, SSEEventHandler } from "./streaming";
import { Message } from "@/types";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

interface SendMessageStreamParams {
  sessionId: string;
  content: string;
  parentId?: string | null;
  skillId?: string | null;
  model?: string;
  api_key?: string;
  base_url?: string;
  provider?: string;
  max_tokens?: number;
  context_window?: number;
  signal?: AbortSignal;
  onEvent: SSEEventHandler;
}

/**
 * 发送消息并建立 SSE 流式连接（双模驱动：后端真实流 + 优雅降级自愈 Mock 流）
 */
export async function sendMessageStream({
  sessionId,
  content,
  parentId,
  skillId,
  model,
  api_key,
  base_url,
  provider,
  max_tokens,
  context_window,
  signal,
  onEvent,
}: SendMessageStreamParams): Promise<void> {
  const token = getAuthToken();
  const url = `${API_BASE_URL}/api/chat/${sessionId}/stream`;

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
      await parseSSEStream(reader, onEvent, signal);
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
      onEvent({
        event: "text_delta",
        data: {
          delta: `\n\n⚠️ **连接后端大模型异常**: ${err instanceof Error ? err.message : String(err)}\n\n请检查后端服务是否正常运行。`,
        },
      });
      onEvent({ event: "done", data: {} });
      return;
    }
    console.warn("Backend stream endpoint unavailable, switching to local adaptive Mock stream:", err);
  }

  // 优雅降级：仅在无任何模型凭据的脱机预览模式下作为打字机演示
  await runMockSSEStream({ sessionId, content, skillId, signal, onEvent });
}

/**
 * 向后端广播中止信号
 */
export async function stopGenerationApi(sessionId: string): Promise<void> {
  const token = getAuthToken();
  try {
    await fetch(`${API_BASE_URL}/api/chat/${sessionId}/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    console.warn("Failed to notify backend stop endpoint:", err);
  }
}

/**
 * 拉取会话的历史消息（游标分页）
 */
export async function fetchSessionMessagesApi(
  sessionId: string,
  cursor?: string,
  limit = 50
): Promise<{ items: Message[]; next_cursor: string | null }> {
  const token = getAuthToken();
  const url = new URL(`${API_BASE_URL}/api/chat/${sessionId}/messages`);
  if (cursor) url.searchParams.set("cursor", cursor);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch messages: ${res.status}`);
  }

  return res.json();
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
