"use client";

import React, { useRef, useEffect, useCallback } from "react";
import { DiffEditor, DiffOnMount, BeforeMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { EditorLoadingSkeleton } from "./EditorLoadingSkeleton";

interface MonacoDiffEditorProps {
  original: string;
  modified: string;
  language: string;
  diffLayout: "split" | "inline";
  wordWrap?: boolean;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}

export function MonacoDiffEditor({
  original,
  modified,
  language,
  diffLayout,
  wordWrap = true,
  readOnly = false,
  onChange,
}: MonacoDiffEditorProps) {
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);

  const handleBeforeMount: BeforeMount = (monaco) => {
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
        "diffEditor.insertedTextBackground": "#2ea04333",
        "diffEditor.removedTextBackground": "#f8514933",
        "diffEditor.insertedLineBackground": "#2ea0431a",
        "diffEditor.removedLineBackground": "#f851491a",
      },
    });
  };

  const handleOnMount: DiffOnMount = (editor, monaco) => {
    diffEditorRef.current = editor;
    monaco.editor.setTheme("genesis-dark");

    const modifiedEditor = editor.getModifiedEditor();
    if (onChange) {
      modifiedEditor.onDidChangeModelContent(() => {
        onChange(modifiedEditor.getValue());
      });
    }

    setTimeout(() => {
      editor.layout();
    }, 50);
  };

  const containerRef = useRef<HTMLDivElement>(null);

  const updateLayout = useCallback(() => {
    if (diffEditorRef.current) {
      diffEditorRef.current.layout();
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

  // 动态更新分栏布局与换行选项
  useEffect(() => {
    if (diffEditorRef.current) {
      diffEditorRef.current.updateOptions({
        renderSideBySide: diffLayout === "split",
        wordWrap: wordWrap ? "on" : "off",
        readOnly,
      });
    }
  }, [diffLayout, wordWrap, readOnly]);

  useEffect(() => {
    return () => {
      if (diffEditorRef.current) {
        diffEditorRef.current = null;
      }
    };
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full min-h-0 relative bg-[#161618]">
      <DiffEditor
        height="100%"
        width="100%"
        language={language}
        original={original}
        modified={modified}
        theme="genesis-dark"
        beforeMount={handleBeforeMount}
        onMount={handleOnMount}
        loading={<EditorLoadingSkeleton />}
        options={{
          readOnly,
          originalEditable: false,
          renderSideBySide: diffLayout === "split",
          wordWrap: wordWrap ? "on" : "off",
          fontSize: 13,
          lineHeight: 21,
          fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, monospace",
          fontLigatures: true,
          smoothScrolling: true,
          renderLineHighlight: "all",
          lineNumbers: "on",
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          padding: { top: 12, bottom: 16 },
        }}
      />
    </div>
  );
}
