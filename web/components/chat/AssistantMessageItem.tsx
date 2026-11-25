"use client";

import React from "react";
import { Message } from "@/types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThinkingPulse } from "./ThinkingPulse";
import { ThinkingAccordion } from "./ThinkingAccordion";
import { AssistantActionBar } from "./AssistantActionBar";
import { ToolCallsGroup } from "./ToolCallsGroup";
import { ActionTimeline } from "./ActionTimeline";
import { InMessageTodoPill } from "./InMessageTodoPill";
import { FileChangesCard } from "./FileChangesCard";
import { WebPreviewCard } from "./WebPreviewCard";
import { useChatStore } from "@/stores/useChatStore";
import { DiffFileItem } from "@/stores/useWorkbenchStore";

interface AssistantMessageItemProps {
  message: Message;
}

const NON_WEB_PORTS = new Set([
  "5432", // Postgres
  "6379", // Redis
  "3306", // MySQL
  "27017", // MongoDB
  "9200", // Elasticsearch
  "11434", // Ollama
  "6006", // TensorBoard
  "22", // SSH
  "21", // FTP
]);

function scoreUrl(urlStr: string): number {
  try {
    const parsed = new URL(urlStr);
    const port = parsed.port;
    if (NON_WEB_PORTS.has(port)) return -1;
    // 常见前端开发服务端口评分最高
    if (["3000", "5173", "4173", "8080", "4200", "3001"].includes(port)) return 100;
    // 常见后端服务端口次之
    if (["8000", "5000", "8081", "9000"].includes(port)) return 80;
    if (!port || port === "80" || port === "443") return 60;
    return 40;
  } catch {
    return -1;
  }
}

function extractMessagePreviewUrls(message: Message): string[] {
  const urls = new Set<string>();

  if (message.raw_tool_calls) {
    for (const tc of message.raw_tool_calls) {
      let out: Record<string, any> | null = null;
      if (typeof tc.output === "object" && tc.output !== null) {
        out = tc.output as Record<string, any>;
      } else if (typeof tc.output === "string") {
        try {
          out = JSON.parse(tc.output);
        } catch {}
      }

      if (out?.url && typeof out.url === "string") {
        urls.add(out.url.replace("://0.0.0.0", "://localhost"));
      }
      if (out?.detected_url && typeof out.detected_url === "string") {
        urls.add(out.detected_url.replace("://0.0.0.0", "://localhost"));
      }

      const combinedLogs = [
        out?.stdout,
        out?.recent_logs ? out.recent_logs.join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n");

      if (combinedLogs) {
        const matches = combinedLogs.match(
          /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s\)\],]*)?/gi
        );
        if (matches) {
          for (const m of matches) {
            urls.add(m.replace("://0.0.0.0", "://localhost"));
          }
        }
      }
    }
  }

  // 从消息正文中解析可能出现的本地服务 URL
  if (message.content) {
    const contentMatches = message.content.match(
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s\)\],]*)?/gi
    );
    if (contentMatches) {
      for (const m of contentMatches) {
        urls.add(m.replace("://0.0.0.0", "://localhost"));
      }
    }
  }

  // 过滤非 Web 端口并按权重降序排列
  return Array.from(urls)
    .filter((u) => scoreUrl(u) > 0)
    .sort((a, b) => scoreUrl(b) - scoreUrl(a));
}

