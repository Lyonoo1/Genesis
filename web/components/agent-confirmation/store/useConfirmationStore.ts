import { create } from "zustand";
import type {
  ConcreteConfirmStyle,
  ConfirmationItem,
  ConfirmationKind,
  ConfirmationQueueEntry,
  ConfirmationRequestEvent,
  ConfirmationResolvedEvent,
  ConfirmationResponsePayload,
  ConfirmStyle,
  DraftItemAnswer,
  DraftState,
  PermissionMode,
} from "../types/protocol";
import { buildInitialFormValues } from "../engine/formValidator";
import { submitConfirmation } from "../engine/transport";

export const STYLE_STORAGE_KEY = "agent_confirm_style";
export const PERMISSION_MODE_STORAGE_KEY = "agent_permission_mode";
export const ALLOW_ASK_USER_STORAGE_KEY = "agent_allow_ask_user";

const VALID_STYLES: ConfirmStyle[] = [
  "auto",
  "google_aistudio",
  "claude_desktop",
  "codex_desktop",
];

const VALID_PERMISSION_MODES: PermissionMode[] = [
  "accept_edits",
  "default",
  "review_all",
];

const timeoutCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function resolveEffectiveStyle(
  pref: ConfirmStyle,
  uiHint?: ConcreteConfirmStyle
): ConcreteConfirmStyle {
  if (pref === "auto") {
    return uiHint ?? "codex_desktop";
  }
  return pref;
}

export function createInitialDraft(request: ConfirmationRequestEvent): DraftState {
  const answers: Record<string, DraftItemAnswer> = {};
  for (const item of request.items || []) {
    if (item.selection_mode === "form") {
      answers[item.item_id] = {
        status: "answered",
        selected_ids: [],
        form_values: buildInitialFormValues(item.form_fields || []),
        touched: false,
      };
    } else {
      answers[item.item_id] = {
        status: "answered",
        selected_ids: [],
        custom_text: "",
        custom_mode:
          item.custom_input?.mode ||
          (item.selection_mode === "multi" ? "append" : "override"),
        touched: false,
      };
    }
  }
  return {
    activeIndex: 0,
    focusedOptionIndex: 0,
    focusedField: null,
    answers,
    formErrors: {},
    codeExpanded: false,
    minimized: false,
  };
}

/**
 * 将超时前的澄清/表单草稿拼装为可读文本，供用户点击「作为消息发送」填入主输入框。
 */
export function formatDraftAsMessage(
  request: ConfirmationRequestEvent,
  draft: DraftState
): string {
  const lines: string[] = [];
  for (const item of request.items || []) {
    const ans = draft.answers[item.item_id];
    if (!ans || !ans.touched) continue;

    if (item.selection_mode === "form" && ans.form_values) {
      const pairs = (item.form_fields || [])
        .map((f) => {
          const val = ans.form_values?.[f.key];
          if (val === undefined || val === null || val === "") return null;
          return `${f.label}: ${String(val)}`;
        })
        .filter(Boolean);
      if (pairs.length > 0) {
        lines.push(`${item.title} -> ${pairs.join("；")}`);
      }
      continue;
    }

    const customText = (ans.custom_text || "").trim();
    const selectedLabels = (ans.selected_ids || [])
      .map((id) => item.options?.find((o) => o.id === id)?.label || id)
      .filter(Boolean);

    if (ans.custom_mode === "override" && customText) {
      lines.push(`${item.title} -> ${customText}`);
    } else if (selectedLabels.length > 0 || customText) {
      const parts = [...selectedLabels];
      if (customText) parts.push(`补充：${customText}`);
      lines.push(`${item.title} -> ${parts.join("、")}`);
    }
  }
  return lines.join("\n");
}

export function hasMeaningfulDraft(
  request: ConfirmationRequestEvent,
  draft: DraftState
): boolean {
  return formatDraftAsMessage(request, draft).trim().length > 0;
}

export interface RedirectBannerState {
  sessionId: string;
  requestId: string;
}

export interface ConfirmationStoreState {
  bySession: Record<string, ConfirmationQueueEntry[]>;
  grantsBySession: Record<string, string[]>;
  serverClockOffsetMs: number;
  style: ConfirmStyle;
  permissionMode: PermissionMode;
  allowAskUser: boolean;
  hydrated: boolean;
  redirectBanner: RedirectBannerState | null;

