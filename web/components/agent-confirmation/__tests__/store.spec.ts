import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useConfirmationStore,
  resolveEffectiveStyle,
  buildLegacyPermissionEvent,
  formatDraftAsMessage,
  STYLE_STORAGE_KEY,
  PERMISSION_MODE_STORAGE_KEY,
  ALLOW_ASK_USER_STORAGE_KEY,
} from "../store/useConfirmationStore";
import type { ConfirmationRequestEvent } from "../types/protocol";

vi.mock("../engine/transport", () => ({
  submitConfirmation: vi.fn().mockResolvedValue({ success: true }),
  fetchSessionGrants: vi.fn().mockResolvedValue([]),
  clearSessionGrants: vi.fn().mockResolvedValue(undefined),
}));

function makeEvent(
  overrides: Partial<ConfirmationRequestEvent> = {}
): ConfirmationRequestEvent {
  return {
    request_id: "cf_req_1",
    session_id: "sess_a",
    kind: "clarification",
    dismissible: true,
    allow_chat_override: true,
    timeout_ms: 300_000,
    items: [
      {
        item_id: "q1",
        title: "选择认证方案",
        selection_mode: "single",
        options: [
          { id: "jwt", label: "JWT Token", recommended: true },
          { id: "session", label: "服务端 Session" },
        ],
        custom_input: { enabled: true, mode: "override" },
      },
    ],
    ...overrides,
  };
}

describe("useConfirmationStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useConfirmationStore.getState().resetStore();
    useConfirmationStore.setState({
      style: "auto",
      permissionMode: "accept_edits",
      allowAskUser: true,
      hydrated: false,
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("按 session 分槽入队并对同 request_id 去重，保留已有草稿", () => {
    const store = useConfirmationStore.getState();
    store.enqueue(makeEvent({ request_id: "cf_1", session_id: "s1" }));
    store.enqueue(makeEvent({ request_id: "cf_2", session_id: "s1" }));
    store.enqueue(makeEvent({ request_id: "cf_3", session_id: "s2" }));

    store.updateDraft("s1", "cf_1", { codeExpanded: true });
    // 重复 enqueue 同 request_id 不覆盖草稿
    store.enqueue(makeEvent({ request_id: "cf_1", session_id: "s1" }));

    const state = useConfirmationStore.getState();
    expect(state.bySession["s1"]).toHaveLength(2);
    expect(state.bySession["s2"]).toHaveLength(1);
    expect(state.bySession["s1"][0].draft.codeExpanded).toBe(true);
  });

  it("远端结案：非 timeout 立即移除，timeout 先进入只读结案态并在到期后自动收起", () => {
    const store = useConfirmationStore.getState();
    store.enqueue(makeEvent({ request_id: "cf_ok", session_id: "s1" }));
    store.resolveRemote({ request_id: "cf_ok", decision: "approved" });
    expect(useConfirmationStore.getState().bySession["s1"]).toBeUndefined();

    store.enqueue(
      makeEvent({
        request_id: "cf_to",
        session_id: "s1",
        kind: "tool_approval",
      })
    );
    store.resolveRemote({ request_id: "cf_to", decision: "timeout" });

    const entry = useConfirmationStore.getState().bySession["s1"]?.[0];
    expect(entry?.status).toBe("RESOLVED");
    expect(entry?.resolvedDecision).toBe("timeout");

    vi.advanceTimersByTime(2100);
    expect(useConfirmationStore.getState().bySession["s1"]).toBeUndefined();
  });

  it("Chat Override resolveAllForSession 仅关闭当前会话气泡与纠偏横幅", () => {
    const store = useConfirmationStore.getState();
    store.enqueue(makeEvent({ request_id: "cf_a", session_id: "s1" }));
    store.enqueue(makeEvent({ request_id: "cf_b", session_id: "s2" }));
    store.setRedirectBanner({ sessionId: "s1", requestId: "cf_a" });

    store.resolveAllForSession("s1");

    const state = useConfirmationStore.getState();
    expect(state.bySession["s1"]).toBeUndefined();
    expect(state.bySession["s2"]).toHaveLength(1);
    expect(state.redirectBanner).toBeNull();
  });

  it("auto 默认落点为 codex_desktop (Charcoal) 并正确水合 localStorage 偏好", () => {
    expect(resolveEffectiveStyle("auto")).toBe("codex_desktop");
    expect(resolveEffectiveStyle("auto", "claude_desktop")).toBe("claude_desktop");
    expect(resolveEffectiveStyle("google_aistudio", "claude_desktop")).toBe(
      "google_aistudio"
    );

    window.localStorage.setItem(STYLE_STORAGE_KEY, "claude_desktop");
    window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, "review_all");
    window.localStorage.setItem(ALLOW_ASK_USER_STORAGE_KEY, "false");

    useConfirmationStore.getState().hydratePreferences();
    const state = useConfirmationStore.getState();
    expect(state.style).toBe("claude_desktop");
    expect(state.permissionMode).toBe("review_all");
    expect(state.allowAskUser).toBe(false);
  });

  it("兼容转换旧版 permission_request 事件并格式化超时草稿文本", () => {
    const legacy = buildLegacyPermissionEvent({
      sessionId: "s_old",
      approvalId: "tc_99",
      toolName: "workspace__execute_command",
      arguments: { command: "rm -f tmp.log" },
      reason: "危险命令",
    });
    expect(legacy.request_id).toBe("cf_tc_99");
    expect(legacy.kind).toBe("tool_approval");
    expect(legacy.items[0].code_preview?.language).toBe("bash");
    expect(legacy.items[0].scope_signature).toBeNull();

    const ev = makeEvent({ request_id: "cf_draft", session_id: "s_d" });
    useConfirmationStore.getState().enqueue(ev);
    useConfirmationStore.getState().updateDraft("s_d", "cf_draft", (prev) => ({
      ...prev,
      answers: {
        ...prev.answers,
        q1: {
          status: "answered",
          selected_ids: ["jwt"],
          custom_text: "",
          custom_mode: "override",
          touched: true,
        },
      },
    }));
    const entry = useConfirmationStore.getState().bySession["s_d"][0];
    expect(formatDraftAsMessage(entry.request, entry.draft)).toContain("JWT Token");
  });

  it("Chat Override 乐观推入的 steer_ 用户消息收到 mid_task_steered 后原地转 success，不产生重复用户气泡", async () => {
    const { useChatStore } = await import("@/stores/useChatStore");
    const sid = "s_steer_dedup";
    useChatStore.getState().resetChatStore();
    useChatStore.setState({
      messagesBySession: {
        [sid]: [
          {
            id: "ai_1",
            session_id: sid,
            role: "assistant",
            content: "正在等待确认",
            status: "streaming",
            created_at: new Date().toISOString(),
          },
          {
            id: "steer_12345",
            session_id: sid,
            role: "user",
            content: "别删了，改做备份",
            status: "streaming",
            created_at: new Date().toISOString(),
          },
        ],
      },
    });

    useChatStore.getState().applyMidTaskSteered(sid, "ai_1", "别删了，改做备份");

    const msgs = useChatStore.getState().messagesBySession[sid] || [];
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].id).toBe("steer_12345");
    expect(userMsgs[0].status).toBe("success");
    expect(msgs[msgs.length - 1].role).toBe("assistant");
    expect(msgs[msgs.length - 1].status).toBe("streaming");
  });
});
