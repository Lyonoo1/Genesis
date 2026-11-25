"use client";

import { useEffect } from "react";
import { readSSE } from "@/lib/api/streaming";
import { useConfirmationStore } from "../store/useConfirmationStore";
import type {
  ConfirmationRequestEvent,
  ConfirmationResolvedEvent,
} from "../types/protocol";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SessionEventChannelOptions {
  /** 测试环境可覆盖默认退避基数（默认 1000ms） */
  baseRetryMs?: number;
  /** 测试环境可覆盖默认最大退避上限（默认 15000ms） */
  maxRetryMs?: number;
  /** 自定义 SSE 读取器（测试注入用） */
  reader?: typeof readSSE;
}

/**
 * P2-1 / P2-2 会话级长连接事件通道订阅 Hook：
 * - 订阅 GET /api/chat/{sessionId}/events
 * - 首包接收 confirmation_snapshot 实现刷新恢复与时钟同步
 * - 实时接收 confirmation_required / confirmation_resolved / grants_changed 实现多标签页同步
 * - 断线指数退避重连（1s -> 2s -> 4s -> 8s -> 15s）
 */
export function useSessionEventChannel(
  sessionId: string | null | undefined,
  options: SessionEventChannelOptions = {}
) {
  const baseRetryMs = options.baseRetryMs ?? 1000;
  const maxRetryMs = options.maxRetryMs ?? 15000;
  const sseReader = options.reader ?? readSSE;

  useEffect(() => {
    if (!sessionId || sessionId === "default") return;
    let aborted = false;
    let retry = 0;
    let ctrl: AbortController | null = null;
    const lifecycleCtrl = new AbortController();

    const connect = async () => {
      while (!aborted) {
        ctrl = new AbortController();
        try {
          await sseReader(`/api/chat/${encodeURIComponent(sessionId)}/events`, {
            signal: ctrl.signal,
            onEvent: (event, data) => {
              retry = 0;
              const store = useConfirmationStore.getState();
              const payload = (data && typeof data === "object"
                ? data
                : {}) as Record<string, unknown>;

              if (event === "confirmation_snapshot") {
                const requests = Array.isArray(payload.requests)
                  ? (payload.requests as ConfirmationRequestEvent[])
                  : [];
                const serverNow =
                  typeof payload.server_now === "string"
                    ? payload.server_now
                    : undefined;
                store.reconcileSnapshot(sessionId, requests, serverNow);
                if (Array.isArray(payload.grants)) {
                  store.setGrants(
                    sessionId,
                    payload.grants.map((g) => String(g))
                  );
                }
              } else if (event === "confirmation_required") {
                if (payload.request_id) {
                  store.enqueue(payload as unknown as ConfirmationRequestEvent);
                }
              } else if (event === "confirmation_resolved") {
                if (payload.request_id) {
                  store.resolveRemote(
                    payload as unknown as ConfirmationResolvedEvent
                  );
                }
              } else if (event === "grants_changed") {
                if (Array.isArray(payload.grants)) {
                  store.setGrants(
                    sessionId,
                    payload.grants.map((g) => String(g))
                  );
                }
              }
            },
          });
        } catch {
          // 网络错误或连接断开，进入退避重连
        }
        if (aborted) break;
        const delayMs = Math.min(baseRetryMs * 2 ** retry, maxRetryMs);
        retry += 1;
        await sleep(delayMs, lifecycleCtrl.signal);
      }
    };

    connect();
    return () => {
      aborted = true;
      ctrl?.abort();
      lifecycleCtrl.abort();
    };
  }, [sessionId, baseRetryMs, maxRetryMs, sseReader]);
}
