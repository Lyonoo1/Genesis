import { useEffect } from "react";
import { useChatStore } from "@/stores/useChatStore";
import { AgentLifecycleState } from "@/types/stream";
import {
  buildPlanApprovalEvent,
  useConfirmationStore,
} from "../store/useConfirmationStore";

/**
 * 把既有 Plan 模式生命周期（AWAITING_PLAN_APPROVAL + proposedPlan）桥接为 plan_approval 确认请求：
 * - 进入待审批态且队列里还没有对应请求时入队（覆盖刷新 / 切会话回来的场景）
 * - 离开待审批态（已批准 / 已回到 Plan 修订 / 会话被重置）时立刻移除
 * 状态来源仍是 useChatStore，气泡只是它的唯一呈现层。
 */
export function usePlanApprovalBridge(
  sessionId: string | null | undefined,
  agentName: string = "Genesis"
) {
  const lifecycle = useChatStore((s) =>
    sessionId ? s.lifecycleStateBySession[sessionId] : undefined
  );
  const proposedPlan = useChatStore((s) =>
    sessionId ? s.proposedPlanBySession[sessionId] ?? null : null
  );

  const awaiting =
    lifecycle === AgentLifecycleState.AWAITING_PLAN_APPROVAL &&
    Boolean(proposedPlan);
  const planId = proposedPlan?.planId;
  const planText = proposedPlan?.plan;

  useEffect(() => {
    if (!sessionId) return;
    const store = useConfirmationStore.getState();
    if (!awaiting || !planId) {
      store.removeByKind(sessionId, "plan_approval");
      return;
    }
    const requestId = `plan_${planId}`;
    const exists = (store.bySession[sessionId] || []).some(
      (e) => e.request.request_id === requestId
    );
    if (!exists) {
      // 计划被修订后 planId 变化：先清掉旧卡再入队新卡
      store.removeByKind(sessionId, "plan_approval");
      store.enqueue(
        buildPlanApprovalEvent({
          sessionId,
          planId,
          plan: planText || "",
          agentName,
        })
      );
    }
  }, [sessionId, awaiting, planId, planText, agentName]);
}