  hydratePreferences: () => void;
  setStyle: (s: ConfirmStyle) => void;
  setPermissionMode: (m: PermissionMode) => void;
  setAllowAskUser: (enabled: boolean) => void;
  setRedirectBanner: (banner: RedirectBannerState | null) => void;
  setGrants: (sessionId: string, grants: string[]) => void;

  enqueue: (e: ConfirmationRequestEvent) => void;
  reconcileSnapshot: (
    sessionId: string,
    requests: ConfirmationRequestEvent[],
    serverNow?: string
  ) => void;
  resolveRemote: (e: ConfirmationResolvedEvent) => void;
  removeEntry: (sessionId: string, requestId: string) => void;
  removeByKind: (sessionId: string, kind: ConfirmationKind) => void;
  resolveAllForSession: (sessionId: string) => void;
  updateDraft: (
    sessionId: string,
    requestId: string,
    patch:
      | Partial<DraftState>
      | ((prev: DraftState) => DraftState)
  ) => void;
  submit: (
    sessionId: string,
    payload: ConfirmationResponsePayload
  ) => Promise<void>;
  submitAggregatedBatch: (
    sessionId: string,
    payloads: ConfirmationResponsePayload[]
  ) => Promise<void>;
  resetStore: () => void;
}

const SESSION_DRAFTS_KEY = "genesis_confirm_drafts_v1";

function readSessionDrafts(): Record<string, DraftState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(SESSION_DRAFTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveDraftToSession(requestId: string, draft: DraftState): void {
  if (typeof window === "undefined" || !requestId) return;
  try {
    const all = readSessionDrafts();
    all[requestId] = draft;
    window.sessionStorage.setItem(SESSION_DRAFTS_KEY, JSON.stringify(all));
  } catch {}
}

function loadDraftFromSession(requestId: string): DraftState | null {
  if (typeof window === "undefined" || !requestId) return null;
  const all = readSessionDrafts();
  return all[requestId] || null;
}

function deleteDraftFromSession(requestId: string): void {
  if (typeof window === "undefined" || !requestId) return;
  try {
    const all = readSessionDrafts();
    if (requestId in all) {
      delete all[requestId];
      window.sessionStorage.setItem(SESSION_DRAFTS_KEY, JSON.stringify(all));
    }
  } catch {}
}

function clearTimer(key: string) {
  const existing = timeoutCleanupTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    timeoutCleanupTimers.delete(key);
  }
}

export function buildPlanApprovalEvent(payload: {
  sessionId: string;
  planId: string;
  plan: string;
  agentName?: string;
}): ConfirmationRequestEvent {
  const agent = payload.agentName || "Genesis";
  const planId = payload.planId || "plan";
  const requestId = `plan_${planId}`;

  return {
    request_id: requestId,
    session_id: payload.sessionId,
    agent_id: null,
    kind: "plan_approval",
    dismissible: false,
    allow_chat_override: true,
    items: [
      {
        item_id: `plan_item_${planId}`,
        title: `允许 ${agent} 执行该实现计划？`,
        review_title: "是否批准该实现计划并切换至 Act 模式执行？",
        subtitle: "批准后将自动切回 Act 模式并开始实施；如需调整可直接在下方输入修改意见。",
        selection_mode: "approval",
        risk_level: "low",
        tool_name: planId,
        scope_signature: null,
        code_preview: {
          language: "markdown",
          filename: planId,
          content: payload.plan || "",
        },
        custom_input: {
          enabled: true,
          mode: "override",
          placeholder: "输入计划调整意见（例如：拆分成两步先改后端再改前端）…",
        },
      },
    ],
  };
}

