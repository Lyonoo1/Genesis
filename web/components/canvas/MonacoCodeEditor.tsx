"use client";

import React, { useRef, useEffect, useCallback } from "react";
import Editor, { OnMount, BeforeMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { EditorLoadingSkeleton } from "./EditorLoadingSkeleton";

interface MonacoCodeEditorProps {
  value: string;
  language: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  wordWrap?: boolean;
  minimap?: boolean;
}

export function MonacoCodeEditor({
  value,
  language,
  onChange,
  onSave,
  readOnly = false,
  wordWrap = true,
  minimap = false,
}: MonacoCodeEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  const handleBeforeMount: BeforeMount = (monaco) => {
    // 注入 Genesis 专属极客暗黑主题
    monaco.editor.defineTheme("genesis-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6e7681", fontStyle: "italic" },
        { token: "keyword", foreground: "c586c0" },
        { token: "string", foreground: "ce9178" },
        { token: "number", foreground: "b5cea8" },
        { token: "type", foreground: "4ec9b0" },
        { token: "function", foreground: "dcdcaa" },
        { token: "variable", foreground: "9cdcfe" },
        { token: "tag", foreground: "e06c75" },
        { token: "tag.id", foreground: "e06c75" },
        { token: "tag.class", foreground: "e06c75" },
        { token: "attribute.name", foreground: "9cdcfe" },
        { token: "attribute.value", foreground: "ce9178" },
        { token: "delimiter", foreground: "808080" },
        { token: "delimiter.html", foreground: "808080" },
        { token: "metatag", foreground: "e5c07b" },
      ],
      colors: {
        "editor.background": "#161618",
        "editor.foreground": "#ECECED",
        "editorLineNumber.foreground": "#52525B",
        "editorLineNumber.activeForeground": "#ECECED",
        "editor.lineHighlightBackground": "#1E1E22",
        "editor.selectionBackground": "#264f78",
        "editor.inactiveSelectionBackground": "#3a3d41",
        "editorCursor.foreground": "#58A6FF",
        "editorWhitespace.foreground": "#2E2E32",
        "editorIndentGuide.background": "#242428",
        "editorIndentGuide.activeBackground": "#3A3A40",
      },
    });
  };

  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const handleOnMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monaco.editor.setTheme("genesis-dark");

    // 绑定 ⌘S / Ctrl+S 保存快捷键
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });

    // 聚焦与初始微调
    setTimeout(() => {
      editor.layout();
    }, 50);
  };

  // 响应布局缩放治理 (ResizeObserver 防抖触发 editor.layout())
  const containerRef = useRef<HTMLDivElement>(null);

  const updateLayout = useCallback(() => {
    if (editorRef.current) {
      editorRef.current.layout();
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        updateLayout();
      });
    });

    ro.observe(el);

    return () => {
      ro.disconnect();
    };
  }, [updateLayout]);

  // 响应式动态配置项同步
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({
        wordWrap: wordWrap ? "on" : "off",
        minimap: { enabled: minimap },
        readOnly,
      });
    }
  }, [wordWrap, minimap, readOnly]);

  // 组件卸载时释放 editor 实例防内存泄漏
  useEffect(() => {
    return () => {
      if (editorRef.current) {
        editorRef.current = null;
      }
    };
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full min-h-0 relative bg-[#161618]">
      <Editor
        height="100%"
        width="100%"
        language={language}
        value={value}
        theme="genesis-dark"
        beforeMount={handleBeforeMount}
        onMount={handleOnMount}
        onChange={(val) => onChange(val ?? "")}
        loading={<EditorLoadingSkeleton />}
        options={{
          readOnly,
          wordWrap: wordWrap ? "on" : "off",
          minimap: { enabled: minimap },
          fontSize: 13,
          lineHeight: 21,
          fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, monospace",
          fontLigatures: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          smoothScrolling: true,
          renderLineHighlight: "all",
          lineNumbers: "on",
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: true,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          padding: { top: 12, bottom: 16 },
        }}
      />
    </div>
  );
}
