"use client";

import React, { useLayoutEffect, useRef } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Minus,
  Pencil,
  Sparkles,
  X,
  AlertTriangle,
  Palette,
} from "lucide-react";
import type { ConfirmationEngineAPI } from "../engine/useConfirmationEngine";
import { parseUnifiedDiff, splitCodeLines } from "../engine/diffParser";
import type { ConcreteConfirmStyle } from "../types/protocol";

export interface StyleRendererProps {
  engine: ConfirmationEngineAPI;
  agentName: string;
  showTabHint: boolean;
  onCycleStyle: (next: ConcreteConfirmStyle) => void;
}

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

/**
 * 风格 A：Material（google_aistudio）完整独立视图渲染器
 * 设计基因：Material 3 Dark 无描边色阶分层、22px 大圆角、✦ 冰蓝星芒、独立圆角选项块、Filled 表单、冰蓝 Pill 胶囊栏
 */
export function MaterialStyle({
  engine,
  agentName,
  showTabHint,
  onCycleStyle,
}: StyleRendererProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const { entry, currentItem, currentAnswer, currentErrors } = engine;

  // 热切换后按 store 记忆还原输入框焦点与末尾光标
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
  const currentBatchKey = isBatch ? engine.batchItemKeys[engine.activeIndex] : null;
  const currentBatchSource = isBatch
    ? engine.batchItemSources[engine.activeIndex] || "主代理"
    : null;
  const currentBatchDecision = currentBatchKey
    ? engine.batchDecisions[currentBatchKey]
    : undefined;
  const allowAllLabel =
    engine.batchHighRiskCount > 0
      ? `Allow all (${engine.batchNonHighCount})，${engine.batchHighRiskCount} 项需单独确认`
      : `Allow all (${engine.batchItems.length})`;
  const riskMeta = isPlan
    ? { label: "实现计划", bg: "rgba(168,199,250,0.16)", color: "#A8C7FA" }
    : currentItem.risk_level === "high"
      ? { label: "高风险", bg: "rgba(242,184,181,0.16)", color: "#F2B8B5" }
      : currentItem.risk_level === "medium"
      ? { label: "中风险", bg: "rgba(253,226,147,0.15)", color: "#FDE293" }
      : { label: "低风险", bg: "rgba(168,218,181,0.15)", color: "#A8DAB5" };

  // 超时只读结案态
  if (engine.isReadOnlyResolved) {
    return (
      <div
        ref={cardRef}
        className="cf-anim-material w-full p-5"
        style={{
          backgroundColor: "var(--cf-surface)",
          borderRadius: "var(--cf-radius-card)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
          fontFamily: "var(--cf-body-font)",
          color: "var(--cf-text)",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: "var(--cf-surface-2)", color: "var(--cf-muted)" }}
            >
              <Sparkles className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[15px] font-medium truncate">
                {entry.resolvedDecision === "timeout"
                  ? "本次确认已超时自动结案"
                  : "本次确认已结案"}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--cf-muted)" }}>
                {engine.timeoutDraftText
                  ? "你可以将已填写的草稿直接作为新消息发送给 " + agentName
                  : agentName + " 将按默认安全策略继续推进"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {engine.timeoutDraftText && (
              <button
                type="button"
                onClick={engine.sendTimeoutDraftAsMessage}
                className="h-9 px-4 text-xs font-medium transition-colors cursor-pointer"
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
              className="w-8 h-8 rounded-full flex items-center justify-center transition-colors hover:bg-white/10 cursor-pointer"
              style={{ color: "var(--cf-muted)" }}
            >
              <X className="w-4 h-4" />
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
        className="cf-anim-material w-full px-4 py-2.5 flex items-center justify-between gap-3 cursor-pointer select-none transition-colors hover:brightness-110"
        style={{
          backgroundColor: "var(--cf-surface)",
          borderRadius: "999px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
          fontFamily: "var(--cf-body-font)",
          color: "var(--cf-text)",
        }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[13px]"
            style={{
              backgroundColor: "rgba(168,199,250,0.14)",
              color: "var(--cf-accent)",
            }}
          >
            ✦
          </span>
          <span className="text-[13px] font-medium truncate">
            {currentItem.title}
          </span>
          {engine.totalItems > 1 && (
            <span
              className="text-[11px] px-2 py-0.5 rounded-full shrink-0 tabular-nums"
              style={{
                backgroundColor: "var(--cf-surface-2)",
                color: "var(--cf-muted)",
              }}
            >
              {engine.activeIndex + 1}/{engine.totalItems}
            </span>
          )}
          {engine.queueLength > 1 && (
            <span
              className="text-[11px] px-2 py-0.5 rounded-full shrink-0"
              style={{
                backgroundColor: "var(--cf-surface-2)",
                color: "var(--cf-muted)",
              }}
            >
              +{engine.queueLength - 1} 待处理
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {engine.countdownSeconds !== null && (
            <span
              className="text-[11.5px] font-medium tabular-nums"
              style={{ color: "var(--cf-accent)" }}
            >
              {formatCountdown(engine.countdownSeconds)}
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              engine.toggleMinimized();
            }}
            aria-label="展开确认卡片"
            className="h-7 px-3 rounded-full text-[12px] font-medium flex items-center gap-1 transition-colors cursor-pointer"
            style={{
              backgroundColor: "var(--cf-accent)",
              color: "var(--cf-on-accent)",
            }}
          >
            <span>展开</span>
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  // Material 风格 tool_approval 单选审批项映射（§2.5）
  const materialApprovalChoices = isPlan
    ? [
        {
          index: 0,
          label: "批准并执行",
          desc: `切换至 Act 模式，由 ${agentName} 按计划开始实施`,
          recommended: true,
          action: engine.approvePlan,
        },
        {
          index: 1,
          label: "提出修改意见",
          desc: "在下方输入调整意见，让计划修订后再审批",
          recommended: false,
          action: () => engine.requestPlanChanges(),
        },
      ]
    : [
    {
      index: 0,
      label: "允许本次",
      desc: "仅批准执行这一次操作",
      recommended: true,
      action: engine.approveOnce,
    },
    ...(hasSessionScope
      ? [
          {
            index: 1,
            label: "本会话内允许同类操作",
            desc: `同类签名：${currentItem.scope_signature}`,
            recommended: false,
            action: engine.approveSession,
          },
        ]
      : []),
    {
      index: hasSessionScope ? 2 : 1,
      label: "拒绝",
      desc: `中止此操作并告知 ${agentName}`,
      recommended: false,
      action: engine.rejectTool,
    },
  ];

  const handleMaterialPrimaryClick = () => {
    if (isToolApproval) {
      if (engine.isOverrideActive) {
        if (isPlan) {
          engine.requestPlanChanges(engine.customText);
        } else {
          engine.denyAndRedirect(engine.customText);
        }
        return;
      }
      const chosen =
        materialApprovalChoices[engine.approvalSelectionIndex] ||
        materialApprovalChoices[0];
      chosen.action();
      return;
    }
    if (!engine.isLastItem) {
      engine.goNext();
    } else {
      engine.submitClarificationOrForm();
    }
  };

  // 倒计时 SVG 圆环计算（最后 15s）
  const countdownRatio =
    engine.countdownSeconds !== null
      ? Math.max(0, Math.min(1, engine.countdownSeconds / 15))
      : 0;
  const ringCircumference = 2 * Math.PI * 7;

  return (
    <div
      ref={cardRef}
      className="cf-anim-material w-full p-5 select-none"
      style={{
        backgroundColor: "var(--cf-surface)",
        borderRadius: "var(--cf-radius-card)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        fontFamily: "var(--cf-body-font)",
        color: "var(--cf-text)",
      }}
    >
      {/* 1. Material 顶部标题栏：✦ 冰蓝星芒 + 无衬线标题 + 分页点 + 圆环倒计时 + 热切换 + 圆形 Ghost X */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-[15px]"
            style={{
              backgroundColor: "rgba(168,199,250,0.14)",
              color: "var(--cf-accent)",
            }}
            aria-hidden="true"
          >
            ✦
          </span>
          <div className="min-w-0">
            <div className="flex items-center flex-wrap gap-2">
              <h3
                className="text-[16px] font-medium leading-snug"
                style={{ fontFamily: "var(--cf-title-font)", color: "var(--cf-text)" }}
              >
                {currentItem.title}
              </h3>
              {currentItem.selection_mode === "multi" && (
                <span
                  className="px-2 py-0.5 text-[11px] font-medium rounded-full"
                  style={{
                    backgroundColor: "rgba(168,199,250,0.14)",
                    color: "var(--cf-accent)",
                  }}
                >
                  可多选
                </span>
              )}
              {engine.queueLength > 1 && (
                <span
                  className="px-2 py-0.5 text-[11px] rounded-full"
                  style={{
                    backgroundColor: "var(--cf-surface-2)",
                    color: "var(--cf-muted)",
                  }}
                >
                  +{engine.queueLength - 1} 待处理
                </span>
              )}
              {showTabHint && (
                <span
                  className="px-2 py-0.5 text-[11px] rounded-full"
                  style={{
                    backgroundColor: "var(--cf-surface-2)",
                    color: "var(--cf-muted)",
                  }}
                >
                  按 Tab 进入审批
                </span>
              )}
            </div>
            {currentItem.subtitle && (
              <p
                className="text-[12.5px] mt-1 leading-relaxed"
                style={{ color: "var(--cf-muted)" }}
              >
                {currentItem.subtitle}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* 倒计时冰蓝圆环（最后 15s） */}
          {engine.countdownSeconds !== null && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono tabular-nums"
              style={{
                backgroundColor: "rgba(168,199,250,0.12)",
                color: "var(--cf-accent)",
              }}
              aria-live="polite"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
                <circle
                  cx="9"
                  cy="9"
                  r="7"
                  fill="none"
                  stroke="rgba(168,199,250,0.22)"
                  strokeWidth="2"
                />
                <circle
                  cx="9"
                  cy="9"
                  r="7"
                  fill="none"
                  stroke="#A8C7FA"
                  strokeWidth="2"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={ringCircumference * (1 - countdownRatio)}
                />
              </svg>
              <span>{formatCountdown(engine.countdownSeconds)}</span>
            </div>
          )}

          {/* 分页器 ‹ 1/N › */}
          {engine.totalItems > 1 && (
            <div
              className="flex items-center gap-1 px-1.5 py-1 rounded-full text-xs"
              style={{
                backgroundColor: "var(--cf-surface-2)",
                color: "var(--cf-muted)",
              }}
            >
              <button
                type="button"
                onClick={engine.goPrev}
                disabled={engine.isFirstItem}
                aria-label="上一题"
                className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-30 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="px-1 font-mono tabular-nums text-[11px]">
                {engine.activeIndex + 1}/{engine.totalItems}
              </span>
              <button
                type="button"
                onClick={engine.goNext}
                disabled={engine.isLastItem}
                aria-label="下一题"
                className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-30 cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 右上角极简风格热切换按钮（阻止 mousedown 避免丢失当前输入框焦点） */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCycleStyle(getNextStyle("google_aistudio"))}
            title="切换气泡风格（当前：Material）"
            aria-label="切换气泡风格"
            className="h-8 px-2.5 rounded-full flex items-center gap-1 text-[11px] transition-colors cursor-pointer"
            style={{
              backgroundColor: "var(--cf-surface-2)",
              color: "var(--cf-muted)",
            }}
          >
            <Palette className="w-3.5 h-3.5" />
            <span>Material</span>
          </button>

          {/* 圆形 ghost 最小化按钮 */}
          <button
            type="button"
            onClick={engine.toggleMinimized}
            title="最小化（保留待确认状态）"
            aria-label="最小化确认卡片"
            className="w-8 h-8 rounded-full flex items-center justify-center transition-colors hover:bg-white/10 cursor-pointer"
            style={{ color: "var(--cf-muted)" }}
          >
            <Minus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 进度胶囊点（多题时展示） */}
      {engine.totalItems > 1 && (
        <div className="flex items-center gap-1.5 mt-3 pl-10">
          {request.items.map((it, idx) => {
            const ans = draft.answers[it.item_id];
            const isCurrent = idx === engine.activeIndex;
            const isAnswered =
              ans?.touched && ans.status !== "skipped";
            return (
              <button
                key={it.item_id}
                type="button"
                onClick={() => engine.goTo(idx)}
                aria-label={`跳转到第 ${idx + 1} 题`}
                className="h-1.5 rounded-full transition-all cursor-pointer"
                style={{
                  width: isCurrent ? "22px" : "8px",
                  backgroundColor: isCurrent
                    ? "var(--cf-accent)"
                    : isAnswered
                    ? "rgba(168,199,250,0.48)"
                    : "rgba(255,255,255,0.14)",
                }}
              />
            );
          })}
        </div>
      )}

      {/* P2-4 Material 批量分页器 ‹ 1/N › + 状态胶囊点（无边框色阶胶囊） */}
      {isBatch && (
        <div
          data-testid="material-batch-stepper"
          className="mt-3 flex items-center justify-between gap-2 px-3.5 py-2 rounded-[14px]"
          style={{ backgroundColor: "var(--cf-surface-2)" }}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={engine.goPrev}
              disabled={engine.isFirstItem}
              aria-label="上一项"
              className="w-6 h-6 rounded-full flex items-center justify-center hover:bg-white/[0.08] disabled:opacity-30 cursor-pointer"
              style={{ color: "var(--cf-text)" }}
            >
              ‹
            </button>
            <span className="text-[12px] font-medium tabular-nums" style={{ color: "var(--cf-text)" }}>
              {engine.activeIndex + 1}/{engine.batchItems.length}
            </span>
            <button
              type="button"
              onClick={engine.goNext}
              disabled={engine.isLastItem}
              aria-label="下一项"
              className="w-6 h-6 rounded-full flex items-center justify-center hover:bg-white/[0.08] disabled:opacity-30 cursor-pointer"
              style={{ color: "var(--cf-text)" }}
            >
              ›
            </button>

            <div className="flex items-center gap-1.5 ml-1">
              {engine.batchItems.map((bItem, idx) => {
                const bKey = engine.batchItemKeys[idx];
                const bDec = bKey ? engine.batchDecisions[bKey] : undefined;
                const isCurr = idx === engine.activeIndex;
                const bg =
                  bDec?.decision === "approved"
                    ? "#A8DAB5"
                    : bDec?.decision === "rejected"
                      ? "#F2B8B5"
                      : bItem.risk_level === "high"
                        ? "#FDE293"
                        : isCurr
                          ? "var(--cf-accent)"
                          : "rgba(255,255,255,0.18)";
                return (
                  <button
                    key={bKey || idx}
                    type="button"
                    onClick={() => engine.goTo(idx)}
                    aria-label={`切换到第 ${idx + 1} 项`}
                    className="h-2 rounded-full transition-all cursor-pointer"
                    style={{
                      width: isCurr ? "20px" : "8px",
                      backgroundColor: bg,
                    }}
                  />
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--cf-muted)" }}>
            {currentBatchSource && <span>{currentBatchSource}</span>}
            {currentBatchDecision && (
              <span
                className="px-2 py-0.5 rounded-full font-medium"
                style={{
                  backgroundColor:
                    currentBatchDecision.decision === "approved"
                      ? "rgba(168,218,181,0.16)"
                      : "rgba(242,184,181,0.16)",
                  color:
                    currentBatchDecision.decision === "approved"
                      ? "#A8DAB5"
                      : "#F2B8B5",
                }}
              >
                {currentBatchDecision.decision === "approved" ? "已批准" : "已拒绝"}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 2. 主内容区：按 kind 独立呈现 Material 风格 */}
      <div className="mt-4 space-y-3">
        {/* 2a. tool_approval：圆角代码块 + 风险胶囊 + 单选审批项 */}
        {isToolApproval && (
          <>
            {currentItem.code_preview && (
              <div
                className="overflow-hidden"
                style={{
                  backgroundColor: "var(--cf-surface-2)",
                  borderRadius: "12px",
                }}
              >
                <div className="flex items-center justify-between px-3.5 py-2 text-[11.5px]">
                  <span
                    className="font-mono truncate"
                    style={{ color: "var(--cf-muted)", fontFamily: "var(--cf-mono-font)" }}
                  >
                    {currentItem.code_preview.filename ||
                      currentItem.tool_name ||
                      currentItem.code_preview.language}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    {currentItem.diff_stat && (
                      <span
                        className="px-2 py-0.5 rounded-full text-[11px] font-mono tabular-nums"
                        style={{
                          backgroundColor: "rgba(255,255,255,0.06)",
                          color: "var(--cf-text)",
                        }}
                      >
                        {currentItem.diff_stat}
                      </span>
                    )}
                    <span
                      className="px-2.5 py-0.5 rounded-full text-[11px] font-medium flex items-center gap-1"
                      style={{ backgroundColor: riskMeta.bg, color: riskMeta.color }}
                    >
                      {isHighRisk && <AlertTriangle className="w-3 h-3" />}
                      {riskMeta.label}
                    </span>
                  </div>
                </div>

                <div
                  className="px-3.5 pb-3 pt-1 max-h-52 overflow-auto text-[12px] leading-relaxed"
                  style={{ fontFamily: "var(--cf-mono-font)" }}
                >
                  {currentItem.code_preview.language === "diff" ? (
                    <div className="space-y-0.5">
                      {parseUnifiedDiff(currentItem.code_preview.content).lines.map(
                        (ln, idx) => (
                          <div
                            key={idx}
                            className="px-2 py-0.5 rounded whitespace-pre-wrap break-all"
                            style={{
                              backgroundColor:
                                ln.kind === "add"
                                  ? "rgba(129,201,149,0.14)"
                                  : ln.kind === "del"
                                  ? "rgba(242,139,130,0.14)"
                                  : "transparent",
                              color:
                                ln.kind === "add"
                                  ? "#A8DAB5"
                                  : ln.kind === "del"
                                  ? "#F2B8B5"
                                  : ln.kind === "hunk"
                                  ? "#A8C7FA"
                                  : "var(--cf-text)",
                            }}
                          >
                            <span className="select-none mr-2 opacity-60">
                              {ln.prefix}
                            </span>
                            {ln.content}
                          </div>
                        )
                      )}
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap break-all m-0 text-[#E3E3E3]">
                      {splitCodeLines(currentItem.code_preview.content)
                        .map((l) => l.content)
                        .join("\n")}
                    </pre>
                  )}
                </div>
              </div>
            )}

            {/* Material 单选审批项（override 有文本时降暗至 0.38；批量模式下由底部胶囊栏控制） */}
            {!isBatch && (
            <div
              className="space-y-2 transition-opacity duration-150"
              style={{ opacity: engine.isOverrideActive ? 0.38 : 1 }}
            >
              {materialApprovalChoices.map((choice) => {
                const selected =
                  !engine.isOverrideActive &&
                  engine.approvalSelectionIndex === choice.index;
                return (
                  <button
                    key={choice.index}
                    type="button"
                    onClick={() => {
                      engine.setCustomText("");
                      engine.setApprovalSelectionIndex(choice.index);
                    }}
                    onDoubleClick={() => {
                      engine.setCustomText("");
                      choice.action();
                    }}
                    className="cf-touch-target w-full px-3.5 py-2.5 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                    style={{
                      borderRadius: "var(--cf-radius-option)",
                      backgroundColor: selected
                        ? "var(--cf-selected)"
                        : "var(--cf-surface-2)",
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className="w-6 h-6 rounded-full text-xs font-medium flex items-center justify-center shrink-0"
                        style={{
                          backgroundColor: selected
                            ? "var(--cf-accent)"
                            : "rgba(255,255,255,0.08)",
                          color: selected
                            ? "var(--cf-on-accent)"
                            : "var(--cf-muted)",
                        }}
                      >
                        {choice.index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[13.5px] font-medium">
                            {choice.label}
                          </span>
                          {choice.recommended && (
                            <span
                              className="px-2 py-0.5 rounded-full text-[10.5px] font-medium"
                              style={{
                                backgroundColor: "rgba(168,199,250,0.16)",
                                color: "var(--cf-accent)",
                              }}
                            >
                              推荐
                            </span>
                          )}
                        </div>
                        <div
                          className="text-[11.5px] truncate mt-0.5"
                          style={{ color: "var(--cf-muted)" }}
                        >
                          {choice.desc}
                        </div>
                      </div>
                    </div>
                    {selected && (
                      <Check
                        className="w-4 h-4 shrink-0"
                        style={{ color: "var(--cf-accent)" }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
            )}
          </>
        )}

        {/* 2b. clarification：独立圆角色阶选项块（单选 / 多选） */}
        {(currentItem.selection_mode === "single" ||
          currentItem.selection_mode === "multi") &&
          currentItem.options && (
            <div
              className="space-y-2 transition-opacity duration-150"
              data-testid="cf-options-container"
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
                    className="cf-touch-target w-full px-4 py-3 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                    style={{
                      borderRadius: "var(--cf-radius-option)",
                      backgroundColor: isSelected
                        ? "var(--cf-selected)"
                        : isFocused
                        ? "var(--cf-hover)"
                        : "var(--cf-surface-2)",
                      boxShadow: isFocused && !isSelected
                        ? "inset 0 0 0 1px rgba(168,199,250,0.45)"
                        : undefined,
                    }}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      {isMulti ? (
                        <span
                          className="w-5 h-5 mt-0.5 rounded-[6px] flex items-center justify-center shrink-0 transition-colors"
                          style={{
                            backgroundColor: isSelected
                              ? "var(--cf-accent)"
                              : "rgba(255,255,255,0.08)",
                            color: "var(--cf-on-accent)",
                          }}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.8]" />}
                        </span>
                      ) : (
                        <span
                          className="w-6 h-6 rounded-full text-xs font-medium flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: isSelected
                              ? "var(--cf-accent)"
                              : "rgba(255,255,255,0.08)",
                            color: isSelected
                              ? "var(--cf-on-accent)"
                              : "var(--cf-muted)",
                          }}
                        >
                          {idx + 1}
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center flex-wrap gap-2">
                          <span className="text-[14px] font-medium">
                            {opt.label}
                          </span>
                          {opt.recommended && (
                            <span
                              className="px-2 py-0.5 rounded-full text-[10.5px] font-medium"
                              style={{
                                backgroundColor: "rgba(168,199,250,0.16)",
                                color: "var(--cf-accent)",
                              }}
                            >
                              推荐
                            </span>
                          )}
                        </div>
                        {opt.description && (
                          <p
                            className="text-[12px] mt-0.5 leading-snug"
                            style={{ color: "var(--cf-muted)" }}
                          >
                            {opt.description}
                          </p>
                        )}
                      </div>
                    </div>
                    {!isMulti && isSelected && (
                      <Check
                        className="w-4 h-4 shrink-0"
                        style={{ color: "var(--cf-accent)" }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}

        {/* 2c. parameter_form：Material Filled 双列色阶填充表单 */}
        {currentItem.selection_mode === "form" && currentItem.form_fields && (
          <div className="cf-form-grid-2col grid grid-cols-2 gap-3">
            {currentItem.form_fields.map((field) => {
              const fieldId = `field:${field.key}`;
              const val = currentAnswer?.form_values?.[field.key];
              const err = currentErrors[field.key];
              return (
                <div
                  key={field.key}
                  className={field.type === "json" ? "col-span-2" : ""}
                >
                  <div
                    className="px-3.5 py-2.5 rounded-t-[12px] rounded-b-[4px] border-b-2 transition-colors"
                    style={{
                      backgroundColor: "var(--cf-surface-2)",
                      borderBottomColor: err
                        ? "#F2B8B5"
                        : draft.focusedField === fieldId
                        ? "var(--cf-accent)"
                        : "rgba(255,255,255,0.16)",
                    }}
                  >
                    <label className="block text-[11px] font-medium mb-1" style={{ color: "var(--cf-accent)" }}>
                      {field.label}
                      {field.required && <span className="ml-1 text-[#F2B8B5]">*</span>}
                    </label>
                    {field.type === "boolean" ? (
                      <button
                        type="button"
                        data-cf-field={fieldId}
                        onFocus={() => engine.setFocusedField(fieldId)}
                        onBlur={() => engine.setFocusedField(null)}
                        onClick={() => engine.setFormValue(field.key, !Boolean(val))}
                        className="flex items-center gap-2 text-xs py-1 cursor-pointer"
                      >
                        <span
                          className="w-9 h-5 rounded-full p-0.5 transition-colors inline-flex items-center"
                          style={{
                            backgroundColor: Boolean(val)
                              ? "var(--cf-accent)"
                              : "rgba(255,255,255,0.18)",
                          }}
                        >
                          <span
                            className="w-4 h-4 rounded-full transition-transform"
                            style={{
                              backgroundColor: Boolean(val) ? "var(--cf-on-accent)" : "#E3E3E3",
                              transform: Boolean(val) ? "translateX(16px)" : "translateX(0)",
                            }}
                          />
                        </span>
                        <span>{Boolean(val) ? "已开启" : "已关闭"}</span>
                      </button>
                    ) : field.type === "select" ? (
                      <select
                        data-cf-field={fieldId}
                        value={String(val ?? "")}
                        onFocus={() => engine.setFocusedField(fieldId)}
                        onBlur={() => engine.setFocusedField(null)}
                        onChange={(e) => engine.setFormValue(field.key, e.target.value)}
                        className="w-full bg-transparent text-[13px] outline-none"
                        style={{ color: "var(--cf-text)" }}
                      >
                        {(field.options || []).map((opt) => (
                          <option
                            key={opt.value}
                            value={opt.value}
                            className="bg-[#282A2C] text-[#E3E3E3]"
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
                        className="w-full bg-transparent text-[12px] outline-none resize-y"
                        style={{
                          fontFamily: "var(--cf-mono-font)",
                          color: "var(--cf-text)",
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
                        className="w-full bg-transparent text-[13px] outline-none placeholder:text-[#757B82]"
                        style={{ color: "var(--cf-text)" }}
                      />
                    )}
                  </div>
                  {err ? (
                    <div className="text-[11px] mt-1 px-1 text-[#F2B8B5]">{err}</div>
                  ) : field.description ? (
                    <div className="text-[11px] mt-1 px-1" style={{ color: "var(--cf-muted)" }}>
                      {field.description}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* 3. Material Inline Write-In 自由输入 Pill 行 */}
        {currentItem.selection_mode !== "form" &&
          currentItem.custom_input?.enabled !== false && (
            <div>
              <div
                className="flex items-center gap-2.5 px-4 py-2.5 rounded-full transition-colors"
                style={{
                  backgroundColor:
                    draft.focusedField === "writein"
                      ? "#2D3035"
                      : "var(--cf-surface-2)",
                  border:
                    draft.focusedField === "writein"
                      ? "1.5px solid var(--cf-accent)"
                      : "1.5px solid transparent",
                }}
              >
                <Pencil className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--cf-muted)" }} />
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
                      ? `拒绝并告知 ${agentName} 调整方向…`
                      : `或者告诉 ${agentName} 其他想法…`)
                  }
                  className="w-full bg-transparent text-[13px] outline-none placeholder:text-[#848A91]"
                  style={{ color: "var(--cf-text)" }}
                />
                {engine.isOverrideActive && (
                  <span
                    className="text-[11px] whitespace-nowrap px-2 py-0.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: "rgba(168,199,250,0.14)",
                      color: "var(--cf-accent)",
                    }}
                  >
                    已覆盖上方预设
                  </span>
                )}
                {!engine.isOverrideActive &&
                  currentItem.selection_mode === "multi" &&
                  engine.customText.trim().length > 0 && (
                    <span
                      className="text-[11px] whitespace-nowrap px-2 py-0.5 rounded-full shrink-0"
                      style={{
                        backgroundColor: "rgba(168,199,250,0.14)",
                        color: "var(--cf-accent)",
                      }}
                    >
                      + 附加至已选 {engine.appendSelectedCount} 项
                    </span>
                  )}
              </div>
            </div>
          )}
      </div>

      {/* 4. Material 底部胶囊操作栏（左 ghost 跳过，右 40px 冰蓝 Pill 主按钮） */}
      <div className="cf-footer-bar flex items-center justify-between gap-3 mt-5 pt-1">
        {isBatch ? (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => engine.decideBatchItem("rejected", "once", true)}
                disabled={engine.isSubmitting}
                className="cf-touch-target h-10 px-4 text-[13px] font-medium transition-colors hover:bg-white/[0.06] cursor-pointer"
                style={{
                  color: "var(--cf-muted)",
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
                  className="cf-touch-target h-10 px-4 text-[13px] font-medium transition-colors hover:bg-white/[0.08] cursor-pointer"
                  style={{
                    backgroundColor: "var(--cf-surface-2)",
                    color: "var(--cf-text)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  {allowAllLabel}
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {engine.batchAllResolved ? (
                <button
                  type="button"
                  onClick={engine.submitBatch}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-10 px-5 text-[13px] font-semibold flex items-center gap-2 transition-opacity hover:opacity-95 disabled:opacity-50 cursor-pointer"
                  style={{
                    backgroundColor: "var(--cf-accent)",
                    color: "var(--cf-on-accent)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  <span>提交全部 ({engine.batchItems.length})</span>
                  <kbd
                    className="cf-kbd px-1.5 py-0.5 text-[10.5px] rounded-full font-mono"
                    style={{
                      backgroundColor: "rgba(6,46,111,0.16)",
                      color: "var(--cf-on-accent)",
                    }}
                  >
                    ⌘↵
                  </kbd>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => engine.decideBatchItem("approved", "once", true)}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-10 px-5 text-[13px] font-semibold flex items-center gap-2 transition-opacity hover:opacity-95 disabled:opacity-50 cursor-pointer"
                  style={{
                    backgroundColor: "var(--cf-accent)",
                    color: "var(--cf-on-accent)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  <span>{isHighRisk ? "允许此项 · 点击确认" : "允许并下一条"}</span>
                  <kbd
                    className="cf-kbd px-1.5 py-0.5 text-[10.5px] rounded-full font-mono"
                    style={{
                      backgroundColor: "rgba(6,46,111,0.16)",
                      color: "var(--cf-on-accent)",
                    }}
                  >
                    {isHighRisk ? "⌘↵" : "↵"}
                  </kbd>
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              {isToolApproval ? (
                <button
                  type="button"
                  onClick={() =>
                    isPlan
                      ? engine.requestPlanChanges(engine.customText)
                      : engine.denyAndRedirect()
                  }
                  className="cf-touch-target h-10 px-4 text-[13px] font-medium transition-colors hover:bg-white/[0.06] cursor-pointer"
                  style={{
                    color: "var(--cf-muted)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  {isPlan ? "提出修改意见…" : `拒绝并告知 ${agentName}…`}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={engine.skipCurrent}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-10 px-4 text-[13px] font-medium transition-colors hover:bg-white/[0.06] cursor-pointer"
                  style={{
                    color: "var(--cf-muted)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  跳过
                </button>
              )}

              {isToolApproval && !isPlan && canWorkspaceRule && (
                <button
                  type="button"
                  onClick={engine.approveWorkspaceRule}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-10 px-3.5 text-[12.5px] font-medium transition-colors hover:bg-white/[0.08] cursor-pointer"
                  style={{
                    backgroundColor: "var(--cf-surface-2)",
                    color: "var(--cf-text)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  此工作区永久允许
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleMaterialPrimaryClick}
                disabled={engine.isSubmitting}
                className="cf-touch-target h-10 px-5 text-[13px] font-semibold flex items-center gap-2 transition-opacity hover:opacity-95 disabled:opacity-50 cursor-pointer"
                style={{
                  backgroundColor: "var(--cf-accent)",
                  color: "var(--cf-on-accent)",
                  borderRadius: "var(--cf-radius-btn)",
                }}
              >
                <span>
                  {isToolApproval
                    ? engine.isOverrideActive
                      ? isPlan
                        ? "提交修改意见"
                        : "拒绝并发送"
                      : isHighRisk && engine.approvalSelectionIndex === 0
                      ? "允许本次 · 点击确认"
                      : materialApprovalChoices[engine.approvalSelectionIndex]?.label ||
                        "允许本次"
                    : !engine.isLastItem
                    ? "下一步"
                    : "提交"}
                </span>
                <kbd
                  className="cf-kbd px-1.5 py-0.5 text-[10.5px] rounded-full font-mono"
                  style={{
                    backgroundColor: "rgba(6,46,111,0.16)",
                    color: "var(--cf-on-accent)",
                  }}
                >
                  {isToolApproval &&
                  isHighRisk &&
                  !engine.isOverrideActive &&
                  engine.approvalSelectionIndex < (hasSessionScope ? 2 : 1)
                    ? "⌘↵"
                    : "↵"}
                </kbd>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
