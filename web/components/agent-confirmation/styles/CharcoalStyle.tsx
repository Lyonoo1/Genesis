"use client";

import React, { useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Maximize2,
  Minimize2,
  Minus,
  X,
  Palette,
} from "lucide-react";
import type { StyleRendererProps } from "./MaterialStyle";
import { parseUnifiedDiff, splitCodeLines } from "../engine/diffParser";
import type { ConcreteConfirmStyle, PermissionMode } from "../types/protocol";

const COMPACT_CODE_LINE_LIMIT = 8;

const STYLE_CYCLE_ORDER: ConcreteConfirmStyle[] = [
  "codex_desktop",
  "claude_desktop",
  "google_aistudio",
];

function getNextStyle(current: ConcreteConfirmStyle): ConcreteConfirmStyle {
  const idx = STYLE_CYCLE_ORDER.indexOf(current);
  return STYLE_CYCLE_ORDER[(idx + 1) % STYLE_CYCLE_ORDER.length];
}

function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getPermissionModeCapsule(mode: PermissionMode): string {
  if (mode === "review_all") return "全量审阅 · 工作区可写";
  if (mode === "default") return "标准审批 · 工作区可写";
  return "编辑放行 · 工作区可写";
}

/**
 * 风格 C：Charcoal（codex_desktop）完整独立视图渲染器
 * 设计基因：中性冷炭 #212121 + #333 利落描边 + 绿点状态 ● 等待审批 + 权限与 Diff 胶囊
 *          + 默认 8 行紧凑代码块配「展开审阅 ⤢」+ 圆形编号反色行 + 双列参数检查表 + 纯白黑字胶囊操作条
 */
