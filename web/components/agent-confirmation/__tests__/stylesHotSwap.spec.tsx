import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { ConfirmationDock } from "../ConfirmationDock";
import { useConfirmationStore } from "../store/useConfirmationStore";
import type { ConfirmationRequestEvent } from "../types/protocol";

vi.mock("../engine/transport", () => ({
  submitConfirmation: vi.fn().mockResolvedValue({ success: true }),
  fetchSessionGrants: vi.fn().mockResolvedValue([]),
  clearSessionGrants: vi.fn().mockResolvedValue(undefined),
}));

function makeLongDiffApproval(): ConfirmationRequestEvent {
  const lines = [
    "--- a/src/server.ts",
    "+++ b/src/server.ts",
    "@@ -1,10 +1,12 @@",
    " import express from 'express';",
    "-const PORT = 3000;",
    "+const PORT = Number(process.env.PORT || 8080);",
    " const app = express();",
    "+app.use(express.json());",
    " app.get('/health', (_req, res) => {",
    "   res.json({ ok: true });",
    " });",
    " app.listen(PORT, () => {",
    "   console.log('ready');",
    " });",
  ].join("\n");

  return {
    request_id: "cf_swap_diff",
    session_id: "sess_swap",
    kind: "tool_approval",
    dismissible: true,
    allow_chat_override: true,
    timeout_ms: 300_000,
    items: [
      {
        item_id: "item_diff",
        tool_call_id: "tc_diff",
        title: "允许 Genesis 修改 src/server.ts？",
        review_title: "是否应用以下文件变更？",
        subtitle: "全量审阅模式",
        selection_mode: "approval",
        risk_level: "medium",
        tool_name: "workspace__edit_file",
        diff_stat: "+2 -1",
        scope_signature: "edit:src/server.ts",
        code_preview: {
          language: "diff",
          filename: "src/server.ts",
          content: lines,
        },
        custom_input: { enabled: true, mode: "override" },
      },
    ],
  };
}

function makeFormEvent(): ConfirmationRequestEvent {
  return {
    request_id: "cf_swap_form",
    session_id: "sess_swap",
    kind: "parameter_form",
    dismissible: true,
    allow_chat_override: true,
    timeout_ms: 300_000,
    items: [
      {
        item_id: "form_1",
        title: "配置部署参数",
        selection_mode: "form",
        form_fields: [
          {
            key: "env",
            label: "目标环境",
            type: "text",
            required: true,
            placeholder: "staging / prod",
          },
          {
            key: "extra",
            label: "扩展配置 JSON",
            type: "json",
            required: false,
          },
        ],
      },
    ],
  };
}

