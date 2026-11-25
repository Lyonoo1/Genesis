import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type {
  BatchItemDecision,
  ConcreteConfirmStyle,
  ConfirmationItem,
  ConfirmationQueueEntry,
  ConfirmationResponsePayload,
  ConfirmStyle,
  DraftItemAnswer,
  DraftState,
  ItemAnswer,
  PermissionMode,
  PermissionScope,
} from "../types/protocol";
import {
  formatDraftAsMessage,
  resolveEffectiveStyle,
  useConfirmationStore,
} from "../store/useConfirmationStore";
import { validateFormFields, validateSingleField } from "./formValidator";

export const SINGLE_AUTO_ADVANCE_MS = 220;
export const COUNTDOWN_VISIBLE_THRESHOLD_S = 15;

export interface UseConfirmationEngineOptions {
  sessionId: string | null | undefined;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  onFillComposerText?: (text: string) => void;
  onSendRedirectMessage?: (text: string) => void;
}

export interface ConfirmationEngineAPI {
  entry: ConfirmationQueueEntry | null;
  queueLength: number;
  effectiveStyle: ConcreteConfirmStyle;
  stylePreference: ConfirmStyle;
  permissionMode: PermissionMode;
  currentItem: ConfirmationItem | null;
  currentAnswer: DraftItemAnswer | null;
  currentErrors: Record<string, string>;
  activeIndex: number;
  totalItems: number;
  isFirstItem: boolean;
  isLastItem: boolean;
  isReadOnlyResolved: boolean;
  isSubmitting: boolean;
  isMinimized: boolean;
  countdownSeconds: number | null;
  timeoutDraftText: string;

  /** Material 风格的 tool_approval 单选映射选中态（0=允许本次, 1=本会话始终允许, 2=拒绝） */
  approvalSelectionIndex: number;
  setApprovalSelectionIndex: (idx: number) => void;

  /** Write-In 语义派生 */
  customText: string;
  isOverrideActive: boolean;
  appendSelectedCount: number;

  /** P2-4 批量审批（原生 batch_approval 或并发 tool_approval 前端聚合视图） */
  isBatchMode: boolean;
  isAggregatedBatch: boolean;
  batchItems: ConfirmationItem[];
  batchItemKeys: string[];
  batchItemSources: string[];
  batchDecisions: Record<string, BatchItemDecision>;
  batchResolvedCount: number;
  batchAllResolved: boolean;
  batchHighRiskCount: number;
  batchNonHighCount: number;

  /** 动作 */
  setStyle: (style: ConfirmStyle) => void;
  selectSingleOption: (optionId: string) => void;
  toggleMultiOption: (optionId: string) => void;
  setCustomText: (text: string) => void;
  setFormValue: (fieldKey: string, value: unknown) => void;
  setFocusedOptionIndex: (idx: number) => void;
  setFocusedField: (fieldId: string | null) => void;
  toggleCodeExpanded: () => void;
  toggleMinimized: () => void;
  setMinimized: (minimized: boolean) => void;
  goPrev: () => void;
  goNext: () => void;
  goTo: (index: number) => void;
  skipCurrent: () => void;
  confirmFocusedOrAdvance: () => void;
  submitClarificationOrForm: () => void;
  approveOnce: () => void;
  approveSession: () => void;
  approveWorkspaceRule: () => void;
  rejectTool: () => void;
  approvePlan: () => void;
  requestPlanChanges: (feedback?: string) => void;
  decideBatchItem: (
    decision: "approved" | "rejected",
    scope?: PermissionScope,
    autoNext?: boolean
  ) => void;
  approveAllBatchNonHigh: () => void;
  submitBatch: () => void;
  denyAndRedirect: (inlineReason?: string) => void;
  dismiss: () => void;
  sendTimeoutDraftAsMessage: () => void;
}

function getItemDraftAnswer(
  draft: DraftState,
  item: ConfirmationItem
): DraftItemAnswer {
  const existing = draft.answers[item.item_id];
  if (existing) return existing;
  return {
    status: "answered",
    selected_ids: [],
    custom_text: "",
    custom_mode:
      item.custom_input?.mode ||
      (item.selection_mode === "multi" ? "append" : "override"),
    form_values: {},
    touched: false,
  };
}

const EMPTY_QUEUE: ConfirmationQueueEntry[] = [];

