import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { ConfirmationDock } from "../ConfirmationDock";
import { useConfirmationStore } from "../store/useConfirmationStore";
import * as transport from "../engine/transport";
import type { ConfirmationRequestEvent } from "../types/protocol";

vi.mock("../engine/useSessionEventChannel", () => ({
  useSessionEventChannel: () => {},
}));

describe("P2-4 批量审批与并发聚合视图", () => {
  beforeEach(() => {
    useConfirmationStore.getState().resetStore();
    useConfirmationStore.getState().setStyle("codex_desktop");
    vi.restoreAllMocks();
  });

  it("Approve all 跳过 high 风险条目并自动跳到该高危项，风格热切换后保留决议与页码", async () => {
    const submitSpy = vi
      .spyOn(transport, "submitConfirmation")
      .mockResolvedValue({ success: true });

    const batchReq: ConfirmationRequestEvent = {
      request_id: "cfb_1",
      session_id: "sess_b1",
      kind: "batch_approval",
      dismissible: true,
      allow_chat_override: true,
      items: [
        {
          item_id: "i1",
          title: "写入 a.ts",
          selection_mode: "approval",
          risk_level: "low",
          scope_signature: "edit:a.ts",
        },
        {
          item_id: "i2",
          title: "执行危险重置 git reset --hard",
          selection_mode: "approval",
          risk_level: "high",
          scope_signature: null,
        },
        {
          item_id: "i3",
          title: "写入 c.ts",
          selection_mode: "approval",
          risk_level: "medium",
          scope_signature: "edit:c.ts",
        },
      ],
    };

    useConfirmationStore.getState().enqueue(batchReq);
    render(<ConfirmationDock sessionId="sess_b1" />);

    expect(screen.getByTestId("charcoal-batch-tabs")).toBeTruthy();
    const approveAllBtn = screen.getByRole("button", {
      name: /Approve all \(2\)，1 项需单独确认/,
    });
    fireEvent.click(approveAllBtn);

    // 应自动跳到索引 1（高危项 i2）
    expect(screen.getByText("执行危险重置 git reset --hard")).toBeTruthy();
    const entryAfterAll = useConfirmationStore.getState().bySession["sess_b1"][0];
    expect(entryAfterAll.draft.activeIndex).toBe(1);
    expect(entryAfterAll.draft.batchDecisions?.i1).toEqual({
      decision: "approved",
      permission_scope: "once",
    });
    expect(entryAfterAll.draft.batchDecisions?.i3).toEqual({
      decision: "approved",
      permission_scope: "once",
    });
    expect(entryAfterAll.draft.batchDecisions?.i2).toBeUndefined();

    // 热切换风格 Charcoal -> Parchment -> Material，决议与页码应 100% 保留
    fireEvent.click(screen.getByLabelText("切换气泡风格"));
    expect(screen.getByTestId("parchment-batch-nav")).toBeTruthy();
    expect(screen.getByText("执行危险重置 git reset --hard")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("切换气泡风格"));
    expect(screen.getByTestId("material-batch-stepper")).toBeTruthy();
    expect(screen.getByText("执行危险重置 git reset --hard")).toBeTruthy();

    // 单独拒绝高危项后，出现「提交全部 (3)」按钮并提交
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    const submitAllBtn = screen.getByRole("button", { name: /提交全部 \(3\)/ });
    fireEvent.click(submitAllBtn);

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });
    const payload = submitSpy.mock.calls[0][1];
    expect(payload.kind).toBe("batch_approval");
    if (payload.kind === "batch_approval") {
      expect(payload.decision).toBe("submitted");
      expect(payload.item_decisions.i1.decision).toBe("approved");
      expect(payload.item_decisions.i2.decision).toBe("rejected");
      expect(payload.item_decisions.i3.decision).toBe("approved");
    }
  });

  it("队列中有 >= 2 个并发子代理 tool_approval 时自动进入聚合视图并标注来源，提交时逐个 POST", async () => {
    const submitSpy = vi
      .spyOn(transport, "submitConfirmation")
      .mockResolvedValue({ success: true });

    const req1: ConfirmationRequestEvent = {
      request_id: "cf_sa_1",
      session_id: "sess_ag",
      agent_id: "agent-sub00001",
      kind: "tool_approval",
      dismissible: true,
      allow_chat_override: true,
      items: [
        {
          item_id: "sa1",
          title: "子代理 1 运行测试",
          selection_mode: "approval",
          risk_level: "medium",
          scope_signature: "bash:npm test",
        },
      ],
    };
    const req2: ConfirmationRequestEvent = {
      request_id: "cf_sa_2",
      session_id: "sess_ag",
      agent_id: "agent-sub00002",
      kind: "tool_approval",
      dismissible: true,
      allow_chat_override: true,
      items: [
        {
          item_id: "sa2",
          title: "子代理 2 构建产物",
          selection_mode: "approval",
          risk_level: "low",
          scope_signature: "bash:pnpm build",
        },
      ],
    };

    useConfirmationStore.getState().enqueue(req1);
    useConfirmationStore.getState().enqueue(req2);

    render(<ConfirmationDock sessionId="sess_ag" />);
    expect(screen.getByTestId("charcoal-batch-tabs")).toBeTruthy();
    expect(screen.getByText(/子代理 · sub00001/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Approve all \(2\)/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交全部 \(2\)/ }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledTimes(2);
    });
    const sentIds = submitSpy.mock.calls.map((c) => c[1].request_id).sort();
    expect(sentIds).toEqual(["cf_sa_1", "cf_sa_2"]);
  });

  it("400ms 防误触对每次切换条目重新计时", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const batchReq: ConfirmationRequestEvent = {
      request_id: "cfb_arm",
      session_id: "sess_arm",
      kind: "batch_approval",
      dismissible: true,
      allow_chat_override: true,
      items: [
        { item_id: "a1", title: "第一项", selection_mode: "approval", risk_level: "low" },
        { item_id: "a2", title: "第二项", selection_mode: "approval", risk_level: "low" },
      ],
    };
    useConfirmationStore.getState().enqueue(batchReq);
    render(<ConfirmationDock sessionId="sess_arm" />);
    const dock = screen.getByTestId("confirmation-dock");

    // 过了 500ms 后按 Enter -> 批准第 1 项并切到第 2 项
    now = 1500;
    fireEvent.keyDown(dock, { key: "Enter" });
    expect(useConfirmationStore.getState().bySession["sess_arm"][0].draft.activeIndex).toBe(1);
    expect(
      useConfirmationStore.getState().bySession["sess_arm"][0].draft.batchDecisions?.a1?.decision
    ).toBe("approved");

    // 切换后仅过 100ms 立即再按 Enter -> 必须被 400ms 重计时拦截，a2 不应被批准
    now = 1600;
    fireEvent.keyDown(dock, { key: "Enter" });
    expect(
      useConfirmationStore.getState().bySession["sess_arm"][0].draft.batchDecisions?.a2
    ).toBeUndefined();

    // 再过 450ms 后按 Enter -> 放行批准 a2
    now = 2050;
    fireEvent.keyDown(dock, { key: "Enter" });
    expect(
      useConfirmationStore.getState().bySession["sess_arm"][0].draft.batchDecisions?.a2?.decision
    ).toBe("approved");
  });
});