export function CharcoalStyle({
  engine,
  agentName,
  showTabHint,
  onCycleStyle,
}: StyleRendererProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const { entry, currentItem, currentAnswer, currentErrors } = engine;

  // 热切换后还原输入框焦点与末尾光标
  useLayoutEffect(() => {
    const fieldId = entry?.draft.focusedField;
    if (!fieldId || !cardRef.current) return;
    const el = cardRef.current.querySelector<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >(`[data-cf-field="${fieldId}"]`);
    if (el && document.activeElement !== el) {
      el.focus();
      if ("setSelectionRange" in el && typeof el.value === "string") {
        const len = el.value.length;
        try {
          el.setSelectionRange(len, len);
        } catch {}
      }
    }
  }, [entry?.draft.focusedField, entry?.request.request_id, engine.activeIndex]);

  if (!entry || !currentItem) return null;

  const { request, draft } = entry;
  const isPlan = request.kind === "plan_approval";
  const isBatch = engine.isBatchMode;
  const isToolApproval = request.kind === "tool_approval" || isPlan || isBatch;
  const isHighRisk = currentItem.risk_level === "high";
  const hasSessionScope = Boolean(currentItem.scope_signature);
  const canWorkspaceRule = hasSessionScope && !isHighRisk;
  const isExpiringSoon = engine.countdownSeconds !== null;
  const currentBatchKey = isBatch ? engine.batchItemKeys[engine.activeIndex] : null;
  const currentBatchSource = isBatch
    ? engine.batchItemSources[engine.activeIndex] || "主代理"
    : null;
  const currentBatchDecision = currentBatchKey
    ? engine.batchDecisions[currentBatchKey]
    : undefined;
  const approveAllLabel =
    engine.batchHighRiskCount > 0
      ? `Approve all (${engine.batchNonHighCount})，${engine.batchHighRiskCount} 项需单独确认`
      : `Approve all (${engine.batchItems.length})`;

  // 超时只读结案态
  if (engine.isReadOnlyResolved) {
    return (
      <div
        ref={cardRef}
        className="cf-anim-charcoal w-full px-4 py-3.5"
        style={{
          backgroundColor: "var(--cf-surface)",
          border: "1px solid var(--cf-border)",
          borderRadius: "var(--cf-radius-card)",
          fontFamily: "var(--cf-body-font)",
          color: "var(--cf-text)",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div
              className="flex items-center gap-2 text-[12px] tabular-nums"
              style={{ fontFamily: "var(--cf-mono-font)", color: "var(--cf-muted)" }}
            >
              <span className="w-2 h-2 rounded-full bg-zinc-500 inline-block" />
              <span>
                {entry.resolvedDecision === "timeout"
                  ? "已超时自动结案"
                  : "确认已结案"}
              </span>
            </div>
            <div className="text-[13px] mt-1 text-[#ECECEC]">
              {engine.timeoutDraftText
                ? `可一键将草稿填入主输入框并发送给 ${agentName}`
                : `${agentName} 已收到结案信号`}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {engine.timeoutDraftText && (
              <button
                type="button"
                onClick={engine.sendTimeoutDraftAsMessage}
                className="h-8 px-3.5 text-xs font-semibold cursor-pointer transition-colors hover:bg-[#E5E5E5]"
                style={{
                  backgroundColor: "var(--cf-accent)",
                  color: "var(--cf-on-accent)",
                  borderRadius: "var(--cf-radius-btn)",
                }}
              >
                作为消息发送
              </button>
            )}
            <button
              type="button"
              onClick={engine.dismiss}
              aria-label="关闭确认卡片"
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 cursor-pointer"
              style={{ color: "var(--cf-muted)" }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 最小化紧凑条（不阻塞、不关闭，方便先看上方对话）
  if (engine.isMinimized) {
    return (
      <div
        ref={cardRef}
        data-testid="cf-minimized-bar"
        onClick={engine.toggleMinimized}
        className="cf-anim-charcoal w-full px-3.5 py-2.5 flex items-center justify-between gap-3 cursor-pointer select-none transition-colors hover:bg-[#262626]"
        style={{
          backgroundColor: "var(--cf-surface)",
          border: "1px solid var(--cf-border)",
          borderRadius: "12px",
          fontFamily: "var(--cf-body-font)",
          color: "var(--cf-text)",
        }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="w-2 h-2 rounded-full inline-block shrink-0"
            style={{
              backgroundColor: isExpiringSoon
                ? "var(--cf-status-warn)"
                : "var(--cf-status)",
            }}
          />
          <span
            className="text-[11.5px] shrink-0 tabular-nums"
            style={{
              fontFamily: "var(--cf-mono-font)",
              color: isExpiringSoon ? "#FACC15" : "var(--cf-muted)",
            }}
          >
            {isExpiringSoon
              ? `${formatCountdown(engine.countdownSeconds!)}`
              : "待确认"}
          </span>
          <span className="text-[13px] font-medium truncate text-[#ECECEC]">
            {currentItem.review_title || currentItem.title}
          </span>
          {engine.totalItems > 1 && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded-full border shrink-0 tabular-nums"
              style={{
                fontFamily: "var(--cf-mono-font)",
                borderColor: "var(--cf-border)",
                color: "var(--cf-muted)",
              }}
            >
              {engine.activeIndex + 1}/{engine.totalItems}
            </span>
          )}
          {engine.queueLength > 1 && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded-full border shrink-0"
              style={{
                fontFamily: "var(--cf-mono-font)",
                borderColor: "var(--cf-border)",
                color: "var(--cf-muted)",
              }}
            >
              +{engine.queueLength - 1} 待处理
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            engine.toggleMinimized();
          }}
          aria-label="展开确认卡片"
          className="h-7 px-3 rounded-full border text-[11.5px] font-medium flex items-center gap-1 transition-colors hover:bg-[#2F2F2F] cursor-pointer shrink-0"
          style={{
            borderColor: "var(--cf-border)",
            color: "#ECECEC",
          }}
        >
          <span>展开</span>
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // 解析代码/Diff 以便统计总行数与 8 行紧凑折叠
  const codePreview = currentItem.code_preview;
  const parsedDiff =
    codePreview?.language === "diff"
      ? parseUnifiedDiff(codePreview.content)
      : null;
  const plainCodeLines =
    codePreview && codePreview.language !== "diff"
      ? splitCodeLines(codePreview.content)
      : null;
  const totalCodeLines = parsedDiff
    ? parsedDiff.lines.length
    : plainCodeLines
    ? plainCodeLines.length
    : 0;
  const isTruncatable = totalCodeLines > COMPACT_CODE_LINE_LIMIT;
  const visibleDiffLines = parsedDiff
    ? draft.codeExpanded
      ? parsedDiff.lines
      : parsedDiff.lines.slice(0, COMPACT_CODE_LINE_LIMIT)
    : [];
  const visiblePlainLines = plainCodeLines
    ? draft.codeExpanded
      ? plainCodeLines
      : plainCodeLines.slice(0, COMPACT_CODE_LINE_LIMIT)
    : [];
  const hiddenLineCount = Math.max(0, totalCodeLines - COMPACT_CODE_LINE_LIMIT);
  const diffStatText = currentItem.diff_stat || (parsedDiff ? parsedDiff.statLabel : null);

  return (
    <div
      ref={cardRef}
      className="cf-anim-charcoal w-full p-4 select-none"
      style={{
        backgroundColor: "var(--cf-surface)",
        border: "1px solid var(--cf-border)",
        borderRadius: "var(--cf-radius-card)",
        fontFamily: "var(--cf-body-font)",
        color: "var(--cf-text)",
      }}
    >
      {/* 1. Charcoal 顶栏：绿点状态 ● 等待审批 + 权限胶囊 + Diff 统计胶囊 + 展开审阅 ⤢ + 热切换 + X */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center flex-wrap gap-2 min-w-0">
          {/* 绿点 / 超时黄点状态 */}
          <span
            className="inline-flex items-center gap-1.5 text-[12px] font-medium tabular-nums"
            style={{ fontFamily: "var(--cf-mono-font)" }}
            aria-live="polite"
          >
            <span
              className="w-2 h-2 rounded-full inline-block shrink-0"
              style={{
                backgroundColor: isExpiringSoon
                  ? "var(--cf-status-warn)"
                  : "var(--cf-status)",
              }}
            />
            <span style={{ color: isExpiringSoon ? "#FACC15" : "#ECECEC" }}>
              {isExpiringSoon
                ? `将于 ${formatCountdown(engine.countdownSeconds!)} 后超时`
                : isToolApproval
                ? isPlan
                ? "等待计划审批"
                : "等待审批"
                : engine.totalItems > 1
                ? `第 ${engine.activeIndex + 1} 题 / 共 ${engine.totalItems} 题`
                : request.kind === "parameter_form"
                ? "参数补全"
                : "等待确认"}
            </span>
          </span>

          {/* 权限沙盒胶囊 */}
          {isToolApproval && (
            <span
              className="px-2 py-0.5 rounded-full text-[11px] border"
              style={{
                fontFamily: "var(--cf-mono-font)",
                backgroundColor: "var(--cf-surface-2)",
                borderColor: "var(--cf-border)",
                color: "var(--cf-muted)",
              }}
            >
              {isPlan ? "Plan → Act · 批准后开始实施" : getPermissionModeCapsule(engine.permissionMode)}
            </span>
          )}

          {/* Diff 增删统计胶囊 */}
          {diffStatText && (
            <span
              className="px-2 py-0.5 rounded-full text-[11px] border tabular-nums"
              style={{
                fontFamily: "var(--cf-mono-font)",
                backgroundColor: "var(--cf-surface-2)",
                borderColor: "var(--cf-border)",
                color: "#ECECEC",
              }}
            >
              {diffStatText}
            </span>
          )}

          {currentItem.selection_mode === "multi" && (
            <span
              className="px-2 py-0.5 rounded-full text-[10.5px] border"
              style={{
                fontFamily: "var(--cf-mono-font)",
                borderColor: "var(--cf-border)",
                color: "var(--cf-muted)",
              }}
            >
              可多选
            </span>
          )}

          {engine.queueLength > 1 && (
            <span
              className="px-2 py-0.5 rounded-full text-[10.5px] border tabular-nums"
              style={{
                fontFamily: "var(--cf-mono-font)",
                borderColor: "var(--cf-border)",
                color: "var(--cf-muted)",
              }}
            >
              +{engine.queueLength - 1} 待处理
            </span>
          )}

          {showTabHint && (
            <span
              className="text-[11px]"
              style={{ fontFamily: "var(--cf-mono-font)", color: "var(--cf-muted)" }}
            >
              [Tab 进入审批]
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* 展开审阅 ⤢ / 收起审阅 ⤡ */}
          {isToolApproval && codePreview && (
            <button
              type="button"
              onClick={engine.toggleCodeExpanded}
              className="h-7 px-2.5 rounded-full border text-[11px] flex items-center gap-1 transition-colors hover:bg-[#2A2A2A] cursor-pointer"
              style={{
                borderColor: "var(--cf-border)",
                color: "var(--cf-text)",
              }}
            >
              {draft.codeExpanded ? (
                <>
                  <span>收起审阅</span>
                  <Minimize2 className="w-3 h-3" />
                </>
              ) : (
                <>
                  <span>展开审阅</span>
                  <Maximize2 className="w-3 h-3" />
                </>
              )}
            </button>
          )}

          {/* 多题分页器 */}
          {engine.totalItems > 1 && (
            <div
              className="flex items-center gap-0.5 rounded-full border px-1 py-0.5"
              style={{ borderColor: "var(--cf-border)" }}
            >
              <button
                type="button"
                onClick={engine.goPrev}
                disabled={engine.isFirstItem}
                aria-label="上一题"
                className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-30 cursor-pointer"
              >
                <ChevronLeft className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={engine.goNext}
                disabled={engine.isLastItem}
                aria-label="下一题"
                className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-30 cursor-pointer"
              >
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* 右上角极简风格热切换 */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCycleStyle(getNextStyle("codex_desktop"))}
            title="切换气泡风格（当前：Charcoal）"
            aria-label="切换气泡风格"
            className="h-7 px-2 rounded-full border flex items-center gap-1 text-[11px] transition-colors hover:bg-[#2A2A2A] cursor-pointer"
            style={{
              borderColor: "var(--cf-border)",
              color: "var(--cf-muted)",
              fontFamily: "var(--cf-mono-font)",
            }}
          >
            <Palette className="w-3 h-3" />
            <span>Charcoal</span>
          </button>

          <button
            type="button"
            onClick={engine.toggleMinimized}
            title="最小化（保留待确认状态）"
            aria-label="最小化确认卡片"
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-[#2A2A2A] cursor-pointer"
            style={{ color: "var(--cf-muted)" }}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* P2-4 Charcoal 顶部队列胶囊 Tabs（1/3 2/3 3/3 + 状态灯：灰=待审、绿=批准、红=拒绝、黄=高危） */}
      {isBatch && (
        <div
          data-testid="charcoal-batch-tabs"
          className="mt-2.5 flex items-center justify-between gap-2 flex-wrap"
        >
          <div className="flex items-center gap-1.5 flex-wrap">
            {engine.batchItems.map((bItem, idx) => {
              const bKey = engine.batchItemKeys[idx];
              const bDec = bKey ? engine.batchDecisions[bKey] : undefined;
              const isActive = idx === engine.activeIndex;
              const dotColor =
                bDec?.decision === "approved"
                  ? "#22C55E"
                  : bDec?.decision === "rejected"
                    ? "#EF4444"
                    : bItem.risk_level === "high"
                      ? "#F59E0B"
                      : "#6B7280";
              return (
                <button
                  key={bKey || idx}
                  type="button"
                  onClick={() => engine.goTo(idx)}
                  className="h-6 px-2.5 rounded-full text-[11px] font-mono tabular-nums border flex items-center gap-1.5 transition-colors cursor-pointer"
                  style={{
                    backgroundColor: isActive ? "#2F2F2F" : "var(--cf-surface-2)",
                    borderColor: isActive ? "#ECECEC" : "var(--cf-border)",
                    color: isActive ? "#FFFFFF" : "var(--cf-muted)",
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: dotColor }}
                  />
                  <span>
                    {idx + 1}/{engine.batchItems.length}
                  </span>
                </button>
              );
            })}
          </div>
          {currentBatchSource && (
            <span
              className="px-2 py-0.5 rounded-full text-[10.5px] border"
              style={{
                fontFamily: "var(--cf-mono-font)",
                backgroundColor: "var(--cf-surface-2)",
                borderColor: "var(--cf-border)",
                color: "var(--cf-muted)",
              }}
            >
              来源：{currentBatchSource}
              {currentBatchDecision
                ? currentBatchDecision.decision === "approved"
                  ? " · 已批准"
                  : " · 已拒绝"
                : ""}
            </span>
          )}
        </div>
      )}

      {/* 主审阅问句与副标题 */}
      <div className="mt-2.5">
        <h3 className="text-[14.5px] font-semibold leading-snug text-[#ECECEC]">
          {isToolApproval ? currentItem.review_title || currentItem.title : currentItem.title}
        </h3>
        {currentItem.subtitle && (
          <p className="text-[12px] mt-0.5 leading-relaxed" style={{ color: "var(--cf-muted)" }}>
            {currentItem.subtitle}
          </p>
        )}
      </div>

      {/* 2. 主体内容区 */}
      <div className="mt-3 space-y-2.5">
        {/* 2a. tool_approval：冷炭 #171717 紧凑行号 Diff / 代码块（默认最多 8 行，200ms 过渡展开） */}
        {isToolApproval && codePreview && (
          <div
            className="rounded-[12px] border overflow-hidden"
            style={{
              backgroundColor: "var(--cf-surface-2)",
              borderColor: "var(--cf-border)",
            }}
          >
            <div
              className="flex items-center justify-between px-3 py-1.5 border-b text-[11px]"
              style={{
                borderColor: "var(--cf-border)",
                fontFamily: "var(--cf-mono-font)",
                color: "var(--cf-muted)",
              }}
            >
              <span className="truncate">
                {codePreview.filename || currentItem.tool_name || codePreview.language}
              </span>
              <span className="shrink-0 tabular-nums">
                {isHighRisk ? "高危 · 需显式确认" : `${totalCodeLines} 行`}
              </span>
            </div>

            <div
              className="overflow-auto text-[11.5px] leading-[1.55] py-1.5 transition-[max-height] duration-200 ease-out"
              style={{
                fontFamily: "var(--cf-mono-font)",
                maxHeight: draft.codeExpanded ? "360px" : "210px",
              }}
            >
              {parsedDiff ? (
                <div className="min-w-0">
                  {visibleDiffLines.map((ln, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-[34px_34px_16px_minmax(0,1fr)] px-2 py-[1px]"
                      style={{
                        backgroundColor:
                          ln.kind === "add"
                            ? "rgba(34,197,94,0.12)"
                            : ln.kind === "del"
                            ? "rgba(239,68,68,0.14)"
                            : "transparent",
                        color:
                          ln.kind === "add"
                            ? "#86EFAC"
                            : ln.kind === "del"
                            ? "#FCA5A5"
                            : ln.kind === "hunk"
                            ? "#93C5FD"
                            : "#ECECEC",
                      }}
                    >
                      <span className="text-right pr-2 select-none opacity-40 tabular-nums">
                        {ln.oldLine ?? ""}
                      </span>
                      <span className="text-right pr-2 select-none opacity-40 tabular-nums">
                        {ln.newLine ?? ""}
                      </span>
                      <span className="select-none opacity-75">{ln.prefix}</span>
                      <span className="whitespace-pre-wrap break-all">{ln.content}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="min-w-0">
                  {visiblePlainLines.map((ln) => (
                    <div
                      key={ln.lineNo}
                      className="grid grid-cols-[36px_minmax(0,1fr)] px-2 py-[1px]"
                    >
                      <span className="text-right pr-3 select-none opacity-40 tabular-nums">
                        {ln.lineNo}
                      </span>
                      <span className="whitespace-pre-wrap break-all text-[#ECECEC]">
                        {ln.content}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {isTruncatable && !draft.codeExpanded && (
              <button
                type="button"
                onClick={engine.toggleCodeExpanded}
                className="w-full py-1.5 border-t text-[11px] text-center transition-colors hover:bg-[#222222] cursor-pointer"
                style={{
                  borderColor: "var(--cf-border)",
                  color: "var(--cf-muted)",
                  fontFamily: "var(--cf-mono-font)",
                }}
              >
                已折叠剩余 {hiddenLineCount} 行 · 点击展开审阅 ⤢
              </button>
            )}
          </div>
        )}

        {/* 2b. clarification：圆形编号反色行（紧凑行高，选中后圆圈反色白底黑字） */}
        {(currentItem.selection_mode === "single" ||
          currentItem.selection_mode === "multi") &&
          currentItem.options && (
            <div
              data-testid="cf-options-container"
              className="space-y-1 transition-opacity duration-150"
              style={{ opacity: engine.isOverrideActive ? 0.38 : 1 }}
            >
              {currentItem.options.map((opt, idx) => {
                const isSelected = Boolean(
                  currentAnswer?.selected_ids.includes(opt.id)
                );
                const isFocused =
                  !engine.isOverrideActive && draft.focusedOptionIndex === idx;
                const isMulti = currentItem.selection_mode === "multi";
                return (
                  <button
                    key={opt.id}
                    type="button"
                    data-cf-focused={isFocused ? "true" : undefined}
                    onClick={() => {
                      engine.setFocusedOptionIndex(idx);
                      if (isMulti) {
                        engine.toggleMultiOption(opt.id);
                      } else {
                        engine.selectSingleOption(opt.id);
                      }
                    }}
                    className="cf-touch-target w-full px-3 py-2 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                    style={{
                      borderRadius: "var(--cf-radius-option)",
                      backgroundColor: isSelected
                        ? "var(--cf-selected)"
                        : isFocused
                        ? "var(--cf-hover)"
                        : "transparent",
                      border: isSelected
                        ? "1px solid #4A4A4A"
                        : isFocused
                        ? "1px solid #3C3C3C"
                        : "1px solid transparent",
                    }}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {isMulti ? (
                        <span
                          className="w-4 h-4 rounded-[4px] flex items-center justify-center shrink-0 transition-colors"
                          style={{
                            backgroundColor: isSelected ? "#0D0D0D" : "transparent",
                            border: isSelected
                              ? "1.5px solid #FFFFFF"
                              : "1px solid #555555",
                            color: "#FFFFFF",
                          }}
                        >
                          {isSelected && <Check className="w-3 h-3 stroke-[2.6]" />}
                        </span>
                      ) : (
                        <span
                          className="w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0 tabular-nums transition-colors"
                          style={{
                            fontFamily: "var(--cf-mono-font)",
                            backgroundColor: isSelected ? "#FFFFFF" : "transparent",
                            color: isSelected ? "#0D0D0D" : "var(--cf-muted)",
                            border: isSelected
                              ? "1px solid #FFFFFF"
                              : "1px solid #525252",
                          }}
                        >
                          {idx + 1}
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center flex-wrap gap-2">
                          <span className="text-[13px] font-medium text-[#ECECEC]">
                            {opt.label}
                          </span>
                          {opt.recommended && (
                            <span
                              className="text-[11px]"
                              style={{
                                fontFamily: "var(--cf-mono-font)",
                                color: "var(--cf-muted)",
                              }}
                            >
                              默认
                            </span>
                          )}
                        </div>
                        {opt.description && (
                          <p
                            className="text-[11.5px] truncate mt-0.5"
                            style={{ color: "var(--cf-muted)" }}
                          >
                            {opt.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

        {/* 2c. parameter_form：Charcoal 原生高对比冷炭双列参数检查表（左标签、右控件 + JSON 实时语法行号校验） */}
        {currentItem.selection_mode === "form" && currentItem.form_fields && (
          <div
            className="rounded-[12px] border"
            style={{
              backgroundColor: "var(--cf-surface-2)",
              borderColor: "var(--cf-border)",
            }}
          >
            {currentItem.form_fields.map((field, fieldIdx) => {
              const fieldId = `field:${field.key}`;
              const val = currentAnswer?.form_values?.[field.key];
              const err = currentErrors[field.key];
              const isFieldFocused = draft.focusedField === fieldId;
              const fieldBorderColor = err
                ? "#F87171"
                : isFieldFocused
                ? "#8E8E8E"
                : "var(--cf-border)";
              return (
                <div
                  key={field.key}
                  className="cf-form-grid-2col grid grid-cols-[minmax(140px,36%)_minmax(0,1fr)] gap-3 items-start px-3.5 py-2.5"
                  style={{
                    borderTop:
                      fieldIdx > 0 ? "1px solid var(--cf-border)" : undefined,
                  }}
                >
                  <div className="min-w-0 pt-1">
                    <div className="text-[12.5px] font-medium text-[#ECECEC] flex items-center gap-1">
                      <span>{field.label}</span>
                      {field.required && <span className="text-rose-400">*</span>}
                    </div>
                    {field.description && (
                      <div
                        className="text-[11px] mt-0.5 leading-snug"
                        style={{ color: "var(--cf-muted)" }}
                      >
                        {field.description}
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    {field.type === "boolean" ? (
                      <button
                        type="button"
                        data-cf-field={fieldId}
                        onFocus={() => engine.setFocusedField(fieldId)}
                        onBlur={() => engine.setFocusedField(null)}
                        onClick={() => engine.setFormValue(field.key, !Boolean(val))}
                        className="h-8 px-3 rounded-lg border text-xs flex items-center gap-2 cursor-pointer"
                        style={{
                          borderColor: Boolean(val) ? "#FFFFFF" : "var(--cf-border)",
                          backgroundColor: Boolean(val) ? "#2F2F2F" : "#212121",
                          color: "#ECECEC",
                        }}
                      >
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{
                            backgroundColor: Boolean(val) ? "#22C55E" : "#525252",
                          }}
                        />
                        <span>{Boolean(val) ? "启用" : "关闭"}</span>
                      </button>
                    ) : field.type === "select" ? (
                      <select
                        data-cf-field={fieldId}
                        value={String(val ?? "")}
                        onFocus={() => engine.setFocusedField(fieldId)}
                        onBlur={() => engine.setFocusedField(null)}
                        onChange={(e) => engine.setFormValue(field.key, e.target.value)}
                        className="w-full h-8 px-2.5 rounded-lg border bg-[#212121] text-[12.5px] text-[#ECECEC] outline-none transition-colors"
                        style={{
                          borderColor: fieldBorderColor,
                        }}
                      >
                        {(field.options || []).map((opt) => (
                          <option
                            key={opt.value}
                            value={opt.value}
                            className="bg-[#212121] text-[#ECECEC]"
                          >
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ) : field.type === "json" ? (
                      <textarea
                        rows={3}
                        data-cf-field={fieldId}
                        value={String(val ?? "")}
                        placeholder={field.placeholder || '{"key": "value"}'}
                        onFocus={() => engine.setFocusedField(fieldId)}
                        onBlur={() => engine.setFocusedField(null)}
                        onChange={(e) => engine.setFormValue(field.key, e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg border bg-[#121212] text-[12px] text-[#ECECEC] outline-none resize-y transition-colors"
                        style={{
                          fontFamily: "var(--cf-mono-font)",
                          borderColor: fieldBorderColor,
                        }}
                      />
                    ) : (
                      <input
                        type={field.type === "number" ? "number" : "text"}
                        data-cf-field={fieldId}
                        value={String(val ?? "")}
                        placeholder={field.placeholder || ""}
                        min={field.min}
                        max={field.max}
                        onFocus={() => engine.setFocusedField(fieldId)}
                        onBlur={() => engine.setFocusedField(null)}
                        onChange={(e) => engine.setFormValue(field.key, e.target.value)}
                        className="w-full h-8 px-2.5 rounded-lg border bg-[#212121] text-[12.5px] text-[#ECECEC] outline-none placeholder:text-[#6B6B6B] transition-colors"
                        style={{
                          borderColor: fieldBorderColor,
                        }}
                      />
                    )}
                    {err && (
                      <div
                        className="text-[11px] mt-1 text-rose-400"
                        style={{ fontFamily: "var(--cf-mono-font)" }}
                      >
                        {err}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 3. Charcoal 细边框自由输入行 */}
        {currentItem.selection_mode !== "form" &&
          currentItem.custom_input?.enabled !== false && (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-[10px] border transition-colors"
              style={{
                backgroundColor: "var(--cf-surface-2)",
                borderColor:
                  draft.focusedField === "writein"
                    ? "#666666"
                    : "var(--cf-border)",
              }}
            >
              <input
                type="text"
                data-cf-field="writein"
                value={engine.customText}
                onFocus={() => engine.setFocusedField("writein")}
                onBlur={() => engine.setFocusedField(null)}
                onChange={(e) => engine.setCustomText(e.target.value)}
                placeholder={
                  currentItem.custom_input?.placeholder ||
                  (isToolApproval
                    ? `或者告知 ${agentName} 如何修改方案…`
                    : `或者告诉 ${agentName} 其他想法…`)
                }
                className="w-full bg-transparent text-[12.5px] text-[#ECECEC] outline-none placeholder:text-[#6E6E6E]"
              />
              {engine.isOverrideActive && (
                <span
                  className="text-[11px] whitespace-nowrap shrink-0"
                  style={{ fontFamily: "var(--cf-mono-font)", color: "#D4D4D4" }}
                >
                  已覆盖上方预设
                </span>
              )}
              {!engine.isOverrideActive &&
                currentItem.selection_mode === "multi" &&
                engine.customText.trim().length > 0 && (
                  <span
                    className="text-[11px] whitespace-nowrap shrink-0"
                    style={{ fontFamily: "var(--cf-mono-font)", color: "#D4D4D4" }}
                  >
                    + 附加至已选 {engine.appendSelectedCount} 项
                  </span>
                )}
            </div>
          )}
      </div>

      {/* 4. Charcoal 底部全圆角胶囊操作条（纯白实心黑字主按钮） */}
      <div className="cf-footer-bar flex items-center justify-between gap-2 mt-3.5 pt-3 border-t border-[#333333]">
        {isBatch ? (
          <>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => engine.decideBatchItem("rejected", "once", true)}
                disabled={engine.isSubmitting}
                className="cf-touch-target h-8 px-3.5 text-[12px] font-medium border transition-colors hover:bg-[#2A2A2A] cursor-pointer"
                style={{
                  borderColor: "var(--cf-border)",
                  color: "var(--cf-text)",
                  borderRadius: "var(--cf-radius-btn)",
                }}
              >
                拒绝
              </button>
              {engine.batchNonHighCount > 0 && (
                <button
                  type="button"
                  onClick={engine.approveAllBatchNonHigh}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-8 px-3.5 text-[12px] font-medium border transition-colors hover:bg-[#2A2A2A] cursor-pointer"
                  style={{
                    borderColor: "var(--cf-border)",
                    color: "var(--cf-muted)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  {approveAllLabel}
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {engine.batchAllResolved ? (
                <button
                  type="button"
                  onClick={engine.submitBatch}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-8 px-4 text-[12px] font-semibold flex items-center gap-1.5 transition-colors hover:bg-[#E5E5E5] disabled:opacity-50 cursor-pointer"
                  style={{
                    backgroundColor: "var(--cf-accent)",
                    color: "var(--cf-on-accent)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  <span>提交全部 ({engine.batchItems.length})</span>
                  <kbd
                    className="cf-kbd text-[10px] opacity-70"
                    style={{ fontFamily: "var(--cf-mono-font)" }}
                  >
                    ⌘↵
                  </kbd>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => engine.decideBatchItem("approved", "once", true)}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-8 px-4 text-[12px] font-semibold flex items-center gap-1.5 transition-colors hover:bg-[#E5E5E5] disabled:opacity-50 cursor-pointer"
                  style={{
                    backgroundColor: "var(--cf-accent)",
                    color: "var(--cf-on-accent)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  <span>
                    {isHighRisk ? "批准此项 · 点击确认" : "批准并下一条"}
                  </span>
                  <kbd
                    className="cf-kbd text-[10px] opacity-70"
                    style={{ fontFamily: "var(--cf-mono-font)" }}
                  >
                    {isHighRisk ? "⌘↵" : "↵"}
                  </kbd>
                </button>
              )}
            </div>
          </>
        ) : isToolApproval ? (
          <>
            <div className="flex items-center gap-1.5 flex-wrap">
              {!isPlan && (
                <button
                  type="button"
                  onClick={engine.rejectTool}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-8 px-3.5 text-[12px] font-medium border transition-colors hover:bg-[#2A2A2A] cursor-pointer"
                  style={{
                    borderColor: "var(--cf-border)",
                    color: "var(--cf-text)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  拒绝
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  isPlan
                    ? engine.requestPlanChanges(engine.customText)
                    : engine.denyAndRedirect(engine.customText)
                }
                disabled={engine.isSubmitting}
                className="cf-touch-target h-8 px-3.5 text-[12px] font-medium border transition-colors hover:bg-[#2A2A2A] cursor-pointer"
                style={{
                  borderColor: "var(--cf-border)",
                  color: "var(--cf-muted)",
                  borderRadius: "var(--cf-radius-btn)",
                }}
              >
                {isPlan ? "提出修改意见" : `让 ${agentName} 修改`}
              </button>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {hasSessionScope && (
                <div className="relative inline-flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      setScopeMenuOpen(false);
                      engine.approveSession();
                    }}
                    disabled={engine.isSubmitting}
                    className={`cf-touch-target h-8 pl-3.5 ${canWorkspaceRule ? "pr-2 rounded-l-full border-r-0" : "pr-3.5 rounded-full"} text-[12px] font-medium border flex items-center gap-1.5 transition-colors hover:bg-[#2A2A2A] cursor-pointer`}
                    style={{
                      borderColor: "var(--cf-border)",
                      color: "var(--cf-text)",
                    }}
                  >
                    <span>本会话始终允许</span>
                    <kbd
                      className="cf-kbd text-[10px]"
                      style={{ fontFamily: "var(--cf-mono-font)", color: "var(--cf-muted)" }}
                    >
                      ⇧⌘↵
                    </kbd>
                  </button>
                  {canWorkspaceRule && (
                    <button
                      type="button"
                      aria-label="更多允许范围"
                      onClick={() => setScopeMenuOpen((v) => !v)}
                      disabled={engine.isSubmitting}
                      className="cf-touch-target h-8 px-2 rounded-r-full border flex items-center justify-center transition-colors hover:bg-[#2A2A2A] cursor-pointer"
                      style={{
                        borderColor: "var(--cf-border)",
                        color: "var(--cf-muted)",
                      }}
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {scopeMenuOpen && canWorkspaceRule && (
                    <div
                      className="absolute right-0 bottom-full mb-1.5 w-52 rounded-xl border p-1 shadow-xl z-30"
                      style={{
                        backgroundColor: "#1B1B1B",
                        borderColor: "var(--cf-border)",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setScopeMenuOpen(false);
                          engine.approveSession();
                        }}
                        className="w-full text-left px-2.5 py-1.5 rounded-lg text-[12px] hover:bg-[#2A2A2A] flex items-center justify-between cursor-pointer"
                        style={{ color: "var(--cf-text)" }}
                      >
                        <span>本会话允许</span>
                        <span className="text-[10px] font-mono" style={{ color: "var(--cf-muted)" }}>
                          ⇧⌘↵
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setScopeMenuOpen(false);
                          engine.approveWorkspaceRule();
                        }}
                        className="w-full text-left px-2.5 py-1.5 rounded-lg text-[12px] hover:bg-[#2A2A2A] flex items-center justify-between cursor-pointer"
                        style={{ color: "var(--cf-text)" }}
                      >
                        <span>此工作区永久允许</span>
                        <span className="text-[10px]" style={{ color: "var(--cf-muted)" }}>
                          跨会话
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  if (isPlan) {
                    if (engine.isOverrideActive) {
                      engine.requestPlanChanges(engine.customText);
                    } else {
                      engine.approvePlan();
                    }
                    return;
                  }
                  if (engine.isOverrideActive) {
                    engine.denyAndRedirect(engine.customText);
                  } else {
                    engine.approveOnce();
                  }
                }}
                disabled={engine.isSubmitting}
                className="cf-touch-target h-8 px-4 text-[12px] font-semibold flex items-center gap-1.5 transition-colors hover:bg-[#E5E5E5] disabled:opacity-50 cursor-pointer"
                style={{
                  backgroundColor: "var(--cf-accent)",
                  color: "var(--cf-on-accent)",
                  borderRadius: "var(--cf-radius-btn)",
                }}
              >
                <span>
                  {isPlan
                    ? engine.isOverrideActive
                      ? "提交修改意见"
                      : "批准并执行"
                    : engine.isOverrideActive
                    ? "拒绝并发送"
                    : isHighRisk
                    ? "允许本次 · 点击确认"
                    : "允许本次"}
                </span>
                <kbd
                  className="cf-kbd text-[10px] opacity-70"
                  style={{ fontFamily: "var(--cf-mono-font)" }}
                >
                  {isHighRisk && !engine.isOverrideActive ? "⌘↵" : "↵"}
                </kbd>
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={engine.skipCurrent}
              disabled={engine.isSubmitting}
              className="cf-touch-target h-8 px-3.5 text-[12px] font-medium border transition-colors hover:bg-[#2A2A2A] cursor-pointer"
              style={{
                borderColor: "var(--cf-border)",
                color: "var(--cf-muted)",
                borderRadius: "var(--cf-radius-btn)",
              }}
            >
              跳过
            </button>

            <div className="flex items-center gap-1.5">
              {!engine.isFirstItem && (
                <button
                  type="button"
                  onClick={engine.goPrev}
                  className="cf-touch-target h-8 px-3.5 text-[12px] font-medium border transition-colors hover:bg-[#2A2A2A] cursor-pointer"
                  style={{
                    borderColor: "var(--cf-border)",
                    color: "var(--cf-text)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  上一题
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  engine.isLastItem
                    ? engine.submitClarificationOrForm()
                    : engine.goNext()
                }
                disabled={engine.isSubmitting}
                className="cf-touch-target h-8 px-4 text-[12px] font-semibold flex items-center gap-1.5 transition-colors hover:bg-[#E5E5E5] disabled:opacity-50 cursor-pointer"
                style={{
                  backgroundColor: "var(--cf-accent)",
                  color: "var(--cf-on-accent)",
                  borderRadius: "var(--cf-radius-btn)",
                }}
              >
                <span>{engine.isLastItem ? "提交" : "下一步"}</span>
                <kbd
                  className="cf-kbd text-[10px] opacity-70"
                  style={{ fontFamily: "var(--cf-mono-font)" }}
                >
                  ↵
                </kbd>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
