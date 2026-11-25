import React, { useRef } from "react";
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

function makeToolApprovalEvent(
  riskLevel: "low" | "medium" | "high",
  scopeSignature: string | null = "bash:npm run"
): ConfirmationRequestEvent {
  return {
    request_id: `cf_tool_${riskLevel}`,
    session_id: "sess_kbd",
    kind: "tool_approval",
    dismissible: true,
    allow_chat_override: true,
    timeout_ms: 300_000,
    items: [
      {
        item_id: "item_1",
        tool_call_id: "tc_1",
        title: "允许 Genesis 执行终端命令？",
        review_title: "是否执行以下终端命令？",
        subtitle: "需要用户确认",
        selection_mode: "approval",
        risk_level: riskLevel,
        tool_name: "workspace__execute_command",
        scope_signature: scopeSignature,
        code_preview: { language: "bash", content: "npm run build" },
        custom_input: { enabled: true, mode: "override" },
      },
    ],
  };
}

function makeClarificationSingleEvent(): ConfirmationRequestEvent {
  return {
    request_id: "cf_clarify_kbd",
    session_id: "sess_kbd",
    kind: "clarification",
    dismissible: true,
    allow_chat_override: true,
    timeout_ms: 300_000,
    items: [
      {
        item_id: "q_db",
        title: "选择默认存储引擎",
        selection_mode: "single",
        options: [
          { id: "pg", label: "PostgreSQL", recommended: true },
          { id: "sqlite", label: "SQLite" },
        ],
        custom_input: { enabled: true, mode: "override" },
      },
    ],
  };
}

function Harness({ composerInitialText = "" }: { composerInitialText?: string }) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  return (
    <div>
      <textarea
        data-testid="external-editor"
        defaultValue="monaco-code"
      />
      <ConfirmationDock
        sessionId="sess_kbd"
        composerRef={composerRef}
        composerValue={composerInitialText}
        agentName="Genesis"
      />
      <textarea
        ref={composerRef}
        data-testid="main-composer"
        defaultValue={composerInitialText}
      />
    </div>
  );
}

