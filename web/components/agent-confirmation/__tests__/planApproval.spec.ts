import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildPlanApprovalEvent,
  useConfirmationStore,
} from "../store/useConfirmationStore";

const submitPlanDecision = vi.fn();

vi.mock("../engine/transport", () => ({
  submitConfirmation: vi.fn().mockResolvedValue({ success: true }),
  fetchSessionGrants: vi.fn().mockResolvedValue([]),
  clearSessionGrants: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/useChatStore", () => ({
  useChatStore: {
    getState: () => ({ submitPlanDecision }),
  },
}));

const SID = "sess_plan";

function enqueuePlan(planId = "plan_1") {
  useConfirmationStore.getState().enqueue(
    buildPlanApprovalEvent({ sessionId: SID, planId, plan: "## 目标\n做点事" })
  );
}

describe("plan_approval 统一气泡", () => {
  beforeEach(() => {
    submitPlanDecision.mockReset();
    useConfirmationStore.getState().resetStore();
  });

  it("buildPlanApprovalEvent 产出不可关闭的 plan_approval 请求，计划正文走 markdown 预览", () => {
    const ev = buildPlanApprovalEvent({
      sessionId: SID,
      planId: "plan_9",
      plan: "# hi",
    });
    expect(ev.kind).toBe("plan_approval");
    expect(ev.dismissible).toBe(false);
    expect(ev.request_id).toBe("plan_plan_9");
    expect(ev.items[0].scope_signature).toBeNull();
    expect(ev.items[0].code_preview?.language).toBe("markdown");
  });

  it("批准：调用 submitPlanDecision(approved=true) 成功后移除气泡", async () => {
    submitPlanDecision.mockResolvedValue(true);
    enqueuePlan();
    await useConfirmationStore.getState().submit(SID, {
      request_id: "plan_plan_1",
      kind: "plan_approval",
      decision: "approved",
      active_style: "codex_desktop",
    });
    expect(submitPlanDecision).toHaveBeenCalledWith(SID, true, undefined);
    expect(useConfirmationStore.getState().bySession[SID]).toBeUndefined();
  });

  it("带意见修订：approved=false 且透传 feedback", async () => {
    submitPlanDecision.mockResolvedValue(true);
    enqueuePlan();
    await useConfirmationStore.getState().submit(SID, {
      request_id: "plan_plan_1",
      kind: "plan_approval",
      decision: "rejected",
      feedback: "拆成两步",
      active_style: "claude_desktop",
    });
    expect(submitPlanDecision).toHaveBeenCalledWith(SID, false, "拆成两步");
  });

  it("后端失败：气泡保留并恢复 AWAITING，允许重试", async () => {
    submitPlanDecision.mockResolvedValue(false);
    enqueuePlan();
    await useConfirmationStore.getState().submit(SID, {
      request_id: "plan_plan_1",
      kind: "plan_approval",
      decision: "approved",
      active_style: "google_aistudio",
    });
    const entry = useConfirmationStore.getState().bySession[SID]?.[0];
    expect(entry?.status).toBe("AWAITING");
  });

  it("发新消息触发 resolveAllForSession 时，plan_approval 不会被清掉，其它请求会", () => {
    enqueuePlan();
    useConfirmationStore.getState().enqueue({
      request_id: "cf_tool_1",
      session_id: SID,
      kind: "tool_approval",
      dismissible: true,
      allow_chat_override: true,
      items: [
        {
          item_id: "i1",
          title: "t",
          selection_mode: "approval",
        },
      ],
    });
    useConfirmationStore.getState().resolveAllForSession(SID);
    const list = useConfirmationStore.getState().bySession[SID] || [];
    expect(list.map((e) => e.request.kind)).toEqual(["plan_approval"]);
  });

  it("removeByKind 只移除指定类型", () => {
    enqueuePlan();
    useConfirmationStore.getState().removeByKind(SID, "plan_approval");
    expect(useConfirmationStore.getState().bySession[SID]).toBeUndefined();
  });
});