function extractMessageFileDiffs(message: Message): DiffFileItem[] {
  if (!message.raw_tool_calls || message.raw_tool_calls.length === 0) return [];
  const map = new Map<string, DiffFileItem>();

  for (const tc of message.raw_tool_calls) {
    const isFileTool =
      tc.name.includes("write_file") ||
      tc.name.includes("edit_file") ||
      tc.name.includes("create_file");
    if (!isFileTool) continue;

    let out: Record<string, any> | null = null;
    if (typeof tc.output === "object" && tc.output !== null) {
      out = tc.output as Record<string, any>;
    } else if (typeof tc.output === "string") {
      try {
        out = JSON.parse(tc.output);
      } catch {}
    }

    const path = (out?.path || tc.args?.path) as string | undefined;
    if (!path) continue;

    let adds = 0;
    let dels = 0;
    if (typeof out?.additions === "number") {
      adds = out.additions;
    } else if (out?.diff && typeof out.diff === "string") {
      adds = (out.diff.match(/^\+[^+]/gm) || []).length;
    }

    if (typeof out?.deletions === "number") {
      dels = out.deletions;
    } else if (out?.diff && typeof out.diff === "string") {
      dels = (out.diff.match(/^-[^-]/gm) || []).length;
    }

    if (adds === 0 && dels === 0 && tc.args?.content) {
      adds = String(tc.args.content).split("\n").length;
    }

    const realPatchId =
      (typeof out?.patch_id === "string" && out.patch_id) ||
      (typeof out?.snapshot_id === "string" && out.snapshot_id) ||
      undefined;

    map.set(path, {
      path,
      name: (out?.name as string) || path.split("/").pop() || "file",
      additions: adds,
      deletions: dels,
      originalContent: (out?.original_content as string) || "",
      modifiedContent: (out?.modified_content as string) || (tc.args?.content as string) || "",
      unifiedDiff: (out?.diff || out?.unified_diff as string) || "",
      ...(realPatchId ? { patchId: realPatchId, patch_id: realPatchId } : {}),
    });
  }

  return Array.from(map.values());
}

