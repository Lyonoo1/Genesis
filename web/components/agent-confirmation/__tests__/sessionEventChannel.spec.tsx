import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";
import {
  useConfirmationStore,
  buildPlanApprovalEvent,
} from "../store/useConfirmationStore";
import { useSessionEventChannel } from "../engine/useSessionEventChannel";
import type { ConfirmationRequestEvent } from "../types/protocol";

function makeToolReq(id: string, sid = "sess_p2"): ConfirmationRequestEvent {
  return {
    request_id: id,
    session_id: sid,
    kind: "tool_approval",
    dismissible: true,
    allow_chat_override: true,
    timeout_ms: 300000,
    expires_at: new Date(Date.now() + 120000).toISOString(),
    items: [
      {
        item_id: `item_${id}`,
        title: `Run ${id}`,
        selection_mode: "approval",
        risk_level: "medium",
        scope_signature: "bash:npm test",
      },
    ],
  };
}

describe("P2-1 / P2-2 会话事件通道与刷新恢复", () => {
  beforeEach(() => {
    useConfirmationStore.getState().resetStore();
  });

  it("reconcileSnapshot 恢复服务端挂起项、移除已结案项、保留 plan_approval 并合并 sessionStorage 草稿", () => {
    const store = useConfirmationStore.getState();
    const sid = "sess_snap";
    const oldReq = makeToolReq("cf_old", sid);
    const keepReq = makeToolReq("cf_keep", sid);
    const planEv = buildPlanApprovalEvent({
      sessionId: sid,
      planId: "p1",
      plan: "## 计划",
    });

    store.enqueue(oldReq);
    store.enqueue(keepReq);
    store.enqueue(planEv);

    // 模拟刷新前用户在 cf_restored 上写过草稿
    const restoredReq = makeToolReq("cf_restored", sid);
    store.enqueue(restoredReq);
    store.updateDraft(sid, "cf_restored", { codeExpanded: true });
    // 模拟页面刷新：内存状态重置但 sessionStorage 留存
    useConfirmationStore.setState({ bySession: { [sid]: [
      { request: oldReq, draft: useConfirmationStore.getState().bySession[sid][0].draft, status: "AWAITING", receivedAt: Date.now() },
      { request: planEv, draft: useConfirmationStore.getState().bySession[sid][2].draft, status: "AWAITING", receivedAt: Date.now() },
    ] } });

    const serverNow = new Date(Date.now() + 5000).toISOString();
    useConfirmationStore
      .getState()
      .reconcileSnapshot(sid, [restoredReq], serverNow);

    const entries = useConfirmationStore.getState().bySession[sid] ?? [];
    const ids = entries.map((e) => e.request.request_id);
    expect(ids).toContain("plan_p1");
    expect(ids).toContain("cf_restored");
    expect(ids).not.toContain("cf_old");

    const restoredEntry = entries.find(
      (e) => e.request.request_id === "cf_restored"
    );
    expect(restoredEntry?.draft.codeExpanded).toBe(true);
    expect(Math.abs(useConfirmationStore.getState().serverClockOffsetMs - 5000)).toBeLessThan(1000);
  });

  it("useSessionEventChannel 正确分发 snapshot / required / resolved / grants_changed 并在断线后重连", async () => {
    let attempts = 0;
    const mockReader = vi.fn(
      async (
        _endpoint: string,
        opts: { signal?: AbortSignal; onEvent: (ev: string, data: unknown) => void }
      ) => {
        attempts += 1;
        if (attempts === 1) {
          opts.onEvent("confirmation_snapshot", {
            requests: [makeToolReq("cf_1", "sess_chan")],
            grants: ["bash:npm test"],
            server_now: new Date().toISOString(),
          });
          throw new Error("network dropped");
        }
        opts.onEvent("confirmation_required", makeToolReq("cf_2", "sess_chan"));
        opts.onEvent("confirmation_resolved", {
          request_id: "cf_1",
          decision: "approved",
        });
        opts.onEvent("grants_changed", {
          grants: ["bash:npm test", "edit:a.ts"],
        });
        // 保持挂起直到卸载
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    );

    function Harness() {
      useSessionEventChannel("sess_chan", {
        baseRetryMs: 10,
        maxRetryMs: 20,
        reader: mockReader as never,
      });
      return null;
    }

    const { unmount } = render(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(mockReader).toHaveBeenCalledTimes(2);
    const entries = useConfirmationStore.getState().bySession["sess_chan"] ?? [];
    expect(entries.map((e) => e.request.request_id)).toEqual(["cf_2"]);
    expect(useConfirmationStore.getState().grantsBySession["sess_chan"]).toEqual([
      "bash:npm test",
      "edit:a.ts",
    ]);

    unmount();
  });
});