describe("useDockKeyboard 作用域、IME 与误批准防护", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedSubmit.mockClear();
    useConfirmationStore.getState().resetStore();
    useConfirmationStore.setState({ style: "codex_desktop", hydrated: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("快捷键仅在 Dock focus-within 生效，外部编辑器按 Enter/数字键不影响气泡", () => {
    useConfirmationStore.getState().enqueue(makeToolApprovalEvent("medium"));
    const { getByTestId } = render(<Harness />);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    const editor = getByTestId("external-editor");
    act(() => {
      editor.focus();
    });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.keyDown(editor, { key: "1" });

    expect(mockedSubmit).not.toHaveBeenCalled();
    expect(useConfirmationStore.getState().bySession["sess_kbd"]).toHaveLength(1);
  });

  it("气泡出现后 400ms 内忽略 Enter（防连按穿透），超过 400ms 后普通风险 Enter 触发 Allow once", async () => {
    useConfirmationStore.getState().enqueue(makeToolApprovalEvent("medium"));
    const { getByTestId } = render(<Harness />);
    const dock = getByTestId("confirmation-dock");
    act(() => {
      dock.focus();
    });

    // 400ms 武装期内按 Enter 必须被拦截
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.keyDown(dock, { key: "Enter" });
    expect(mockedSubmit).not.toHaveBeenCalled();

    // 超过 400ms 后按 Enter 触发 Allow once（绝不触发 session）
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      fireEvent.keyDown(dock, { key: "Enter" });
    });
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    expect(mockedSubmit.mock.calls[0][1]).toMatchObject({
      kind: "tool_approval",
      decision: "approved",
      permission_scope: "once",
    });
  });

  it("high 风险操作禁止普通 Enter 批准，仅 ⌘↵ 可触发批准", async () => {
    useConfirmationStore.getState().enqueue(makeToolApprovalEvent("high", null));
    const { getByTestId } = render(<Harness />);
    const dock = getByTestId("confirmation-dock");
    act(() => {
      dock.focus();
      vi.advanceTimersByTime(500);
    });
    fireEvent.keyDown(dock, { key: "Enter" });
    expect(mockedSubmit).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(dock, { key: "Enter", metaKey: true });
    });
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    expect(mockedSubmit.mock.calls[0][1]).toMatchObject({
      decision: "approved",
      permission_scope: "once",
    });
  });

  it("Material 风格高危操作选中「拒绝」后按 ⌘↵ 或 Enter 必须提交 rejected，绝不误批准", async () => {
    useConfirmationStore.setState({ style: "google_aistudio", hydrated: true });
    useConfirmationStore.getState().enqueue(makeToolApprovalEvent("high", null));
    const { getByTestId } = render(<Harness />);
    const dock = getByTestId("confirmation-dock");
    act(() => {
      dock.focus();
      vi.advanceTimersByTime(500);
    });

    // 在 Material 单选审批项中按 ArrowDown 选中「拒绝」（无 session 选项时 index=1）
    fireEvent.keyDown(dock, { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(dock, { key: "Enter", metaKey: true });
    });

    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    expect(mockedSubmit.mock.calls[0][1]).toMatchObject({
      kind: "tool_approval",
      decision: "rejected",
    });
  });

  it("clarification 单选支持 ↑↓ 可见聚焦高亮，按 Enter 直接采纳聚焦项提交而非 skipped_all", async () => {
    useConfirmationStore.getState().enqueue(makeClarificationSingleEvent());
    const { getByTestId } = render(<Harness />);
    const dock = getByTestId("confirmation-dock");
    act(() => {
      dock.focus();
      vi.advanceTimersByTime(500);
    });

    // 默认聚焦第 1 项（PostgreSQL）
    const optionsBox = getByTestId("cf-options-container");
    const buttons = optionsBox.querySelectorAll("button");
    expect(buttons[0].getAttribute("data-cf-focused")).toBe("true");
    expect(buttons[1].getAttribute("data-cf-focused")).toBeNull();

    // 按 ArrowDown 移动焦点到第 2 项（SQLite）并按 Enter 确认
    fireEvent.keyDown(dock, { key: "ArrowDown" });
    expect(buttons[1].getAttribute("data-cf-focused")).toBe("true");

    await act(async () => {
      fireEvent.keyDown(dock, { key: "Enter" });
    });

    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    expect(mockedSubmit.mock.calls[0][1]).toMatchObject({
      kind: "clarification",
      decision: "submitted",
      answers: {
        q_db: {
          status: "answered",
          selected_ids: ["sqlite"],
        },
      },
    });
  });

  it("主输入框聚焦且非空时弹出确认气泡不抢焦点并提示「Tab 进入审批」", () => {
    const { getByTestId, getByText } = render(
      <Harness composerInitialText="我还没打完的草稿" />
    );
    const composer = getByTestId("main-composer");
    act(() => {
      composer.focus();
    });
    expect(document.activeElement).toBe(composer);

    act(() => {
      useConfirmationStore.getState().enqueue(makeToolApprovalEvent("medium"));
    });

    expect(document.activeElement).toBe(composer);
    expect(getByText(/Tab 进入审批/)).toBeTruthy();
  });

  it("IME 中文选词期间按 Enter 不提交、不关闭、不失焦", () => {
    useConfirmationStore.getState().enqueue(makeToolApprovalEvent("medium"));
    const { getByTestId } = render(<Harness />);
    const dock = getByTestId("confirmation-dock");
    const input = dock.querySelector<HTMLInputElement>('[data-cf-field="writein"]')!;
    act(() => {
      input.focus();
      vi.advanceTimersByTime(500);
    });

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(mockedSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    // Safari compositionend 后紧跟的 Enter 也应被 60ms 保护窗拦住
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("两段式 Esc：输入态首次 Esc 仅 blur 回导航态，第二次 Esc 才关闭气泡", async () => {
    useConfirmationStore.getState().enqueue(makeToolApprovalEvent("medium"));
    const { getByTestId } = render(<Harness />);
    const dock = getByTestId("confirmation-dock");
    const input = dock.querySelector<HTMLInputElement>('[data-cf-field="writein"]')!;
    act(() => {
      input.focus();
    });
    expect(document.activeElement).toBe(input);

    // 第一段 Esc：仅退出输入态回到 Dock 导航态，不提交 dismiss
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mockedSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(dock);

    // 第二段 Esc：在导航态才触发 dismiss
    await act(async () => {
      fireEvent.keyDown(dock, { key: "Escape" });
    });
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    expect(mockedSubmit.mock.calls[0][1]).toMatchObject({
      decision: "dismissed",
    });
  });
});
