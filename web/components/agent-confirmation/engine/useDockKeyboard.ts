import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import type { RefObject } from "react";
import type { ConfirmationEngineAPI } from "./useConfirmationEngine";

export const MISCLICK_ARM_DELAY_MS = 400;

function isTextInputElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return target.isContentEditable;
}

export interface UseDockKeyboardOptions {
  engine: ConfirmationEngineAPI;
  dockRef: RefObject<HTMLDivElement | null>;
}

export interface DockKeyboardHandlers {
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

/**
 * focus-within 作用域键盘控制器：
 * - 严禁挂 window，绝不劫持 Monaco / xterm / 主输入框
 * - 完整 IME 守卫（含 Safari compositionend 后紧跟 Enter 的 60ms 保护窗）
 * - 400ms 防连按穿透武装期（忽略 Enter 与数字键）
 * - high 风险不绑定普通 Enter，仅 ⌘↵ / Ctrl↵ 或鼠标点击生效
 * - 输入态两段 Esc（先 blur 回导航态，再按关闭）
 */
export function useDockKeyboard({
  engine,
  dockRef,
}: UseDockKeyboardOptions): DockKeyboardHandlers {
  const armedAtRef = useRef<number>(performance.now());
  const isComposingRef = useRef<boolean>(false);
  const compTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestId = engine.entry?.request.request_id;
  const activeIndex = engine.activeIndex;
  useEffect(() => {
    armedAtRef.current = performance.now();
  }, [requestId, activeIndex]);

  useEffect(() => {
    return () => {
      if (compTimerRef.current) clearTimeout(compTimerRef.current);
    };
  }, []);

  const onCompositionStart = useCallback(() => {
    if (compTimerRef.current) {
      clearTimeout(compTimerRef.current);
      compTimerRef.current = null;
    }
    isComposingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    if (compTimerRef.current) clearTimeout(compTimerRef.current);
    compTimerRef.current = setTimeout(() => {
      isComposingRef.current = false;
      compTimerRef.current = null;
    }, 60);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!engine.entry || !engine.currentItem || engine.isMinimized) return;

      // 1. IME 完整守卫
      if (
        e.nativeEvent.isComposing ||
        e.keyCode === 229 ||
        isComposingRef.current
      ) {
        return;
      }

      const inInput = isTextInputElement(e.target);

      // 2. Esc 两段式退出：输入态先 blur 回导航态，导航态再按才 dismiss
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (inInput && e.target instanceof HTMLElement) {
          e.target.blur();
          engine.setFocusedField(null);
          dockRef.current?.focus();
          return;
        }
        if (engine.entry.request.dismissible) {
          engine.dismiss();
        }
        return;
      }

      const item = engine.currentItem;
      const kind = engine.entry.request.kind;

      const isMaterialRejectionSelected = () => {
        if (engine.effectiveStyle !== "google_aistudio") return false;
        const hasSessionOption = Boolean(item.scope_signature);
        const rejectIdx = hasSessionOption ? 2 : 1;
        return engine.approvalSelectionIndex >= rejectIdx;
      };

      const executeToolApprovalConfirm = () => {
        if (kind === "plan_approval") {
          const reviseSelected =
            engine.effectiveStyle === "google_aistudio" &&
            engine.approvalSelectionIndex >= 1;
          if (engine.isOverrideActive || reviseSelected) {
            engine.requestPlanChanges(engine.customText);
          } else {
            engine.approvePlan();
          }
          return;
        }
        if (engine.isOverrideActive) {
          engine.denyAndRedirect(engine.customText);
          return;
        }
        if (engine.effectiveStyle === "google_aistudio") {
          const hasSessionOption = Boolean(item.scope_signature);
          if (engine.approvalSelectionIndex === 0) {
            engine.approveOnce();
          } else if (hasSessionOption && engine.approvalSelectionIndex === 1) {
            engine.approveSession();
          } else {
            engine.rejectTool();
          }
          return;
        }
        // 默认永远只触发 Allow once，绝不触发 Always allow
        engine.approveOnce();
      };

      // 输入态下：不处理导航键与数字键（仅允许 ⌘↵ / Ctrl↵ 快速提交）
      if (inInput) {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "Enter") {
          if (engine.isReadOnlyResolved || engine.isSubmitting) return;
          e.preventDefault();
          e.stopPropagation();
          if (kind === "tool_approval" || kind === "plan_approval") {
            executeToolApprovalConfirm();
          } else {
            engine.confirmFocusedOrAdvance();
          }
        }
        return;
      }

      if (engine.isReadOnlyResolved || engine.isSubmitting) return;