describe("三套独立风格热切换：100% 保留草稿、展开态、表单值与输入框焦点", () => {
  beforeEach(() => {
    useConfirmationStore.getState().resetStore();
    useConfirmationStore.setState({ style: "codex_desktop", hydrated: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("在 Charcoal -> Parchment -> Material 之间通过右上角热切换按钮循环切换，保留代码展开态、写回文本与输入框焦点", () => {
    useConfirmationStore.getState().enqueue(makeLongDiffApproval());
    const { getByTestId, getByText, getByLabelText } = render(
      <ConfirmationDock sessionId="sess_swap" agentName="Genesis" />
    );

    // 1. 初始为 Charcoal：存在「等待审批」与默认 8 行折叠后的「展开审阅」
    expect(getByTestId("confirmation-dock").getAttribute("data-confirm-style")).toBe(
      "codex_desktop"
    );
    expect(getByText("等待审批")).toBeTruthy();
    fireEvent.click(getByText("展开审阅"));
    expect(getByText("收起审阅")).toBeTruthy();

    // 在 write-in 输入框中输入文本并保持焦点
    const inputCharcoal = getByTestId("confirmation-dock").querySelector<HTMLInputElement>(
      '[data-cf-field="writein"]'
    )!;
    act(() => {
      inputCharcoal.focus();
    });
    fireEvent.change(inputCharcoal, { target: { value: "保留默认端口 3000" } });
    expect(document.activeElement).toBe(inputCharcoal);

    // 2. 点击右上角极简热切换按钮 -> 切到 Parchment（claude_desktop）
    fireEvent.click(getByLabelText("切换气泡风格"));
    expect(getByTestId("confirmation-dock").getAttribute("data-confirm-style")).toBe(
      "claude_desktop"
    );
    expect(getByText("✳")).toBeTruthy();
    const inputParchment = getByTestId("confirmation-dock").querySelector<HTMLInputElement>(
      '[data-cf-field="writein"]'
    )!;
    expect(inputParchment.value).toBe("保留默认端口 3000");
    // 焦点与光标位置自动还原到末尾
    expect(document.activeElement).toBe(inputParchment);
    expect(inputParchment.selectionStart).toBe("保留默认端口 3000".length);

    // 3. 再次点击右上角热切换 -> 切到 Material（google_aistudio）
    fireEvent.click(getByLabelText("切换气泡风格"));
    expect(getByTestId("confirmation-dock").getAttribute("data-confirm-style")).toBe(
      "google_aistudio"
    );
    expect(getByText("✦")).toBeTruthy();
    const inputMaterial = getByTestId("confirmation-dock").querySelector<HTMLInputElement>(
      '[data-cf-field="writein"]'
    )!;
    expect(inputMaterial.value).toBe("保留默认端口 3000");
    expect(document.activeElement).toBe(inputMaterial);

    // 4. 切回 Charcoal -> 展开态「收起审阅」依然 100% 保留！
    fireEvent.click(getByLabelText("切换气泡风格"));
    expect(getByTestId("confirmation-dock").getAttribute("data-confirm-style")).toBe(
      "codex_desktop"
    );
    expect(getByText("收起审阅")).toBeTruthy();
  });

  it("导航态（无输入框聚焦）通过右上角按钮热切换三套风格时，Dock 保持焦点不脱落到 body", () => {
    useConfirmationStore.getState().enqueue(makeLongDiffApproval());
    const { getByTestId, getByLabelText } = render(
      <ConfirmationDock sessionId="sess_swap" agentName="Genesis" />
    );

    const dock = getByTestId("confirmation-dock");
    // 模拟用户先聚焦在旧风格的按钮上再触发热切换（旧按钮即将被卸载）
    const swapBtn = getByLabelText("切换气泡风格");
    act(() => {
      swapBtn.focus();
    });
    expect(dock.contains(document.activeElement)).toBe(true);

    fireEvent.click(swapBtn);
    expect(dock.getAttribute("data-confirm-style")).toBe("claude_desktop");
    // 旧风格按钮卸载后，焦点被自动归还给 Dock 根节点而非掉回 document.body
    expect(dock.contains(document.activeElement)).toBe(true);
  });

  it("表单场景下热切换三套风格，完整保留表单字段值、实时 JSON 错误与当前聚焦字段", () => {
    useConfirmationStore.getState().enqueue(makeFormEvent());
    const { getByTestId, getByText } = render(
      <ConfirmationDock sessionId="sess_swap" agentName="Genesis" />
    );

    const envInput = getByTestId("confirmation-dock").querySelector<HTMLInputElement>(
      '[data-cf-field="field:env"]'
    )!;
    const jsonInput = getByTestId("confirmation-dock").querySelector<HTMLTextAreaElement>(
      '[data-cf-field="field:extra"]'
    )!;

    fireEvent.change(envInput, { target: { value: "production" } });
    act(() => {
      jsonInput.focus();
    });
    fireEvent.change(jsonInput, { target: { value: "{\n  bad_json\n}" } });

    // JSON 语法实时错误应含行号提示
    expect(getByText(/JSON 语法错误/)).toBeTruthy();

    // 切到 Parchment 与 Material，表单值、JSON 错误与聚焦字段均保留
    act(() => {
      useConfirmationStore.getState().setStyle("claude_desktop");
    });
    const jsonParchment = getByTestId("confirmation-dock").querySelector<HTMLTextAreaElement>(
      '[data-cf-field="field:extra"]'
    )!;
    expect(
      getByTestId("confirmation-dock").querySelector<HTMLInputElement>(
        '[data-cf-field="field:env"]'
      )?.value
    ).toBe("production");
    expect(jsonParchment.value).toBe("{\n  bad_json\n}");
    expect(document.activeElement).toBe(jsonParchment);
    expect(getByText(/JSON 语法错误/)).toBeTruthy();

    act(() => {
      useConfirmationStore.getState().setStyle("google_aistudio");
    });
    const jsonMaterial = getByTestId("confirmation-dock").querySelector<HTMLTextAreaElement>(
      '[data-cf-field="field:extra"]'
    )!;
    expect(jsonMaterial.value).toBe("{\n  bad_json\n}");
    expect(document.activeElement).toBe(jsonMaterial);
  });

  it("点击右上角最小化按钮可折叠为紧凑条且不关闭请求，点击展开后完整保留草稿", () => {
    useConfirmationStore.getState().enqueue(makeLongDiffApproval());
    const { getByLabelText, getByTestId, queryByTestId } = render(
      <ConfirmationDock sessionId="sess_swap" agentName="Genesis" />
    );

    const writeIn = getByTestId("confirmation-dock").querySelector<HTMLInputElement>(
      '[data-cf-field="writein"]'
    )!;
    fireEvent.change(writeIn, { target: { value: "稍后再确认" } });

    // 点击右上角最小化图标
    fireEvent.click(getByLabelText("最小化确认卡片"));
    expect(getByTestId("cf-minimized-bar")).toBeTruthy();
    // 队列未关闭/未提交
    expect(useConfirmationStore.getState().bySession.sess_swap?.length).toBe(1);

    // 最小化态热切换风格依然保持最小化条
    act(() => {
      useConfirmationStore.getState().setStyle("claude_desktop");
    });
    expect(getByTestId("cf-minimized-bar")).toBeTruthy();

    // 点击展开恢复完整气泡，草稿原样保留
    fireEvent.click(getByLabelText("展开确认卡片"));
    expect(queryByTestId("cf-minimized-bar")).toBeNull();
    const restoredWriteIn = getByTestId(
      "confirmation-dock"
    ).querySelector<HTMLInputElement>('[data-cf-field="writein"]')!;
    expect(restoredWriteIn.value).toBe("稍后再确认");
  });
});