export function buildLegacyPermissionEvent(payload: {
  sessionId: string;
  approvalId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason?: string;
}): ConfirmationRequestEvent {
  const rawId = payload.approvalId || `legacy_${Date.now()}`;
  const requestId = rawId.startsWith("cf_") ? rawId : `cf_${rawId}`;
  const toolName = payload.toolName || "workspace__execute_command";
  const args = payload.arguments || {};

  let codePreview: ConfirmationItem["code_preview"];
  if (toolName === "workspace__execute_command" || toolName === "workspace__exec_command") {
    codePreview = {
      language: "bash",
      content: String(args.command || args.cmd || ""),
    };
  } else {
    codePreview = {
      language: "json",
      content: JSON.stringify(args, null, 2),
    };
  }

  return {
    request_id: requestId,
    session_id: payload.sessionId,
    agent_id: null,
    kind: "tool_approval",
    dismissible: true,
    allow_chat_override: true,
    timeout_ms: 300_000,
    items: [
      {
        item_id: `item_${rawId}`,
        tool_call_id: rawId,
        title: `允许 Genesis 执行 ${toolName}？`,
        review_title: "是否批准以下工具调用？",
        subtitle:
          payload.reason || "该工具涉及高危文件写操作或命令执行，需用户确认授权",
        selection_mode: "approval",
        risk_level: toolName === "workspace__delete_file" ? "high" : "medium",
        tool_name: toolName,
        scope_signature: null,
        code_preview: codePreview,
        custom_input: {
          enabled: true,
          mode: "override",
          placeholder: "拒绝并告知 Genesis 调整方向…",
        },
      },
    ],
  };
}