export function useConfirmationEngine({
  sessionId,
  composerRef,
  onFillComposerText,
  onSendRedirectMessage,
}: UseConfirmationEngineOptions): ConfirmationEngineAPI {
  const stylePreference = useConfirmationStore((s) => s.style);
  const permissionMode = useConfirmationStore((s) => s.permissionMode);
  const hydratePreferences = useConfirmationStore((s) => s.hydratePreferences);
  const hydrated = useConfirmationStore((s) => s.hydrated);
  const setStyleStore = useConfirmationStore((s) => s.setStyle);
  const updateDraft = useConfirmationStore((s) => s.updateDraft);
  const submit = useConfirmationStore((s) => s.submit);
  const submitAggregatedBatch = useConfirmationStore(
    (s) => s.submitAggregatedBatch
  );
  const removeEntry = useConfirmationStore((s) => s.removeEntry);
  const setRedirectBanner = useConfirmationStore((s) => s.setRedirectBanner);

  const queue = useConfirmationStore((s) =>
    sessionId ? s.bySession[String(sessionId)] ?? EMPTY_QUEUE : EMPTY_QUEUE
  );
  const entry = queue.length > 0 ? queue[0] : null;
  const request = entry?.request ?? null;
  const draft = entry?.draft ?? null;

  useEffect(() => {
    if (!hydrated) {
      hydratePreferences();
    }
  }, [hydrated, hydratePreferences]);

  const effectiveStyle = useMemo(
    () => resolveEffectiveStyle(stylePreference, request?.ui_hint),
    [stylePreference, request?.ui_hint]
  );

  // 单选 220ms 自动推进定时器（统一受控，防止任何竞态翻页）
  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimerRef.current !== null) {
      clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  }, []);

  // 切风格、切换请求或卸载时立刻清理定时器
  useEffect(() => {
    clearAutoAdvance();
    return clearAutoAdvance;
  }, [effectiveStyle, request?.request_id, clearAutoAdvance]);

  // 倒计时状态（最后 15s 才展示；刷新恢复后优先按服务端 expires_at + 时钟偏移计算）
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const serverClockOffsetMs = useConfirmationStore((s) => s.serverClockOffsetMs);
  const entryStatus = entry?.status ?? null;
  const entryTimeoutMs = entry?.request.timeout_ms ?? 0;
  const entryExpiresAt = entry?.request.expires_at ?? null;
  const entryReceivedAt = entry?.receivedAt ?? 0;
  const entryRequestId = entry?.request.request_id ?? null;

  useEffect(() => {
    const parsedExpiresAt = entryExpiresAt ? Date.parse(entryExpiresAt) : NaN;
    const hasServerDeadline = Number.isFinite(parsedExpiresAt);
    if (
      !entryRequestId ||
      entryStatus !== "AWAITING" ||
      (!hasServerDeadline && entryTimeoutMs <= 0)
    ) {
      setCountdownSeconds(null);
      return;
    }
    const deadline = hasServerDeadline
      ? parsedExpiresAt - serverClockOffsetMs
      : entryReceivedAt + entryTimeoutMs;
    const tick = () => {
      const remainMs = deadline - Date.now();
      const remainSec = Math.ceil(remainMs / 1000);
      if (remainSec > 0 && remainSec <= COUNTDOWN_VISIBLE_THRESHOLD_S) {
        setCountdownSeconds(remainSec);
      } else {
        setCountdownSeconds(null);
      }
    };
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [
    entryRequestId,
    entryStatus,
    entryTimeoutMs,
    entryExpiresAt,
    entryReceivedAt,
    serverClockOffsetMs,
  ]);

  // P2-4 并发聚合视图：队头为 tool_approval 且队列中存在 >= 2 个待审 tool_approval 时自动聚合
  const aggregatedEntries = useMemo(() => {
    if (request?.kind !== "tool_approval" || entry?.status !== "AWAITING") {
      return [] as ConfirmationQueueEntry[];
    }
    const awaitingTools = queue.filter(
      (e) => e.request.kind === "tool_approval" && e.status === "AWAITING"
    );
    return awaitingTools.length >= 2 ? awaitingTools : [];
  }, [queue, request?.kind, entry?.status]);

  const isAggregatedBatch = aggregatedEntries.length >= 2;
  const isNativeBatch = request?.kind === "batch_approval";
  const isBatchMode = isNativeBatch || isAggregatedBatch;

  const { batchItems, batchItemKeys, batchItemSources } = useMemo(() => {
    if (isAggregatedBatch) {
      const items: ConfirmationItem[] = [];
      const keys: string[] = [];
      const sources: string[] = [];
      for (const ag of aggregatedEntries) {
        const it = ag.request.items[0];
        if (!it) continue;
        items.push(it);
        keys.push(ag.request.request_id);
        const aid = ag.request.agent_id;
        sources.push(aid ? `子代理 · ${String(aid).slice(-8)}` : "主代理");
      }
      return { batchItems: items, batchItemKeys: keys, batchItemSources: sources };
    }
    if (isNativeBatch && request) {
      const items = request.items || [];
      const keys = items.map((it) => it.item_id);
      const aid = request.agent_id;
      const src = aid ? `子代理 · ${String(aid).slice(-8)}` : "主代理";
      const sources = items.map(() => src);
      return { batchItems: items, batchItemKeys: keys, batchItemSources: sources };
    }
    return {
      batchItems: [] as ConfirmationItem[],
      batchItemKeys: [] as string[],
      batchItemSources: [] as string[],
    };
  }, [isAggregatedBatch, isNativeBatch, aggregatedEntries, request]);

  const batchDecisions = useMemo(
    () => draft?.batchDecisions ?? {},
    [draft?.batchDecisions]
  );

  const batchResolvedCount = useMemo(() => {
    if (!isBatchMode) return 0;
    return batchItemKeys.filter((k) => Boolean(batchDecisions[k])).length;
  }, [isBatchMode, batchItemKeys, batchDecisions]);

  const batchAllResolved =
    isBatchMode &&
    batchItemKeys.length > 0 &&
    batchResolvedCount >= batchItemKeys.length;

  const batchHighRiskCount = useMemo(() => {
    if (!isBatchMode) return 0;
    return batchItems.filter((it) => it.risk_level === "high").length;
  }, [isBatchMode, batchItems]);

  const batchNonHighCount = useMemo(() => {
    if (!isBatchMode) return 0;
    return batchItems.length - batchHighRiskCount;
  }, [isBatchMode, batchItems.length, batchHighRiskCount]);

  const totalItems = isBatchMode
    ? batchItems.length
    : request?.items?.length || 0;
  const activeIndex = draft
    ? Math.max(0, Math.min(draft.activeIndex, Math.max(0, totalItems - 1)))
    : 0;
  const currentItem = isBatchMode
    ? batchItems[activeIndex] || null
    : request && totalItems > 0
      ? request.items[activeIndex] || null
      : null;
  const currentAnswer =
    draft && currentItem ? getItemDraftAnswer(draft, currentItem) : null;
  const currentErrors =
    draft && currentItem ? draft.formErrors[currentItem.item_id] || {} : {};

  const isFirstItem = activeIndex <= 0;
  const isLastItem = activeIndex >= Math.max(0, totalItems - 1);
  const isReadOnlyResolved = entry?.status === "RESOLVED";
  const isSubmitting = entry?.status === "SUBMITTING";

  const customText = currentAnswer?.custom_text || "";
  const customMode =
    currentItem?.custom_input?.mode ||
    (currentItem?.selection_mode === "multi" ? "append" : "override");
  const isOverrideActive =
    customMode === "override" && customText.trim().length > 0;
  const appendSelectedCount =
    customMode === "append" ? currentAnswer?.selected_ids?.length || 0 : 0;

  const timeoutDraftText = useMemo(() => {
    if (
      !entry ||
      entry.status !== "RESOLVED" ||
      entry.resolvedDecision !== "timeout" ||
      entry.request.kind === "tool_approval"
    ) {
      return "";
    }
    return formatDraftAsMessage(entry.request, entry.draft);
  }, [entry]);

  // Material 风格的 tool_approval 单选映射：使用 draft.focusedOptionIndex 存储，热切换保留
  const approvalSelectionIndex = draft?.focusedOptionIndex ?? 0;
  const setApprovalSelectionIndex = useCallback(
    (idx: number) => {
      if (!sessionId || !request) return;
      updateDraft(sessionId, request.request_id, { focusedOptionIndex: idx });
    },
    [sessionId, request, updateDraft]
  );

  const setStyle = useCallback(
    (next: ConfirmStyle) => {
      clearAutoAdvance();
      setStyleStore(next);
    },
    [clearAutoAdvance, setStyleStore]
  );

  const setFocusedOptionIndex = useCallback(
    (idx: number) => {
      if (!sessionId || !request) return;
      updateDraft(sessionId, request.request_id, { focusedOptionIndex: idx });
    },
    [sessionId, request, updateDraft]
  );

  const setFocusedField = useCallback(
    (fieldId: string | null) => {
      if (!sessionId || !request) return;
      updateDraft(sessionId, request.request_id, { focusedField: fieldId });
    },
    [sessionId, request, updateDraft]
  );

  const toggleCodeExpanded = useCallback(() => {
    if (!sessionId || !request || !draft) return;
    updateDraft(sessionId, request.request_id, {
      codeExpanded: !draft.codeExpanded,
    });
  }, [sessionId, request, draft, updateDraft]);

  const setMinimized = useCallback(
    (minimized: boolean) => {
      if (!sessionId || !request) return;
      if (minimized) {
        clearAutoAdvance();
      }
      updateDraft(sessionId, request.request_id, { minimized });
    },
    [sessionId, request, clearAutoAdvance, updateDraft]
  );

  const toggleMinimized = useCallback(() => {
    if (!sessionId || !request || !draft) return;
    const next = !Boolean(draft.minimized);
    if (next) {
      clearAutoAdvance();
    }
    updateDraft(sessionId, request.request_id, { minimized: next });
  }, [sessionId, request, draft, clearAutoAdvance, updateDraft]);

  const goTo = useCallback(
    (index: number) => {
      clearAutoAdvance();
      if (!sessionId || !request) return;
      const clamped = Math.max(0, Math.min(index, Math.max(0, totalItems - 1)));
      updateDraft(sessionId, request.request_id, {
        activeIndex: clamped,
        focusedOptionIndex: 0,
        focusedField: null,
      });
    },
    [clearAutoAdvance, sessionId, request, totalItems, updateDraft]
  );

  const goPrev = useCallback(() => {
    goTo(activeIndex - 1);
  }, [goTo, activeIndex]);

  const validateCurrentForm = useCallback((): boolean => {
    if (!sessionId || !request || !draft || !currentItem) return true;
    if (currentItem.selection_mode !== "form") return true;
    const fields = currentItem.form_fields || [];
    const ans = getItemDraftAnswer(draft, currentItem);
    const errs = validateFormFields(fields, ans.form_values || {});
    updateDraft(sessionId, request.request_id, (prev) => ({
      ...prev,
      formErrors: {
        ...prev.formErrors,
        [currentItem.item_id]: errs,
      },
    }));
    return Object.keys(errs).length === 0;
  }, [sessionId, request, draft, currentItem, updateDraft]);

  const goNext = useCallback(() => {
    clearAutoAdvance();
    if (!validateCurrentForm()) return;
    goTo(activeIndex + 1);
  }, [clearAutoAdvance, validateCurrentForm, goTo, activeIndex]);

  const selectSingleOption = useCallback(
    (optionId: string) => {
      clearAutoAdvance();
      if (!sessionId || !request || !currentItem || isReadOnlyResolved || isSubmitting) {
        return;
      }
      const reqId = request.request_id;
      const itemId = currentItem.item_id;
      const currentIdx = activeIndex;

      updateDraft(sessionId, reqId, (prev) => {
        const prevAns = getItemDraftAnswer(prev, currentItem);
        return {
          ...prev,
          answers: {
            ...prev.answers,
            [itemId]: {
              ...prevAns,
              status: "answered",
              selected_ids: [optionId],
              custom_text: "", // 点击预设清空 override 文本
              custom_mode: "override",
              touched: true,
            },
          },
        };
      });

      const shouldAutoAdvance =
        currentItem.selection_mode === "single" &&
        currentItem.auto_advance !== false &&
        currentIdx < totalItems - 1;

      if (shouldAutoAdvance) {
        const startedStyle = effectiveStyle;
        autoAdvanceTimerRef.current = setTimeout(() => {
          autoAdvanceTimerRef.current = null;
          const latestState = useConfirmationStore.getState();
          const latestQueue = latestState.bySession[String(sessionId)] || [];
          const latestEntry = latestQueue[0];
          if (
            latestEntry &&
            latestEntry.request.request_id === reqId &&
            latestEntry.status === "AWAITING" &&
            latestEntry.draft.activeIndex === currentIdx &&
            resolveEffectiveStyle(
              latestState.style,
              latestEntry.request.ui_hint
            ) === startedStyle
          ) {
            latestState.updateDraft(sessionId, reqId, {
              activeIndex: currentIdx + 1,
              focusedOptionIndex: 0,
              focusedField: null,
            });
          }
        }, SINGLE_AUTO_ADVANCE_MS);
      }
    },
    [
      clearAutoAdvance,
      sessionId,
      request,
      currentItem,
      isReadOnlyResolved,
      isSubmitting,
      activeIndex,
      totalItems,
      updateDraft,
      effectiveStyle,
    ]
  );

  const toggleMultiOption = useCallback(
    (optionId: string) => {
      clearAutoAdvance();
      if (!sessionId || !request || !currentItem || isReadOnlyResolved || isSubmitting) {
        return;
      }
      const itemId = currentItem.item_id;
      updateDraft(sessionId, request.request_id, (prev) => {
        const prevAns = getItemDraftAnswer(prev, currentItem);
        const exists = prevAns.selected_ids.includes(optionId);
        const nextIds = exists
          ? prevAns.selected_ids.filter((id) => id !== optionId)
          : [...prevAns.selected_ids, optionId];
        return {
          ...prev,
          answers: {
            ...prev.answers,
            [itemId]: {
              ...prevAns,
              status: "answered",
              selected_ids: nextIds,
              custom_mode: "append",
              touched: true,
            },
          },
        };
      });
    },
    [clearAutoAdvance, sessionId, request, currentItem, isReadOnlyResolved, isSubmitting, updateDraft]
  );

  const setCustomText = useCallback(
    (text: string) => {
      clearAutoAdvance();
      if (!sessionId || !request || !currentItem || isReadOnlyResolved || isSubmitting) {
        return;
      }
      const itemId = currentItem.item_id;
      const mode =
        currentItem.custom_input?.mode ||
        (currentItem.selection_mode === "multi" ? "append" : "override");

      updateDraft(sessionId, request.request_id, (prev) => {
        const prevAns = getItemDraftAnswer(prev, currentItem);
        return {
          ...prev,
          answers: {
            ...prev.answers,
            [itemId]: {
              ...prevAns,
              status: "answered",
              custom_text: text,
              custom_mode: mode,
              touched: prevAns.touched || text.trim().length > 0,
            },
          },
        };
      });
    },
    [clearAutoAdvance, sessionId, request, currentItem, isReadOnlyResolved, isSubmitting, updateDraft]
  );

  const setFormValue = useCallback(
    (fieldKey: string, value: unknown) => {
      clearAutoAdvance();
      if (!sessionId || !request || !currentItem || isReadOnlyResolved || isSubmitting) {
        return;
      }
      const itemId = currentItem.item_id;
      const fieldSchema = (currentItem.form_fields || []).find((f) => f.key === fieldKey);
      const fieldErr = fieldSchema ? validateSingleField(fieldSchema, value) : null;

      updateDraft(sessionId, request.request_id, (prev) => {
        const prevAns = getItemDraftAnswer(prev, currentItem);
        const prevItemErrs = { ...(prev.formErrors[itemId] || {}) };
        if (fieldErr) {
          prevItemErrs[fieldKey] = fieldErr;
        } else {
          delete prevItemErrs[fieldKey];
        }
        return {
          ...prev,
          answers: {
            ...prev.answers,
            [itemId]: {
              ...prevAns,
              status: "answered",
              form_values: {
                ...(prevAns.form_values || {}),
                [fieldKey]: value,
              },
              touched: true,
            },
          },
          formErrors: {
            ...prev.formErrors,
            [itemId]: prevItemErrs,
          },
        };
      });
    },
    [clearAutoAdvance, sessionId, request, currentItem, isReadOnlyResolved, isSubmitting, updateDraft]
  );

  const buildSerializedAnswers = useCallback(
    (
      overrideDraft: DraftState
    ): { answers: Record<string, ItemAnswer>; allSkipped: boolean } => {
      const answers: Record<string, ItemAnswer> = {};
      let allSkipped = true;

      for (const item of request?.items || []) {
        const rawAns = getItemDraftAnswer(overrideDraft, item);
        if (rawAns.status === "skipped") {
          answers[item.item_id] = {
            status: "skipped",
            selected_ids: [],
          };
          continue;
        }

        if (item.selection_mode === "form") {
          const parsedForm: Record<string, unknown> = {};
          for (const field of item.form_fields || []) {
            const val = rawAns.form_values?.[field.key];
            if (field.type === "json" && typeof val === "string" && val.trim()) {
              try {
                parsedForm[field.key] = JSON.parse(val);
              } catch {
                parsedForm[field.key] = val;
              }
            } else if (field.type === "number" && val !== "" && val !== undefined) {
              parsedForm[field.key] = Number(val);
            } else {
              parsedForm[field.key] = val;
            }
          }
          answers[item.item_id] = {
            status: "answered",
            selected_ids: [],
            form_values: parsedForm,
          };
          allSkipped = false;
          continue;
        }

        const trimmedCustom = (rawAns.custom_text || "").trim();
        const mode =
          item.custom_input?.mode ||
          (item.selection_mode === "multi" ? "append" : "override");

        if (mode === "override" && trimmedCustom) {
          answers[item.item_id] = {
            status: "answered",
            selected_ids: [],
            custom_text: trimmedCustom,
            custom_mode: "override",
          };
          allSkipped = false;
        } else {
          const hasSelection = rawAns.selected_ids.length > 0;
          if (!hasSelection && !trimmedCustom) {
            answers[item.item_id] = {
              status: "skipped",
              selected_ids: [],
            };
          } else {
            answers[item.item_id] = {
              status: "answered",
              selected_ids: [...rawAns.selected_ids],
              ...(trimmedCustom ? { custom_text: trimmedCustom, custom_mode: mode } : {}),
            };
            allSkipped = false;
          }
        }
      }

      return { answers, allSkipped };
    },
    [request]
  );

  const submitClarificationOrForm = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || !draft || isReadOnlyResolved || isSubmitting) {
      return;
    }
    if (request.kind === "tool_approval" || request.kind === "plan_approval" || request.kind === "batch_approval") return;

    // 校验所有未跳过的表单题
    let firstInvalidIndex = -1;
    const nextFormErrors: Record<string, Record<string, string>> = {
      ...draft.formErrors,
    };

    request.items.forEach((item, idx) => {
      if (item.selection_mode !== "form") return;
      const ans = getItemDraftAnswer(draft, item);
      if (ans.status === "skipped") return;
      const errs = validateFormFields(item.form_fields || [], ans.form_values || {});
      nextFormErrors[item.item_id] = errs;
      if (Object.keys(errs).length > 0 && firstInvalidIndex === -1) {
        firstInvalidIndex = idx;
      }
    });

    if (firstInvalidIndex !== -1) {
      updateDraft(sessionId, request.request_id, {
        activeIndex: firstInvalidIndex,
        formErrors: nextFormErrors,
      });
      return;
    }

    const { answers, allSkipped } = buildSerializedAnswers(draft);
    const payload: ConfirmationResponsePayload = {
      request_id: request.request_id,
      kind: request.kind,
      decision: allSkipped ? "skipped_all" : "submitted",
      answers,
      active_style: effectiveStyle,
    };
    void submit(sessionId, payload);
  }, [
    clearAutoAdvance,
    sessionId,
    request,
    draft,
    isReadOnlyResolved,
    isSubmitting,
    updateDraft,
    buildSerializedAnswers,
    effectiveStyle,
    submit,
  ]);

  const confirmFocusedOrAdvance = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || !draft || !currentItem || isReadOnlyResolved || isSubmitting) {
      return;
    }
    if (request.kind === "tool_approval" || request.kind === "plan_approval" || request.kind === "batch_approval") return;

    // 单选题若尚未作答且无自定义文本，按 Enter 直接采纳当前聚焦项（默认即第 1 项 recommended）
    if (
      currentItem.selection_mode === "single" &&
      currentItem.options &&
      currentItem.options.length > 0
    ) {
      const ans = getItemDraftAnswer(draft, currentItem);
      const hasCustom = (ans.custom_text || "").trim().length > 0;
      const hasSelected = ans.selected_ids.length > 0;
      if (!hasSelected && !hasCustom) {
        const focusedOpt =
          currentItem.options[draft.focusedOptionIndex] || currentItem.options[0];
        if (focusedOpt) {
          const updatedDraft: DraftState = {
            ...draft,
            answers: {
              ...draft.answers,
              [currentItem.item_id]: {
                ...ans,
                status: "answered",
                selected_ids: [focusedOpt.id],
                custom_text: "",
                custom_mode: "override",
                touched: true,
              },
            },
          };

          if (!isLastItem) {
            updateDraft(sessionId, request.request_id, {
              ...updatedDraft,
              activeIndex: activeIndex + 1,
              focusedOptionIndex: 0,
              focusedField: null,
            });
            return;
          }

          // 末题：校验所有表单题后直接携带采纳的聚焦项打包提交
          let firstInvalidIndex = -1;
          const nextFormErrors: Record<string, Record<string, string>> = {
            ...updatedDraft.formErrors,
          };
          request.items.forEach((item, idx) => {
            if (item.selection_mode !== "form") return;
            const itemAns = getItemDraftAnswer(updatedDraft, item);
            if (itemAns.status === "skipped") return;
            const errs = validateFormFields(
              item.form_fields || [],
              itemAns.form_values || {}
            );
            nextFormErrors[item.item_id] = errs;
            if (Object.keys(errs).length > 0 && firstInvalidIndex === -1) {
              firstInvalidIndex = idx;
            }
          });
          if (firstInvalidIndex !== -1) {
            updateDraft(sessionId, request.request_id, {
              ...updatedDraft,
              activeIndex: firstInvalidIndex,
              formErrors: nextFormErrors,
            });
            return;
          }

          updateDraft(sessionId, request.request_id, updatedDraft);
          const { answers, allSkipped } = buildSerializedAnswers(updatedDraft);
          void submit(sessionId, {
            request_id: request.request_id,
            kind: request.kind,
            decision: allSkipped ? "skipped_all" : "submitted",
            answers,
            active_style: effectiveStyle,
          });
          return;
        }
      }
    }

    if (!isLastItem) {
      goNext();
    } else {
      submitClarificationOrForm();
    }
  }, [
    clearAutoAdvance,
    sessionId,
    request,
    draft,
    currentItem,
    isReadOnlyResolved,
    isSubmitting,
    isLastItem,
    activeIndex,
    updateDraft,
    buildSerializedAnswers,
    submit,
    effectiveStyle,
    goNext,
    submitClarificationOrForm,
  ]);

  const skipCurrent = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || !draft || !currentItem || isReadOnlyResolved || isSubmitting) {
      return;
    }
    if (request.kind === "tool_approval" || request.kind === "plan_approval" || request.kind === "batch_approval") {
      return;
    }

    const updatedDraft: DraftState = {
      ...draft,
      answers: {
        ...draft.answers,
        [currentItem.item_id]: {
          ...getItemDraftAnswer(draft, currentItem),
          status: "skipped",
          selected_ids: [],
          custom_text: "",
          touched: true,
        },
      },
      formErrors: {
        ...draft.formErrors,
        [currentItem.item_id]: {},
      },
    };

    if (!isLastItem) {
      updateDraft(sessionId, request.request_id, {
        ...updatedDraft,
        activeIndex: activeIndex + 1,
        focusedOptionIndex: 0,
        focusedField: null,
      });
      return;
    }

    // 末题 Skip：打包提交整组（全跳过则 decision = 'skipped_all'）
    const { answers, allSkipped } = buildSerializedAnswers(updatedDraft);
    const payload: ConfirmationResponsePayload = {
      request_id: request.request_id,
      kind: request.kind,
      decision: allSkipped ? "skipped_all" : "submitted",
      answers,
      active_style: effectiveStyle,
    };
    void submit(sessionId, payload);
  }, [
    clearAutoAdvance,
    sessionId,
    request,
    draft,
    currentItem,
    isReadOnlyResolved,
    isSubmitting,
    isLastItem,
    activeIndex,
    updateDraft,
    buildSerializedAnswers,
    effectiveStyle,
    submit,
  ]);

  const approveOnce = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || isReadOnlyResolved || isSubmitting) return;
    if (request.kind !== "tool_approval") return;

    const payload: ConfirmationResponsePayload = {
      request_id: request.request_id,
      kind: "tool_approval",
      decision: "approved",
      permission_scope: "once",
      active_style: effectiveStyle,
    };
    void submit(sessionId, payload);
  }, [clearAutoAdvance, sessionId, request, isReadOnlyResolved, isSubmitting, effectiveStyle, submit]);

  const approveSession = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || !currentItem || isReadOnlyResolved || isSubmitting) return;
    if (request.kind !== "tool_approval" || isBatchMode) return;
    const sig = currentItem.scope_signature;
    if (!sig) return;

    const payload: ConfirmationResponsePayload = {
      request_id: request.request_id,
      kind: "tool_approval",
      decision: "approved",
      permission_scope: "session",
      scope_signature: sig,
      active_style: effectiveStyle,
    };
    void submit(sessionId, payload);
  }, [clearAutoAdvance, sessionId, request, currentItem, isReadOnlyResolved, isSubmitting, isBatchMode, effectiveStyle, submit]);

  const approveWorkspaceRule = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || !currentItem || isReadOnlyResolved || isSubmitting) return;
    if (request.kind !== "tool_approval" || isBatchMode) return;
    if (currentItem.risk_level === "high") return;
    const sig = currentItem.scope_signature;
    if (!sig) return;

    const payload: ConfirmationResponsePayload = {
      request_id: request.request_id,
      kind: "tool_approval",
      decision: "approved",
      permission_scope: "workspace_rule",
      scope_signature: sig,
      active_style: effectiveStyle,
    };
    void submit(sessionId, payload);
  }, [clearAutoAdvance, sessionId, request, currentItem, isReadOnlyResolved, isSubmitting, isBatchMode, effectiveStyle, submit]);

  const decideBatchItem = useCallback(
    (
      decision: "approved" | "rejected",
      scope: PermissionScope = "once",
      autoNext = true
    ) => {
      clearAutoAdvance();
      if (!sessionId || !request || !isBatchMode || isReadOnlyResolved || isSubmitting) return;
      const item = batchItems[activeIndex];
      const itemKey = batchItemKeys[activeIndex];
      if (!item || !itemKey) return;

      let effectiveScope: PermissionScope = scope;
      if (decision !== "approved") {
        effectiveScope = "once";
      } else if (effectiveScope === "workspace_rule") {
        if (item.risk_level === "high" || !item.scope_signature) {
          effectiveScope = "once";
        }
      } else if (effectiveScope === "session" && !item.scope_signature) {
        effectiveScope = "once";
      }

      const itemDecision: BatchItemDecision = {
        decision,
        ...(decision === "approved"
          ? {
              permission_scope: effectiveScope,
              ...(effectiveScope !== "once" && item.scope_signature
                ? { scope_signature: item.scope_signature }
                : {}),
            }
          : {}),
      };

      updateDraft(sessionId, request.request_id, (prev) => {
        const nextDecisions = {
          ...(prev.batchDecisions || {}),
          [itemKey]: itemDecision,
        };
        let nextIndex = prev.activeIndex;
        if (autoNext) {
          // 优先跳到下一个尚未决议的条目；若都已决议则停在当前/末页
          let found = -1;
          for (let i = activeIndex + 1; i < batchItemKeys.length; i += 1) {
            if (!nextDecisions[batchItemKeys[i]]) {
              found = i;
              break;
            }
          }
          if (found === -1) {
            for (let i = 0; i < activeIndex; i += 1) {
              if (!nextDecisions[batchItemKeys[i]]) {
                found = i;
                break;
              }
            }
          }
          if (found !== -1) {
            nextIndex = found;
          } else if (activeIndex < batchItemKeys.length - 1) {
            nextIndex = activeIndex + 1;
          }
        }
        return {
          ...prev,
          activeIndex: nextIndex,
          batchDecisions: nextDecisions,
        };
      });
    },
    [
      clearAutoAdvance,
      sessionId,
      request,
      isBatchMode,
      isReadOnlyResolved,
      isSubmitting,
      batchItems,
      batchItemKeys,
      activeIndex,
      updateDraft,
    ]
  );

  const approveAllBatchNonHigh = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || !isBatchMode || isReadOnlyResolved || isSubmitting) return;

    updateDraft(sessionId, request.request_id, (prev) => {
      const nextDecisions: Record<string, BatchItemDecision> = {
        ...(prev.batchDecisions || {}),
      };
      let firstUnresolvedHigh = -1;

      for (let i = 0; i < batchItems.length; i += 1) {
        const item = batchItems[i];
        const key = batchItemKeys[i];
        if (!item || !key) continue;
        if (item.risk_level === "high") {
          if (!nextDecisions[key] && firstUnresolvedHigh === -1) {
            firstUnresolvedHigh = i;
          }
          continue;
        }
        // 安全规则 §4.5：Approve all 固定 scope = once，且跳过高危条目
        nextDecisions[key] = {
          decision: "approved",
          permission_scope: "once",
        };
      }

      return {
        ...prev,
        activeIndex:
          firstUnresolvedHigh !== -1 ? firstUnresolvedHigh : prev.activeIndex,
        batchDecisions: nextDecisions,
      };
    });
  }, [
    clearAutoAdvance,
    sessionId,
    request,
    isBatchMode,
    isReadOnlyResolved,
    isSubmitting,
    batchItems,
    batchItemKeys,
    updateDraft,
  ]);

  const submitBatch = useCallback(() => {
    clearAutoAdvance();
    if (
      !sessionId ||
      !request ||
      !isBatchMode ||
      !batchAllResolved ||
      isReadOnlyResolved ||
      isSubmitting
    ) {
      return;
    }

    if (isAggregatedBatch) {
      const payloads: ConfirmationResponsePayload[] = aggregatedEntries.map(
        (ag) => {
          const dec = batchDecisions[ag.request.request_id];
          const isApproved = dec?.decision === "approved";
          return {
            request_id: ag.request.request_id,
            kind: "tool_approval",
            decision: isApproved ? "approved" : "rejected",
            ...(isApproved
              ? {
                  permission_scope: dec?.permission_scope ?? "once",
                  ...(dec?.scope_signature
                    ? { scope_signature: dec.scope_signature }
                    : {}),
                }
              : {}),
            active_style: effectiveStyle,
          };
        }
      );
      void submitAggregatedBatch(sessionId, payloads);
      return;
    }

    const itemDecisions: Record<string, BatchItemDecision> = {};
    for (const key of batchItemKeys) {
      itemDecisions[key] = batchDecisions[key] || { decision: "rejected" };
    }
    void submit(sessionId, {
      request_id: request.request_id,
      kind: "batch_approval",
      decision: "submitted",
      item_decisions: itemDecisions,
      active_style: effectiveStyle,
    });
  }, [
    clearAutoAdvance,
    sessionId,
    request,
    isBatchMode,
    batchAllResolved,
    isReadOnlyResolved,
    isSubmitting,
    isAggregatedBatch,
    aggregatedEntries,
    batchDecisions,
    batchItemKeys,
    effectiveStyle,
    submitAggregatedBatch,
    submit,
  ]);

  const rejectTool = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || isReadOnlyResolved || isSubmitting) return;
    if (request.kind !== "tool_approval" || isBatchMode) return;

    const payload: ConfirmationResponsePayload = {
      request_id: request.request_id,
      kind: "tool_approval",
      decision: "rejected",
      active_style: effectiveStyle,
    };
    void submit(sessionId, payload);
  }, [clearAutoAdvance, sessionId, request, isReadOnlyResolved, isSubmitting, isBatchMode, effectiveStyle, submit]);

  const approvePlan = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || isReadOnlyResolved || isSubmitting) return;
    if (request.kind !== "plan_approval") return;
    void submit(sessionId, {
      request_id: request.request_id,
      kind: "plan_approval",
      decision: "approved",
      active_style: effectiveStyle,
    });
  }, [clearAutoAdvance, sessionId, request, isReadOnlyResolved, isSubmitting, effectiveStyle, submit]);

  const requestPlanChanges = useCallback(
    (feedback?: string) => {
      clearAutoAdvance();
      if (!sessionId || !request || isReadOnlyResolved || isSubmitting) return;
      if (request.kind !== "plan_approval") return;
      const text = (feedback ?? customText ?? "").trim();
      if (!text) {
        // 没写意见：把焦点交给气泡内的意见输入行，而不是发空拒绝
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLInputElement>(
            '[data-testid="confirmation-dock"] [data-cf-field="writein"]'
          );
          el?.focus();
        });
        return;
      }
      void submit(sessionId, {
        request_id: request.request_id,
        kind: "plan_approval",
        decision: "rejected",
        feedback: text,
        active_style: effectiveStyle,
      });
    },
    [clearAutoAdvance, sessionId, request, isReadOnlyResolved, isSubmitting, customText, effectiveStyle, submit]
  );

  const denyAndRedirect = useCallback(
    (inlineReason?: string) => {
      clearAutoAdvance();
      if (!sessionId || !request || isReadOnlyResolved || isSubmitting) return;
      if (request.kind !== "tool_approval") return;

      const trimmedInline = (inlineReason ?? customText ?? "").trim();

      // 立即 POST rejected 解除后端阻塞，防止等待期间超时竞争
      const payload: ConfirmationResponsePayload = {
        request_id: request.request_id,
        kind: "tool_approval",
        decision: "rejected",
        active_style: effectiveStyle,
      };
      void submit(sessionId, payload);

      if (trimmedInline && onSendRedirectMessage) {
        onSendRedirectMessage(trimmedInline);
        return;
      }

      setRedirectBanner({
        sessionId: String(sessionId),
        requestId: request.request_id,
      });
      requestAnimationFrame(() => {
        composerRef?.current?.focus();
      });
    },
    [
      clearAutoAdvance,
      sessionId,
      request,
      isReadOnlyResolved,
      isSubmitting,
      customText,
      effectiveStyle,
      submit,
      onSendRedirectMessage,
      setRedirectBanner,
      composerRef,
    ]
  );

  const dismiss = useCallback(() => {
    clearAutoAdvance();
    if (!sessionId || !request || isSubmitting) return;
    if (isReadOnlyResolved) {
      removeEntry(sessionId, request.request_id);
      composerRef?.current?.focus();
      return;
    }

    if (request.kind === "plan_approval") {
      // Plan 审批不可被 Esc / × 放弃：只允许批准或带意见修订
      return;
    }
    if (isAggregatedBatch) {
      const payloads: ConfirmationResponsePayload[] = aggregatedEntries.map(
        (ag) => ({
          request_id: ag.request.request_id,
          kind: "tool_approval",
          decision: "dismissed",
          active_style: effectiveStyle,
        })
      );
      void submitAggregatedBatch(sessionId, payloads);
    } else if (request.kind === "batch_approval") {
      void submit(sessionId, {
        request_id: request.request_id,
        kind: "batch_approval",
        decision: "dismissed",
        item_decisions: {},
        active_style: effectiveStyle,
      });
    } else if (request.kind === "tool_approval") {
      void submit(sessionId, {
        request_id: request.request_id,
        kind: "tool_approval",
        decision: "dismissed",
        active_style: effectiveStyle,
      });
    } else {
      void submit(sessionId, {
        request_id: request.request_id,
        kind: request.kind,
        decision: "dismissed",
        answers: {},
        active_style: effectiveStyle,
      });
    }
    requestAnimationFrame(() => {
      composerRef?.current?.focus();
    });
  }, [
    clearAutoAdvance,
    sessionId,
    request,
    isSubmitting,
    isReadOnlyResolved,
    isAggregatedBatch,
    aggregatedEntries,
    removeEntry,
    composerRef,
    submit,
    submitAggregatedBatch,
    effectiveStyle,
  ]);

  const sendTimeoutDraftAsMessage = useCallback(() => {
    if (!sessionId || !request || !timeoutDraftText) return;
    if (onFillComposerText) {
      onFillComposerText(timeoutDraftText);
    }
    removeEntry(sessionId, request.request_id);
    requestAnimationFrame(() => {
      composerRef?.current?.focus();
    });
  }, [sessionId, request, timeoutDraftText, onFillComposerText, removeEntry, composerRef]);

  return {
    entry,
    queueLength: queue.length,
    effectiveStyle,
    stylePreference,
    permissionMode,
    currentItem,
    currentAnswer,
    currentErrors,
    activeIndex,
    totalItems,
    isFirstItem,
    isLastItem,
    isReadOnlyResolved,
    isSubmitting,
    isMinimized: Boolean(draft?.minimized),
    countdownSeconds,
    timeoutDraftText,
    approvalSelectionIndex,
    setApprovalSelectionIndex,
    customText,
    isOverrideActive,
    appendSelectedCount,
    isBatchMode,
    isAggregatedBatch,
    batchItems,
    batchItemKeys,
    batchItemSources,
    batchDecisions,
    batchResolvedCount,
    batchAllResolved,
    batchHighRiskCount,
    batchNonHighCount,
    setStyle,
    selectSingleOption,
    toggleMultiOption,
    setCustomText,
    setFormValue,
    setFocusedOptionIndex,
    setFocusedField,
    toggleCodeExpanded,
    toggleMinimized,
    setMinimized,
    goPrev,
    goNext,
    goTo,
    skipCurrent,
    confirmFocusedOrAdvance,
    submitClarificationOrForm,
    approveOnce,
    approveSession,
    approveWorkspaceRule,
    rejectTool,
    approvePlan,
    requestPlanChanges,
    decideBatchItem,
    approveAllBatchNonHigh,
    submitBatch,
    denyAndRedirect,
    dismiss,
    sendTimeoutDraftAsMessage,
  };
}