export function AssistantMessageItem({ message }: AssistantMessageItemProps) {
  const { regenerateAssistantMessage, sendStreamMessage } = useChatStore();

  const isGeneratingWithoutContent =
    message.status === "streaming" && !message.content && !message.reasoning_content;

  // 严格成果态守门：只有当整轮流式结束 (success | failed) 时，才准许挂载交付物卡片
  const isTurnSettled = message.status !== "streaming";

  // 兼容剥离历史消息中旧版后端硬拼的 "[Genesis 提示: 已达到单轮对话 ReAct 最大步数上限 ...]" 裸文本
  const { cleanContent, effectiveNotice } = React.useMemo(() => {
    const raw = message.content || "";
    const legacyRegex =
      /\n*\[Genesis 提示:\s*已达到单轮对话\s*ReAct\s*最大步数上限\s*(\d+)[，,]?\s*自动终止以防死循环\]\s*$/i;
    const match = raw.match(legacyRegex);
    if (match) {
      const stripped = raw.replace(legacyRegex, "").trim();
      return {
        cleanContent: stripped,
        effectiveNotice: message.system_notice || {
          level: "warning" as const,
          reason: "step_budget_reached",
          message: `当前任务已执行 ${match[1]} 步并阶段性暂停`,
          detail: "你可以点击下方按钮继续推进，或先让我基于已有发现给出结论。",
          can_continue: true,
        },
      };
    }
    return {
      cleanContent: raw,
      effectiveNotice: message.system_notice || null,
    };
  }, [message.content, message.system_notice]);

  const fileDiffs = React.useMemo(() => extractMessageFileDiffs(message), [message]);
  const sortedPreviewUrls = React.useMemo(() => extractMessagePreviewUrls(message), [message]);
  const primaryPreviewUrl = sortedPreviewUrls[0];
  const secondaryPreviewUrls = sortedPreviewUrls.slice(1);

  const handleRegenerate = () => {
    regenerateAssistantMessage(message.session_id, message.id);
  };

  const handleContinueTask = () => {
    if (!message.session_id) return;
    sendStreamMessage(
      message.session_id,
      "请从刚才暂停的位置继续推进，跳过已经排查过的步骤，直接完成剩余分析或修改。",
      null,
      null,
      "act"
    );
  };

  const handleSummarizeProgress = () => {
    if (!message.session_id) return;
    sendStreamMessage(
      message.session_id,
      "请先停止继续检索，直接基于目前已经收集到的证据给出清晰、完整的阶段性结论和下一步建议。",
      null,
      null,
      "act"
    );
  };

  const todoToolCall = React.useMemo(() => {
    if (!message.raw_tool_calls) return null;
    return (
      [...message.raw_tool_calls].reverse().find((tc) => tc.name.includes("todo_write")) || null
    );
  }, [message.raw_tool_calls]);

  return (
    <div className="my-6 space-y-2 select-text">
      {/* 1. 思考等待脉冲动效 (在尚未收到任何思考文字或正文前展示) */}
      {isGeneratingWithoutContent && <ThinkingPulse createdAt={message.created_at} />}

      {/* 2. 深度思考折叠仓 (DeepSeek R1 / o1 思维链) */}
      {message.reasoning_content && (
        <ThinkingAccordion
          reasoning={message.reasoning_content}
          isStreaming={message.status === "streaming"}
          hasContent={!!cleanContent}
          hasTools={!!(message.raw_tool_calls && message.raw_tool_calls.length > 0)}
          durationMs={message.metrics?.latency_ms}
          createdAt={message.created_at}
        />
      )}

      {/* 2.5 计划任务极简胶囊 (完成态就地收纳于本轮对话，不霸占视口吸顶) */}
      {todoToolCall && <InMessageTodoPill toolCall={todoToolCall} />}

      {/* 3. 工具调用统一时间线 (智能自动折叠 + 重复聚合) */}
      {message.raw_tool_calls && message.raw_tool_calls.length > 0 && (
        <ActionTimeline
          toolCalls={message.raw_tool_calls}
          isStreaming={message.status === "streaming"}
          hasContent={!!cleanContent}
          durationMs={message.metrics?.latency_ms}
          sessionId={message.session_id}
        />
      )}

      {/* 4. 智性流式正文渲染 */}
      {cleanContent && (
        <div className="text-genesis-primary/95">
          <MarkdownRenderer
            content={cleanContent}
            isStreaming={message.status === "streaming"}
          />
        </div>
      )}

      {/* 4.5 系统智能护栏提示卡（带「继续执行」「总结进展」可操作出口，绝不甩开发者黑话） */}
      {effectiveNotice && (
        <div
          className={`mt-3 rounded-xl border px-3.5 py-3 text-xs space-y-2.5 ${
            effectiveNotice.level === "error"
              ? "bg-rose-950/25 border-rose-500/30 text-rose-200"
              : effectiveNotice.level === "info"
              ? "bg-blue-950/20 border-blue-500/25 text-blue-200"
              : "bg-amber-950/20 border-amber-500/25 text-amber-200"
          }`}
        >
          <div className="space-y-0.5">
            <div className="font-medium">{effectiveNotice.message}</div>
            {effectiveNotice.detail && (
              <div className="text-[11px] opacity-80 leading-relaxed">
                {effectiveNotice.detail}
              </div>
            )}
          </div>
          {effectiveNotice.can_continue && isTurnSettled && (
            <div className="flex items-center flex-wrap gap-2 pt-0.5">
              <button
                type="button"
                onClick={handleContinueTask}
                className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/35 text-amber-100 font-medium transition-colors cursor-pointer"
              >
                继续执行
              </button>
              <button
                type="button"
                onClick={handleSummarizeProgress}
                className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.1] text-zinc-200 transition-colors cursor-pointer"
              >
                先总结当前发现
              </button>
            </div>
          )}
        </div>
      )}

      {/* 5. 网页预览卡片 */}
      {isTurnSettled && primaryPreviewUrl && (
        <WebPreviewCard
          url={primaryPreviewUrl}
          secondaryUrls={secondaryPreviewUrls}
        />
      )}

      {/* 6. 文件变更卡片 */}
      {isTurnSettled && fileDiffs.length > 0 && (
        <FileChangesCard files={fileDiffs} sessionId={message.session_id} />
      )}

      {/* 7. 底部操作栏与 Token/耗时指标 */}
      {isTurnSettled && (cleanContent || message.reasoning_content) && (
        <AssistantActionBar
          content={cleanContent || message.reasoning_content || ""}
          metrics={message.metrics}
          timestamp={message.created_at}
          onRegenerate={handleRegenerate}
        />
      )}
    </div>
  );
}