export const useConfirmationStore = create<ConfirmationStoreState>((set, get) => ({
  bySession: {},
  grantsBySession: {},
  serverClockOffsetMs: 0,
  style: "auto",
  permissionMode: "accept_edits",
  allowAskUser: true,
  hydrated: false,
  redirectBanner: null,

  hydratePreferences: () => {
    if (typeof window === "undefined") return;
    try {
      const savedStyle = window.localStorage.getItem(STYLE_STORAGE_KEY);
      const savedPerm = window.localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
      const savedAsk = window.localStorage.getItem(ALLOW_ASK_USER_STORAGE_KEY);

      const nextStyle: ConfirmStyle =
        savedStyle && VALID_STYLES.includes(savedStyle as ConfirmStyle)
          ? (savedStyle as ConfirmStyle)
          : "auto";
      const nextPerm: PermissionMode =
        savedPerm && VALID_PERMISSION_MODES.includes(savedPerm as PermissionMode)
          ? (savedPerm as PermissionMode)
          : "accept_edits";
      const nextAsk = savedAsk === null ? true : savedAsk !== "false";

      set({
        style: nextStyle,
        permissionMode: nextPerm,
        allowAskUser: nextAsk,
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },

  setStyle: (style) => {
    set({ style });
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STYLE_STORAGE_KEY, style);
      } catch {}
    }
  },

  setPermissionMode: (permissionMode) => {
    set({ permissionMode });
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, permissionMode);
      } catch {}
    }
  },

  setAllowAskUser: (allowAskUser) => {
    set({ allowAskUser });
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          ALLOW_ASK_USER_STORAGE_KEY,
          allowAskUser ? "true" : "false"
        );
      } catch {}
    }
  },

  setRedirectBanner: (redirectBanner) => set({ redirectBanner }),

  setGrants: (sessionId, grants) => {
    const sid = String(sessionId);
    set((state) => ({
      grantsBySession: {
        ...state.grantsBySession,
        [sid]: [...grants],
      },
    }));
  },

  enqueue: (event) => {
    if (!event?.session_id || !event?.request_id) return;
    const sid = String(event.session_id);
    set((state) => {
      const existing = state.bySession[sid] || [];
      if (existing.some((entry) => entry.request.request_id === event.request_id)) {
        return state;
      }
      const restoredDraft = loadDraftFromSession(event.request_id);
      const nextEntry: ConfirmationQueueEntry = {
        request: event,
        draft: restoredDraft ?? createInitialDraft(event),
        status: "AWAITING",
        receivedAt: Date.now(),
      };
      return {
        bySession: {
          ...state.bySession,
          [sid]: [...existing, nextEntry],
        },
      };
    });
  },

  reconcileSnapshot: (sessionId, requests, serverNow) => {
    const sid = String(sessionId);
    const parsedServerNow = serverNow ? Date.parse(serverNow) : NaN;
    const nextOffset = Number.isFinite(parsedServerNow)
      ? parsedServerNow - Date.now()
      : get().serverClockOffsetMs;

    set((state) => {
      const serverIds = new Set(requests.map((r) => r.request_id));
      const local = state.bySession[sid] ?? [];
      // 1. 保留 plan_approval（由 Plan 生命周期驱动）以及服务端仍挂起的本地条目
      const kept = local.filter((entry) => {
        if (entry.request.kind === "plan_approval") return true;
        if (serverIds.has(entry.request.request_id)) return true;
        clearTimer(`${sid}:${entry.request.request_id}`);
        deleteDraftFromSession(entry.request.request_id);
        return false;
      });
      // 2. 服务端挂起但本地尚未入队的条目 -> 刷新恢复，并尝试合并 sessionStorage 草稿
      const keptIds = new Set(kept.map((e) => e.request.request_id));
      const added: ConfirmationQueueEntry[] = requests
        .filter((r) => !keptIds.has(r.request_id))
        .map((r) => ({
          request: r,
          draft: loadDraftFromSession(r.request_id) ?? createInitialDraft(r),
          status: "AWAITING" as const,
          receivedAt: Date.now(),
        }));

      const merged = [...kept, ...added];
      const nextBySession = { ...state.bySession };
      if (merged.length === 0) {
        delete nextBySession[sid];
      } else {
        nextBySession[sid] = merged;
      }
      return {
        bySession: nextBySession,
        serverClockOffsetMs: nextOffset,
      };
    });
  },

  removeEntry: (sessionId, requestId) => {
    const sid = String(sessionId);
    clearTimer(`${sid}:${requestId}`);
    deleteDraftFromSession(requestId);
    set((state) => {
      const list = state.bySession[sid];
      if (!list) return state;
      const filtered = list.filter((e) => e.request.request_id !== requestId);
      const nextBySession = { ...state.bySession };
      if (filtered.length === 0) {
        delete nextBySession[sid];
      } else {
        nextBySession[sid] = filtered;
      }
      return { bySession: nextBySession };
    });
  },

  resolveRemote: (event) => {
    if (!event?.request_id) return;
    const targetId = event.request_id;
    const { bySession } = get();
    let matchedSid: string | null = null;
    let matchedEntry: ConfirmationQueueEntry | null = null;

    for (const [sid, entries] of Object.entries(bySession)) {
      const found = entries.find((e) => e.request.request_id === targetId);
      if (found) {
        matchedSid = sid;
        matchedEntry = found;
        break;
      }
    }
    if (!matchedSid || !matchedEntry) return;

    const sid = matchedSid;
    if (event.decision === "timeout") {
      set((state) => {
        const list = state.bySession[sid] || [];
        return {
          bySession: {
            ...state.bySession,
            [sid]: list.map((e) =>
              e.request.request_id === targetId
                ? { ...e, status: "RESOLVED", resolvedDecision: "timeout" }
                : e
            ),
          },
        };
      });

      // 超时只读结案态展示 2s 后自动收起（若 clarification 有草稿则保留至用户点击或 8s 兜底）
      const keepLonger =
        matchedEntry.request.kind !== "tool_approval" &&
        hasMeaningfulDraft(matchedEntry.request, matchedEntry.draft);
      const delayMs = keepLonger ? 8000 : 2000;
      const timerKey = `${sid}:${targetId}`;
      clearTimer(timerKey);
      const timer = setTimeout(() => {
        get().removeEntry(sid, targetId);
      }, delayMs);
      timeoutCleanupTimers.set(timerKey, timer);
      return;
    }

    get().removeEntry(sid, targetId);
  },

  removeByKind: (sessionId, kind) => {
    if (!sessionId) return;
    const sid = String(sessionId);
    const list = get().bySession[sid];
    if (!list || !list.some((e) => e.request.kind === kind)) return;
    for (const entry of list) {
      if (entry.request.kind === kind) {
        clearTimer(`${sid}:${entry.request.request_id}`);
      }
    }
    set((state) => {
      const cur = state.bySession[sid] || [];
      const kept = cur.filter((e) => e.request.kind !== kind);
      const nextBySession = { ...state.bySession };
      if (kept.length === 0) {
        delete nextBySession[sid];
      } else {
        nextBySession[sid] = kept;
      }
      return { bySession: nextBySession };
    });
  },

  resolveAllForSession: (sessionId) => {
    if (!sessionId) return;
    const sid = String(sessionId);
    const list = get().bySession[sid] || [];
    // plan_approval 由 Plan 生命周期状态驱动，发新消息不应让它消失（否则无法再批准计划）
    const survivors = list.filter((e) => e.request.kind === "plan_approval");
    for (const entry of list) {
      if (entry.request.kind !== "plan_approval") {
        clearTimer(`${sid}:${entry.request.request_id}`);
      }
    }
    set((state) => {
      const nextBySession = { ...state.bySession };
      if (survivors.length > 0) {
        nextBySession[sid] = survivors;
      } else {
        delete nextBySession[sid];
      }
      return {
        bySession: nextBySession,
        redirectBanner:
          state.redirectBanner?.sessionId === sid ? null : state.redirectBanner,
      };
    });
  },

  updateDraft: (sessionId, requestId, patch) => {
    const sid = String(sessionId);
    set((state) => {
      const list = state.bySession[sid];
      if (!list) return state;
      return {
        bySession: {
          ...state.bySession,
          [sid]: list.map((entry) => {
            if (entry.request.request_id !== requestId) return entry;
            const nextDraft =
              typeof patch === "function"
                ? patch(entry.draft)
                : { ...entry.draft, ...patch };
            saveDraftToSession(requestId, nextDraft);
            return { ...entry, draft: nextDraft };
          }),
        },
      };
    });
  },

  submit: async (sessionId, payload) => {
    const sid = String(sessionId);
    const reqId = payload.request_id;
    set((state) => {
      const list = state.bySession[sid];
      if (!list) return state;
      return {
        bySession: {
          ...state.bySession,
          [sid]: list.map((e) =>
            e.request.request_id === reqId ? { ...e, status: "SUBMITTING" } : e
          ),
        },
      };
    });

    // Plan 审批不走 /approve，而是复用既有 submitPlanDecision（切换 Act 模式 / 带意见回到 Plan 修订）
    if (payload.kind === "plan_approval") {
      try {
        const { useChatStore } = await import("@/stores/useChatStore");
        const ok = await useChatStore
          .getState()
          .submitPlanDecision(
            sid,
            payload.decision === "approved",
            payload.feedback
          );
        if (ok) {
          get().removeEntry(sid, reqId);
        } else {
          set((state) => {
            const list = state.bySession[sid];
            if (!list) return state;
            return {
              bySession: {
                ...state.bySession,
                [sid]: list.map((e) =>
                  e.request.request_id === reqId ? { ...e, status: "AWAITING" } : e
                ),
              },
            };
          });
        }
      } catch (err) {
        console.error("[useConfirmationStore] submit plan decision failed:", err);
        set((state) => {
          const list = state.bySession[sid];
          if (!list) return state;
          return {
            bySession: {
              ...state.bySession,
              [sid]: list.map((e) =>
                e.request.request_id === reqId ? { ...e, status: "AWAITING" } : e
              ),
            },
          };
        });
      }
      return;
    }

    try {
      await submitConfirmation(sid, payload);
      // 后端无论返回 success=true 还是 false（已被他处结案），前端均视为完成并收起
      get().removeEntry(sid, reqId);
    } catch (err) {
      console.error("[useConfirmationStore] submit confirmation failed:", err);
      // 拒绝或关闭类操作即使网络失败也收起，避免卡死界面；批准/提交类恢复 AWAITING 以便用户重试
      if (
        payload.decision === "dismissed" ||
        payload.decision === "rejected" ||
        payload.decision === "skipped_all"
      ) {
        get().removeEntry(sid, reqId);
      } else {
        set((state) => {
          const list = state.bySession[sid];
          if (!list) return state;
          return {
            bySession: {
              ...state.bySession,
              [sid]: list.map((e) =>
                e.request.request_id === reqId ? { ...e, status: "AWAITING" } : e
              ),
            },
          };
        });
      }
    }
  },

  submitAggregatedBatch: async (sessionId, payloads) => {
    if (!payloads.length) return;
    const sid = String(sessionId);
    await Promise.allSettled(
      payloads.map((p) => get().submit(sid, p))
    );
  },

  resetStore: () => {
    timeoutCleanupTimers.forEach((t) => clearTimeout(t));
    timeoutCleanupTimers.clear();
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(SESSION_DRAFTS_KEY);
      } catch {}
    }
    set({
      bySession: {},
      grantsBySession: {},
      serverClockOffsetMs: 0,
      redirectBanner: null,
    });
  },
}));
