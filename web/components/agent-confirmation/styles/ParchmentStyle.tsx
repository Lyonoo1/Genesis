"use client";

import React, { useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Minus, Pencil, X, Palette } from "lucide-react";
import type { StyleRendererProps } from "./MaterialStyle";
import { parseUnifiedDiff, splitCodeLines } from "../engine/diffParser";
import type { ConcreteConfirmStyle } from "../types/protocol";

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
 * 风格 B：Parchment（claude_desktop）完整独立视图渲染器
 * 设计基因：暖炭羊皮纸 #242320 + 1px 温润描边 + ✳ 陶土橙星芒 + Newsreader 衬线问句
 *          + 细分隔线编号行（选中左侧陶土橙竖条）+ 暖黑内凹代码块 + 严格单描边原则按钮栏
 */
export function ParchmentStyle({
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

  // 超时只读结案态
  if (engine.isReadOnlyResolved) {
    return (
      <div
        ref={cardRef}
        className="cf-anim-parchment w-full px-5 py-4"
        style={{
          backgroundColor: "var(--cf-surface)",
          border: "1px solid var(--cf-border)",
          borderRadius: "var(--cf-radius-card)",
          boxShadow: "inset 0 1px 0 rgba(255,250,240,0.04), 0 6px 24px rgba(0,0,0,0.28)",
          fontFamily: "var(--cf-body-font)",
          color: "var(--cf-text)",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-[17px] leading-none" style={{ color: "var(--cf-muted)" }}>
              ✳
            </span>
            <div className="min-w-0">
              <div
                className="text-[17px] leading-snug"
                style={{ fontFamily: "var(--cf-title-font)" }}
              >
                {entry.resolvedDecision === "timeout"
                  ? "本次确认已超时自动结案"
                  : "本次确认已结案"}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--cf-muted)" }}>
                {engine.timeoutDraftText
                  ? `草稿已暂存，可直接作为消息发送给 ${agentName}`
                  : `${agentName} 已按默认策略继续`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {engine.timeoutDraftText && (
              <button
                type="button"
                onClick={engine.sendTimeoutDraftAsMessage}
                className="h-8 px-3.5 text-xs font-medium transition-colors cursor-pointer"
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
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/5 cursor-pointer"
              style={{ color: "var(--cf-muted)" }}
            >
              <X className="w-4 h-4 stroke-[1.6]" />
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
        className="cf-anim-parchment w-full px-4 py-2.5 flex items-center justify-between gap-3 cursor-pointer select-none transition-colors hover:brightness-105"
        style={{
          backgroundColor: "var(--cf-surface)",
          border: "1px solid var(--cf-border)",
          borderRadius: "12px",
          boxShadow: "inset 0 1px 0 rgba(255,250,240,0.04), 0 6px 20px rgba(0,0,0,0.28)",
          fontFamily: "var(--cf-body-font)",
          color: "var(--cf-text)",
        }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="text-[16px] leading-none shrink-0"
            style={{ color: "var(--cf-accent)" }}
            aria-hidden="true"
          >
            ✳
          </span>
          <span
            className="text-[14.5px] font-medium truncate"
            style={{ fontFamily: "var(--cf-title-font)", color: "var(--cf-text)" }}
          >
            {currentItem.title}
          </span>
          {engine.totalItems > 1 && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded shrink-0 tabular-nums"
              style={{
                backgroundColor: "rgba(222,220,209,0.08)",
                color: "var(--cf-muted)",
              }}
            >
              {engine.activeIndex + 1}/{engine.totalItems}
            </span>
          )}
          {engine.queueLength > 1 && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded shrink-0"
              style={{
                backgroundColor: "rgba(222,220,209,0.08)",
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
              className="text-[12px] tabular-nums"
              style={{ fontFamily: "var(--cf-title-font)", color: "#D97757" }}
            >
              剩余 {formatCountdown(engine.countdownSeconds)}
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              engine.toggleMinimized();
            }}
            aria-label="展开确认卡片"
            className="h-7 px-3 rounded-[8px] text-[12px] font-medium flex items-center gap-1 transition-colors cursor-pointer"
            style={{
              backgroundColor: "rgba(222,220,209,0.1)",
              color: "var(--cf-text)",
            }}
          >
            <span>展开</span>
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      className="cf-anim-parchment w-full px-5 py-4 select-none"
      style={{
        backgroundColor: "var(--cf-surface)",
        border: "1px solid var(--cf-border)",
        borderRadius: "var(--cf-radius-card)",
        boxShadow: "inset 0 1px 0 rgba(255,250,240,0.04), 0 6px 24px rgba(0,0,0,0.28)",
        fontFamily: "var(--cf-body-font)",
        color: "var(--cf-text)",
      }}
    >
      {/* 1. Parchment 衬线标题区：✳ 陶土橙星芒 + Newsreader 18px 衬线问句 + 暖灰副标题 + 线形 X */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <span
            className="text-[18px] leading-none mt-1 shrink-0"
            style={{ color: "var(--cf-accent)" }}
            aria-hidden="true"
          >
            ✳
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline flex-wrap gap-2">
              <h3
                className="text-[18px] font-medium leading-snug tracking-[-0.01em]"
                style={{
                  fontFamily: "var(--cf-title-font)",
                  color: "var(--cf-text)",
                }}
              >
                {currentItem.title}
              </h3>
              {currentItem.selection_mode === "multi" && (
                <span
                  className="text-[12px] italic"
                  style={{
                    fontFamily: "var(--cf-title-font)",
                    color: "var(--cf-muted)",
                  }}
                >
                  可多选
                </span>
              )}
              {engine.queueLength > 1 && (
                <span
                  className="text-[11px] px-2 py-0.5 rounded-md"
                  style={{
                    backgroundColor: "rgba(222,220,209,0.08)",
                    color: "var(--cf-muted)",
                  }}
                >
                  +{engine.queueLength - 1} 待处理
                </span>
              )}
              {showTabHint && (
                <span
                  className="text-[11px]"
                  style={{ color: "var(--cf-muted)" }}
                >
                  · 按 Tab 进入审批
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
          {/* 最后 15s 暖灰衬线倒计时 */}
          {engine.countdownSeconds !== null && (
            <span
              className="text-[13px] tabular-nums px-1.5"
              style={{
                fontFamily: "var(--cf-title-font)",
                color: "#D97757",
              }}
              aria-live="polite"
            >
              剩余 {formatCountdown(engine.countdownSeconds)}
            </span>
          )}

          {/* 多题翻页 */}
          {engine.totalItems > 1 && (
            <div
              className="flex items-center gap-0.5 text-[12px]"
              style={{ color: "var(--cf-muted)" }}
            >
              <button
                type="button"
                onClick={engine.goPrev}
                disabled={engine.isFirstItem}
                aria-label="上一题"
                className="w-6 h-6 rounded flex items-center justify-center hover:bg-white/[0.05] disabled:opacity-30 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span
                className="px-1 tabular-nums"
                style={{ fontFamily: "var(--cf-title-font)" }}
              >
                {engine.activeIndex + 1} / {engine.totalItems}
              </span>
              <button
                type="button"
                onClick={engine.goNext}
                disabled={engine.isLastItem}
                aria-label="下一题"
                className="w-6 h-6 rounded flex items-center justify-center hover:bg-white/[0.05] disabled:opacity-30 cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 右上角极简风格热切换（无边框柔和底色，遵守单描边原则） */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCycleStyle(getNextStyle("claude_desktop"))}
            title="切换气泡风格（当前：Parchment）"
            aria-label="切换气泡风格"
            className="h-7 px-2 rounded-md flex items-center gap-1 text-[11px] transition-colors hover:bg-white/[0.06] cursor-pointer"
            style={{
              backgroundColor: "rgba(222,220,209,0.06)",
              color: "var(--cf-muted)",
            }}
          >
            <Palette className="w-3 h-3" />
            <span>Parchment</span>
          </button>

          <button
            type="button"
            onClick={engine.toggleMinimized}
            title="最小化（保留待确认状态）"
            aria-label="最小化确认卡片"
            className="w-7 h-7 rounded-md flex items-center justify-center transition-colors hover:bg-white/[0.06] cursor-pointer"
            style={{ color: "var(--cf-muted)" }}
          >
            <Minus className="w-4 h-4 stroke-[1.5]" />
          </button>
        </div>
      </div>

      {/* P2-4 Parchment 批量导航条（衬线计数徽标 + ‹ Prev / Next › + 代理来源，严格无多余描边） */}
      {isBatch && (
        <div
          data-testid="parchment-batch-nav"
          className="mt-3 flex items-center justify-between gap-2 px-3 py-1.5 rounded-[10px]"
          style={{ backgroundColor: "rgba(222,220,209,0.05)" }}
        >
          <div className="flex items-center gap-2 text-[12px]">
            <span
              className="px-2 py-0.5 rounded-md tabular-nums font-medium"
              style={{
                fontFamily: "var(--cf-title-font)",
                backgroundColor: "rgba(201,100,66,0.16)",
                color: "#ECEBE4",
              }}
            >
              {engine.activeIndex + 1} / {engine.batchItems.length}
            </span>
            {currentBatchSource && (
              <span className="text-[11.5px]" style={{ color: "var(--cf-muted)" }}>
                {currentBatchSource}
              </span>
            )}
            {currentBatchDecision && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor:
                    currentBatchDecision.decision === "approved"
                      ? "rgba(34,197,94,0.16)"
                      : "rgba(239,68,68,0.16)",
                  color:
                    currentBatchDecision.decision === "approved"
                      ? "#86EFAC"
                      : "#FCA5A5",
                }}
              >
                {currentBatchDecision.decision === "approved" ? "已批准" : "已拒绝"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[11.5px]" style={{ color: "var(--cf-muted)" }}>
            <button
              type="button"
              onClick={engine.goPrev}
              disabled={engine.isFirstItem}
              className="px-2 py-0.5 rounded hover:bg-white/[0.06] disabled:opacity-35 cursor-pointer"
            >
              ‹ Prev
            </button>
            <button
              type="button"
              onClick={engine.goNext}
              disabled={engine.isLastItem}
              className="px-2 py-0.5 rounded hover:bg-white/[0.06] disabled:opacity-35 cursor-pointer"
            >
              Next ›
            </button>
          </div>
        </div>
      )}

      {/* 2. 主体内容区 */}
      <div className="mt-3.5 space-y-3">
        {/* 2a. tool_approval：暖黑内凹代码 / Diff 块，文件名用 Newsreader 衬线小标题 */}
        {isToolApproval && currentItem.code_preview && (
          <div
            className="overflow-hidden rounded-[10px]"
            style={{ backgroundColor: "var(--cf-surface-2)" }}
          >
            <div
              className="flex items-center justify-between px-3.5 py-2 border-b"
              style={{ borderColor: "rgba(222,220,209,0.08)" }}
            >
              <span
                className="text-[13px] truncate"
                style={{
                  fontFamily: "var(--cf-title-font)",
                  color: "var(--cf-text)",
                }}
              >
                {currentItem.code_preview.filename ||
                  currentItem.tool_name ||
                  "终端命令"}
              </span>
              <div className="flex items-center gap-2 text-[11px] shrink-0">
                {currentItem.diff_stat && (
                  <span
                    className="font-mono tabular-nums"
                    style={{ color: "var(--cf-muted)" }}
                  >
                    {currentItem.diff_stat}
                  </span>
                )}
                {isHighRisk && (
                  <span style={{ color: "#D97757" }}>高危操作</span>
                )}
              </div>
            </div>
            <div
              className="px-3.5 py-2.5 max-h-56 overflow-auto text-[12px] leading-relaxed"
              style={{ fontFamily: "var(--cf-mono-font)" }}
            >
              {currentItem.code_preview.language === "diff" ? (
                <div className="space-y-0.5">
                  {parseUnifiedDiff(currentItem.code_preview.content).lines.map(
                    (ln, idx) => (
                      <div
                        key={idx}
                        className="px-2 py-0.5 rounded-[4px] whitespace-pre-wrap break-all"
                        style={{
                          backgroundColor:
                            ln.kind === "add"
                              ? "rgba(116,184,128,0.12)"
                              : ln.kind === "del"
                              ? "rgba(217,119,87,0.15)"
                              : "transparent",
                          color:
                            ln.kind === "add"
                              ? "#B7DFBF"
                              : ln.kind === "del"
                              ? "#EFA991"
                              : ln.kind === "hunk"
                              ? "#A19E95"
                              : "#ECEBE4",
                        }}
                      >
                        <span className="select-none mr-2 opacity-55">
                          {ln.prefix}
                        </span>
                        {ln.content}
                      </div>
                    )
                  )}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-all m-0 text-[#ECEBE4]">
                  {splitCodeLines(currentItem.code_preview.content)
                    .map((l) => l.content)
                    .join("\n")}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* 2b. clarification：细分隔线衬线编号列表（非独立卡片；选中态左侧陶土橙竖条 + 浅橙底） */}
        {(currentItem.selection_mode === "single" ||
          currentItem.selection_mode === "multi") &&
          currentItem.options && (
            <div
              data-testid="cf-options-container"
              className="transition-opacity duration-150"
              style={{
                opacity: engine.isOverrideActive ? 0.38 : 1,
              }}
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
                    className="cf-touch-target w-full px-3 py-2.5 flex items-start justify-between gap-3 text-left transition-colors cursor-pointer relative"
                    style={{
                      borderTop:
                        idx > 0
                          ? "1px solid rgba(222, 220, 209, 0.09)"
                          : undefined,
                      backgroundColor: isSelected
                        ? "var(--cf-selected)"
                        : isFocused
                        ? "var(--cf-hover)"
                        : "transparent",
                      borderLeft: isSelected
                        ? "2.5px solid var(--cf-accent)"
                        : isFocused
                        ? "2.5px solid rgba(201,100,66,0.45)"
                        : "2.5px solid transparent",
                    }}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      {isMulti ? (
                        <span
                          className="w-4 h-4 mt-0.5 rounded-[3px] flex items-center justify-center shrink-0"
                          style={{
                            border: isSelected
                              ? "1.5px solid var(--cf-accent)"
                              : "1px solid rgba(222,220,209,0.3)",
                            color: "var(--cf-accent)",
                          }}
                        >
                          {isSelected && <Check className="w-3 h-3 stroke-[2.5]" />}
                        </span>
                      ) : (
                        <span
                          className="text-[14px] w-5 shrink-0 leading-snug"
                          style={{
                            fontFamily: "var(--cf-title-font)",
                            color: isSelected
                              ? "var(--cf-accent)"
                              : "var(--cf-muted)",
                          }}
                        >
                          {idx + 1}.
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-baseline flex-wrap gap-2">
                          <span className="text-[13.5px] font-medium text-[#ECEBE4]">
                            {opt.label}
                          </span>
                          {opt.recommended && (
                            <span
                              className="text-[12px] italic"
                              style={{
                                fontFamily: "var(--cf-title-font)",
                                color: "var(--cf-muted)",
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
                  </button>
                );
              })}
            </div>
          )}

        {/* 2c. parameter_form：暖炭内凹表单控件 + 陶土橙聚焦边框 + 衬线字段标题 */}
        {currentItem.selection_mode === "form" && currentItem.form_fields && (
          <div className="space-y-3">
            {currentItem.form_fields.map((field) => {
              const fieldId = `field:${field.key}`;
              const val = currentAnswer?.form_values?.[field.key];
              const err = currentErrors[field.key];
              const focused = draft.focusedField === fieldId;
              return (
                <div key={field.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <label
                      className="text-[14px]"
                      style={{
                        fontFamily: "var(--cf-title-font)",
                        color: "var(--cf-text)",
                      }}
                    >
                      {field.label}
                      {field.required && (
                        <span className="ml-1" style={{ color: "var(--cf-accent)" }}>
                          *
                        </span>
                      )}
                    </label>
                    {field.description && (
                      <span className="text-[11px]" style={{ color: "var(--cf-muted)" }}>
                        {field.description}
                      </span>
                    )}
                  </div>
                  <div
                    className="rounded-[8px] px-3 py-2 transition-colors"
                    style={{
                      backgroundColor: "var(--cf-surface-2)",
                      border: err
                        ? "1px solid #E27A66"
                        : focused
                        ? "1px solid var(--cf-accent)"
                        : "1px solid transparent",
                    }}
                  >
                    {field.type === "boolean" ? (
                      <button
                        type="button"
                        data-cf-field={fieldId}
                        onFocus={() => engine.setFocusedField(fieldId)}
                        onBlur={() => engine.setFocusedField(null)}
                        onClick={() => engine.setFormValue(field.key, !Boolean(val))}
                        className="flex items-center gap-2 text-xs cursor-pointer"
                      >
                        <span
                          className="w-4 h-4 rounded-[3px] flex items-center justify-center"
                          style={{
                            border: Boolean(val)
                              ? "1.5px solid var(--cf-accent)"
                              : "1px solid rgba(222,220,209,0.28)",
                            color: "var(--cf-accent)",
                          }}
                        >
                          {Boolean(val) && <Check className="w-3 h-3 stroke-[2.5]" />}
                        </span>
                        <span>{Boolean(val) ? "是" : "否"}</span>
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
                            className="bg-[#1C1B19] text-[#ECEBE4]"
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
                        style={{ fontFamily: "var(--cf-mono-font)", color: "var(--cf-text)" }}
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
                        className="w-full bg-transparent text-[13px] outline-none placeholder:italic placeholder:text-[#7E7B73]"
                        style={{ color: "var(--cf-text)" }}
                      />
                    )}
                  </div>
                  {err && <div className="text-[11px] text-[#E27A66]">{err}</div>}
                </div>
              );
            })}
          </div>
        )}

        {/* 3. Parchment 无边框暖底铅笔自由输入行 */}
        {currentItem.selection_mode !== "form" &&
          currentItem.custom_input?.enabled !== false && (
            <div
              className="flex items-center gap-2.5 px-3 py-2 rounded-[10px] transition-colors"
              style={{
                backgroundColor: "var(--cf-surface-2)",
                border:
                  draft.focusedField === "writein"
                    ? "1px solid var(--cf-accent)"
                    : "1px solid rgba(222, 220, 209, 0.08)",
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
                    ? `拒绝并告知 ${agentName} 你的要求…`
                    : `或者告诉 ${agentName} 其他想法…`)
                }
                className="w-full bg-transparent text-[13px] outline-none placeholder:italic placeholder:text-[#88857C]"
                style={{ color: "var(--cf-text)" }}
              />
              {engine.isOverrideActive && (
                <span className="text-[11px] italic shrink-0" style={{ color: "#D97757" }}>
                  已覆盖上方预设
                </span>
              )}
              {!engine.isOverrideActive &&
                currentItem.selection_mode === "multi" &&
                engine.customText.trim().length > 0 && (
                  <span className="text-[11px] italic shrink-0" style={{ color: "#D97757" }}>
                    + 附加至已选 {engine.appendSelectedCount} 项
                  </span>
                )}
            </div>
          )}
      </div>

      {/* 4. Parchment 底部按钮栏（严格遵守单描边原则：次级按钮绝不加边框，仅柔和底色或纯文字） */}
      <div className="cf-footer-bar flex items-center justify-between gap-2.5 mt-4 pt-3 border-t border-[rgba(222,220,209,0.09)]">
        {isBatch ? (
          <>
            <button
              type="button"
              onClick={() => engine.decideBatchItem("rejected", "once", true)}
              disabled={engine.isSubmitting}
              className="cf-touch-target h-9 px-3 text-[12.5px] transition-colors rounded-[10px] hover:bg-white/[0.05] cursor-pointer"
              style={{ color: "var(--cf-muted)" }}
            >
              拒绝此项
            </button>

            <div className="flex items-center gap-2 flex-wrap">
              {engine.batchNonHighCount > 0 && (
                <button
                  type="button"
                  onClick={engine.approveAllBatchNonHigh}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-9 px-3.5 text-[12.5px] font-medium transition-colors hover:bg-[#34312C] cursor-pointer"
                  style={{
                    backgroundColor: "rgba(222,220,209,0.08)",
                    color: "var(--cf-text)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  {allowAllLabel}
                </button>
              )}

              {engine.batchAllResolved ? (
                <button
                  type="button"
                  onClick={engine.submitBatch}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-9 px-4 text-[12.5px] font-medium flex items-center gap-1.5 transition-colors hover:bg-[#D97757] disabled:opacity-50 cursor-pointer"
                  style={{
                    backgroundColor: "var(--cf-accent)",
                    color: "var(--cf-on-accent)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  <span>提交全部 ({engine.batchItems.length})</span>
                  <kbd className="cf-kbd text-[10.5px] font-mono opacity-80">⌘↵</kbd>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => engine.decideBatchItem("approved", "once", true)}
                  disabled={engine.isSubmitting}
                  className="cf-touch-target h-9 px-4 text-[12.5px] font-medium flex items-center gap-1.5 transition-colors hover:bg-[#D97757] disabled:opacity-50 cursor-pointer"
                  style={{
                    backgroundColor: "var(--cf-accent)",
                    color: "var(--cf-on-accent)",
                    borderRadius: "var(--cf-radius-btn)",
                  }}
                >
                  <span>{isHighRisk ? "允许此项 · 点击确认" : "允许本次并下一条"}</span>
                  <kbd className="cf-kbd text-[10.5px] font-mono opacity-80">
                    {isHighRisk ? "⌘↵" : "↵"}
                  </kbd>
                </button>
              )}
            </div>
          </>
        ) : isToolApproval ? (
          <>
            <button
              type="button"
              onClick={() =>
                isPlan
                  ? engine.requestPlanChanges(engine.customText)
                  : engine.denyAndRedirect(engine.customText)
              }
              disabled={engine.isSubmitting}
              className="cf-touch-target h-9 px-2.5 text-[12.5px] transition-colors rounded-[10px] hover:bg-white/[0.05] cursor-pointer"
              style={{ color: "var(--cf-muted)" }}
            >
              {isPlan
                ? engine.isOverrideActive
                  ? `把修改意见发给 ${agentName}`
                  : `提出修改意见…`
                : engine.isOverrideActive
                ? `拒绝并发送给 ${agentName}`
                : `拒绝并告知 ${agentName}…`}
            </button>

            <div className="flex items-center gap-2">
              {hasSessionScope && (
                <div className="relative inline-flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      setScopeMenuOpen(false);
                      engine.approveSession();
                    }}
                    disabled={engine.isSubmitting}
                    className={`cf-touch-target h-9 pl-3.5 ${canWorkspaceRule ? "pr-2 rounded-l-[10px]" : "pr-3.5 rounded-[10px]"} text-[12.5px] font-medium flex items-center gap-1.5 transition-colors hover:bg-[#34312C] cursor-pointer`}
                    style={{
                      backgroundColor: "rgba(222,220,209,0.08)",
                      color: "var(--cf-text)",
                    }}
                  >
                    <span>本会话始终允许</span>
                    <kbd className="cf-kbd text-[10.5px] font-mono" style={{ color: "var(--cf-muted)" }}>
                      ⇧⌘↵
                    </kbd>
                  </button>
                  {canWorkspaceRule && (
                    <button
                      type="button"
                      aria-label="更多允许范围"
                      onClick={() => setScopeMenuOpen((v) => !v)}
                      disabled={engine.isSubmitting}
                      className="cf-touch-target h-9 px-2 rounded-r-[10px] flex items-center justify-center transition-colors hover:bg-[#34312C] cursor-pointer"
                      style={{
                        backgroundColor: "rgba(222,220,209,0.06)",
                        color: "var(--cf-muted)",
                      }}
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {scopeMenuOpen && canWorkspaceRule && (
                    <div
                      className="absolute right-0 bottom-full mb-1.5 w-52 rounded-[12px] p-1 shadow-xl z-30"
                      style={{
                        backgroundColor: "#2C2A26",
                        border: "1px solid var(--cf-border)",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setScopeMenuOpen(false);
                          engine.approveSession();
                        }}
                        className="w-full text-left px-2.5 py-1.5 rounded-[8px] text-[12px] hover:bg-white/[0.06] flex items-center justify-between cursor-pointer"
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
                        className="w-full text-left px-2.5 py-1.5 rounded-[8px] text-[12px] hover:bg-white/[0.06] flex items-center justify-between cursor-pointer"
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
                className="cf-touch-target h-9 px-4 text-[12.5px] font-medium flex items-center gap-1.5 transition-colors hover:bg-[#D97757] disabled:opacity-50 cursor-pointer"
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
                <kbd className="cf-kbd text-[10.5px] font-mono opacity-80">
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
              className="cf-touch-target h-9 px-2.5 text-[12.5px] transition-colors rounded-[10px] hover:bg-white/[0.05] cursor-pointer"
              style={{ color: "var(--cf-muted)" }}
            >
              跳过
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  engine.isLastItem
                    ? engine.submitClarificationOrForm()
                    : engine.goNext()
                }
                disabled={engine.isSubmitting}
                className="cf-touch-target h-9 px-4 text-[12.5px] font-medium flex items-center gap-1.5 transition-colors hover:bg-[#D97757] disabled:opacity-50 cursor-pointer"
                style={{
                  backgroundColor: "var(--cf-accent)",
                  color: "var(--cf-on-accent)",
                  borderRadius: "var(--cf-radius-btn)",
                }}
              >
                <span>{engine.isLastItem ? "提交" : "继续"}</span>
                <kbd className="cf-kbd text-[10.5px] font-mono opacity-80">↵</kbd>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
