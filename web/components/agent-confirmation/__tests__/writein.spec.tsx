import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { ConfirmationDock } from "../ConfirmationDock";
import { useConfirmationStore } from "../store/useConfirmationStore";
import { submitConfirmation } from "../engine/transport";
import type { ConfirmationRequestEvent } from "../types/protocol";

vi.mock("../engine/transport", () => ({
  submitConfirmation: vi.fn().mockResolvedValue({ success: true }),
  fetchSessionGrants: vi.fn().mockResolvedValue([]),
  clearSessionGrants: vi.fn().mockResolvedValue(undefined),
}));

const mockedSubmit = vi.mocked(submitConfirmation);

function makeClarificationEvent(): ConfirmationRequestEvent {
  return {
    request_id: "cf_clarify_1",
    session_id: "sess_wi",
    kind: "clarification",
    dismissible: true,
    allow_chat_override: true,
    timeout_ms: 300_000,
    items: [
      {
        item_id: "q1",
        title: "第一步：选择数据库引擎",
        selection_mode: "single",
        auto_advance: true,
        options: [
          { id: "pg", label: "PostgreSQL", recommended: true },
          { id: "sqlite", label: "SQLite" },
        ],
        custom_input: { enabled: true, mode: "override" },
      },
      {
        item_id: "q2",
        title: "第二步：选择需要开启的特性",
        selection_mode: "multi",
        options: [
          { id: "auth", label: "身份认证", recommended: true },
          { id: "audit", label: "操作审计" },
        ],
        custom_input: { enabled: true, mode: "append" },
      },
    ],
  };
}

describe("Write-In (override / append) 与单选 220ms 防竞态 / 多选不自动翻页", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedSubmit.mockClear();
    useConfirmationStore.getState().resetStore();
    useConfirmationStore.setState({ style: "google_aistudio", hydrated: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("override 模式：非空降暗 0.38 且显示「已覆盖上方预设」，清空恢复，提交时 selected_ids 为空", async () => {
    useConfirmationStore.getState().enqueue(makeClarificationEvent());
    const { getByTestId, getByText, queryByText } = render(
      <ConfirmationDock sessionId="sess_wi" agentName="Genesis" />
    );

    const optionsBox = getByTestId("cf-options-container");
    const writein = getByTestId("confirmation-dock").querySelector<HTMLInputElement>(
      '[data-cf-field="writein"]'
    )!;

    // 先选预设再改输入自定义文本（并跳过自动翻页保持在第 1 题）
    fireEvent.click(getByText("PostgreSQL"));
    fireEvent.change(writein, { target: { value: "改用 DuckDB 本地分析库" } });

    // override 激活：上方选项容器 opacity 必须降至 0.38，且出现提示
    expect(optionsBox.style.opacity).toBe("0.38");
    expect(getByText("已覆盖上方预设")).toBeTruthy();

    // 220ms 定时器已被用户输入清空，不会误翻页
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(getByText("第一步：选择数据库引擎")).toBeTruthy();

    // 清空后恢复 1
    fireEvent.change(writein, { target: { value: "" } });
    expect(optionsBox.style.opacity).toBe("1");
    expect(queryByText("已覆盖上方预设")).toBeNull();

    // 再次填入自定义文本并切到第 2 题提交，验证 q1 的 selected_ids 为空且带 custom_text
    fireEvent.change(writein, { target: { value: "使用 DuckDB" } });
    fireEvent.click(getByText("下一步"));
    await act(async () => {
      fireEvent.click(getByText("提交"));
    });

    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    const payload = mockedSubmit.mock.calls[0][1];
    expect(payload.kind).toBe("clarification");
    if (payload.kind === "clarification") {
      expect(payload.answers["q1"]).toMatchObject({
        status: "answered",
        selected_ids: [],
        custom_text: "使用 DuckDB",
        custom_mode: "override",
      });
    }
  });

  it("单选 220ms 自动推进且支持手动翻页/切风格防竞态；多选绝不自动翻页且支持 append 双字段提交", async () => {
    useConfirmationStore.getState().enqueue(makeClarificationEvent());
    const { getByTestId, getByText } = render(
      <ConfirmationDock sessionId="sess_wi" agentName="Genesis" />
    );

    // 1. 点击第 1 题单选 -> 220ms 后自动推进到第 2 题
    fireEvent.click(getByText("PostgreSQL"));
    expect(getByText("第一步：选择数据库引擎")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(230);
    });
    expect(getByText("第二步：选择需要开启的特性")).toBeTruthy();

    // 2. 第 2 题为多选：连续勾选两项，绝不自动翻页/提交
    fireEvent.click(getByText("身份认证"));
    fireEvent.click(getByText("操作审计"));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(mockedSubmit).not.toHaveBeenCalled();

    // 3. 多选 append 附加文本：展示「+ 附加至已选 2 项」，提交包含 selected_ids 与 custom_text
    const writein = getByTestId("confirmation-dock").querySelector<HTMLInputElement>(
      '[data-cf-field="writein"]'
    )!;
    fireEvent.change(writein, { target: { value: "审计日志保留 90 天" } });
    expect(getByText("+ 附加至已选 2 项")).toBeTruthy();

    await act(async () => {
      fireEvent.click(getByText("提交"));
    });
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    const payload = mockedSubmit.mock.calls[0][1];
    if (payload.kind === "clarification") {
      expect(payload.answers["q1"].selected_ids).toEqual(["pg"]);
      expect(payload.answers["q2"]).toMatchObject({
        status: "answered",
        selected_ids: ["auth", "audit"],
        custom_text: "审计日志保留 90 天",
        custom_mode: "append",
      });
    }
  });

  it("单选 220ms 期间用户切风格时 clearTimeout 防止竞态误翻页", () => {
    useConfirmationStore.getState().enqueue(makeClarificationEvent());
    const { getByText } = render(
      <ConfirmationDock sessionId="sess_wi" agentName="Genesis" />
    );

    fireEvent.click(getByText("SQLite"));
    act(() => {
      vi.advanceTimersByTime(100);
      useConfirmationStore.getState().setStyle("claude_desktop");
      vi.advanceTimersByTime(300);
    });

    // 仍停留在第 1 题，未被旧定时器误翻到第 2 题
    expect(getByText("第一步：选择数据库引擎")).toBeTruthy();
  });
});