      const armed = performance.now() - armedAtRef.current > MISCLICK_ARM_DELAY_MS;

      // 2.5 P2-4 批量审批 / 聚合视图键盘映射
      if (engine.isBatchMode) {
        if (e.key === "ArrowLeft" && !engine.isFirstItem) {
          e.preventDefault();
          engine.goPrev();
          return;
        }
        if (e.key === "ArrowRight" && !engine.isLastItem) {
          e.preventDefault();
          engine.goNext();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
          if (item.scope_signature) {
            e.preventDefault();
            e.stopPropagation();
            engine.decideBatchItem("approved", "session", true);
          }
          return;
        }
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if (engine.batchAllResolved) {
            engine.submitBatch();
          } else {
            engine.decideBatchItem("approved", "once", true);
          }
          return;
        }
        if (e.key === "d" || e.key === "D") {
          e.preventDefault();
          e.stopPropagation();
          if (!armed) return;
          engine.decideBatchItem("rejected", "once", true);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if (!armed) return;
          if (item.risk_level === "high") return;
          if (engine.batchAllResolved) {
            engine.submitBatch();
          } else {
            engine.decideBatchItem("approved", "once", true);
          }
          return;
        }
        return;
      }

      // 3. tool_approval 键盘映射
      if (kind === "tool_approval" || kind === "plan_approval") {
        // ⇧⌘↵ / ⇧Ctrl↵：本会话始终允许（仅当 scope_signature != null 时允许）
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
          if (item.scope_signature) {
            e.preventDefault();
            e.stopPropagation();
            engine.approveSession();
          }
          return;
        }

        // ⌘↵ / Ctrl↵：确认当前选中动作（高危操作允许显式组合键确认；Material 严格尊重当前单选审批项）
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          executeToolApprovalConfirm();
          return;
        }

        // Material 单选审批项 1/2/3 与 ↑↓ 导航
        if (engine.effectiveStyle === "google_aistudio") {
          const hasSessionOption = Boolean(item.scope_signature);
          const totalChoices = hasSessionOption ? 3 : 2;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            engine.setApprovalSelectionIndex(
              (engine.approvalSelectionIndex + 1) % totalChoices
            );
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            engine.setApprovalSelectionIndex(
              (engine.approvalSelectionIndex - 1 + totalChoices) % totalChoices
            );
            return;
          }
          if (/^[1-3]$/.test(e.key)) {
            if (!armed) return;
            const num = parseInt(e.key, 10) - 1;
            if (num < totalChoices) {
              e.preventDefault();
              engine.setApprovalSelectionIndex(num);
            }
            return;
          }
        }

        // 普通 Enter：400ms 防误触 + 高危批准禁止单纯 Enter（拒绝/覆盖纠偏动作放行）
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if (!armed) return;
          const isDenialAction =
            engine.isOverrideActive || isMaterialRejectionSelected();
          if (item.risk_level === "high" && !isDenialAction) return;

          executeToolApprovalConfirm();
          return;
        }
        return;
      }

      // 4. clarification / parameter_form 导航态键盘映射
      const options = item.options || [];

      if (e.key === "ArrowLeft" && !engine.isFirstItem) {
        e.preventDefault();
        engine.goPrev();
        return;
      }
      if (e.key === "ArrowRight" && !engine.isLastItem) {
        e.preventDefault();
        engine.goNext();
        return;
      }

      if (options.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          engine.setFocusedOptionIndex(
            (engine.entry.draft.focusedOptionIndex + 1) % options.length
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          engine.setFocusedOptionIndex(
            (engine.entry.draft.focusedOptionIndex - 1 + options.length) %
              options.length
          );
          return;
        }
        if (/^[1-9]$/.test(e.key)) {
          if (!armed) return;
          const idx = parseInt(e.key, 10) - 1;
          if (idx < options.length) {
            e.preventDefault();
            engine.setFocusedOptionIndex(idx);
            const chosen = options[idx];
            if (item.selection_mode === "multi") {
              engine.toggleMultiOption(chosen.id);
            } else {
              engine.selectSingleOption(chosen.id);
            }
          }
          return;
        }
        if (e.key === " ") {
          e.preventDefault();
          const focused =
            options[engine.entry.draft.focusedOptionIndex] || options[0];
          if (focused) {
            if (item.selection_mode === "multi") {
              engine.toggleMultiOption(focused.id);
            } else {
              engine.selectSingleOption(focused.id);
            }
          }
          return;
        }
      }

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (!armed) return;
        engine.confirmFocusedOrAdvance();
      }
    },
    [engine, dockRef]
  );

  return {
    onKeyDown,
    onCompositionStart,
    onCompositionEnd,
  };
}
