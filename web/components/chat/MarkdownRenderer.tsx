"use client";

import React, { useEffect, useState, useRef, useMemo } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileCode, FileText, ExternalLink } from "lucide-react";
import { CodeBlock } from "./CodeBlock";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useUIStore } from "@/stores/useUIStore";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { useSessionStore } from "@/stores/useSessionStore";

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

// 辅助函数：判断是否是代码文件路径引用（如 auth.ts, .env, AuthController.java, line 48 等）
function isFilePathOrReference(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n")) return false;
  if (trimmed.startsWith("file://")) return true;
  if (/^\.env(\.[a-z0-9_-]+)?$/i.test(trimmed)) return true;
  if (/^Makefile$/i.test(trimmed)) return true;
  return (
    /\.(ts|tsx|js|jsx|py|java|json|env|md|css|html|sql|go|rs|sh|yaml|yml|toml|xml|txt)(\b|:|\s|$)/i.test(
      trimmed
    ) ||
    /\bline\s+\d+\b/i.test(trimmed)
  );
}

// 辅助函数：提取代码块元数据（语言、文件名、文件路径）
function extractCodeMetadata(
  className?: string,
  rawCode: string = "",
  meta?: string
): { language: string; filename?: string; filePath?: string } {
  let language = "plaintext";
  let filename: string | undefined;
  let filePath: string | undefined;

  const match = /language-([^\s]+)/.exec(className || "");
  if (match) {
    const raw = match[1];
    if (raw.includes(":")) {
      const [lang, path] = raw.split(":", 2);
      language = lang;
      filePath = path;
      filename = path.split("/").pop();
    } else {
      language = raw;
    }
  }

  if (meta) {
    const titleMatch = /(?:title|filename|file|path)=["']?([^"'\s]+)["']?/i.exec(meta);
    if (titleMatch) {
      filePath = titleMatch[1];
      filename = filePath.split("/").pop();
    } else if (!filePath && /^[^\s=]+\.[a-zA-Z0-9]+$/.test(meta.trim())) {
      filePath = meta.trim();
      filename = filePath.split("/").pop();
    }
  }

  if (!filePath) {
    const firstLine = rawCode.trim().split("\n")[0] || "";
    const commentMatch = /^(?:\/\/|#|\/\*|--)\s*(?:filepath|file|path|filename):\s*([^\s*]+)/i.exec(firstLine);
    if (commentMatch) {
      filePath = commentMatch[1];
      filename = filePath.split("/").pop();
    }
  }

  if (filePath) {
    filePath = filePath.replace(/["']/g, "").trim();
    filename = filePath.split("/").pop() || filename;
  }
  if (filename) {
    filename = filename.replace(/["']/g, "").trim();
  }

  return { language, filename, filePath };
}

export function MarkdownRenderer({
  content,
  isStreaming = false,
}: MarkdownRendererProps) {
  const { serifReading } = useSettingsStore();

  // 防掉帧节流优化：在流式生成期间每 50ms 批量提交渲染一次，防止高频 parse Markdown AST
  const [renderedContent, setRenderedContent] = useState(content);
  const lastUpdateTimeRef = useRef(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      setRenderedContent(content);
      return;
    }

    const now = Date.now();
    const elapsed = now - lastUpdateTimeRef.current;

    if (elapsed > 50) {
      lastUpdateTimeRef.current = now;
      setRenderedContent(content);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        lastUpdateTimeRef.current = Date.now();
        setRenderedContent(content);
      }, 50 - elapsed);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [content, isStreaming]);

  const handleOpenFile = React.useCallback(async (rawPath: string) => {
    if (!rawPath) return;

    // 1. 展开右侧边栏（如果处于收起状态）
    const uiStore = useUIStore.getState();
    if (!uiStore.isRightSidebarOpen) {
      uiStore.openRightSidebar("files");
    }

    // 2. 清理路径并剥离协议头与行号
    let clean = rawPath.trim();
    clean = clean.replace(/^[(`"']+|[)`"']+$/g, "");
    clean = clean.replace(/(?:#L|:)\d+$/, "");

    if (clean.startsWith("file://")) {
      clean = clean.replace(/^file:\/\//, "");
      const markerIdx = clean.indexOf("agentProject/");
      if (markerIdx !== -1) {
        clean = clean.slice(markerIdx + "agentProject/".length);
      } else {
        const genesisIdx = clean.indexOf("Genesis/");
        if (genesisIdx !== -1) {
          clean = clean.slice(genesisIdx);
        }
      }
    }

    clean = clean.replace(/^\/+/, "");
    const fileName = clean.split("/").pop() || clean;

    // 3. 异步尝试读取本地磁盘真实内容
    let content = "";
    try {
      const { getDirectoryHandle, readLocalFile, scanDirectory } = await import(
        "@/lib/workspace/localWorkspaceManager"
      );
      const activeSession = useSessionStore.getState().sessions.find(
        (s) => s.id === useSessionStore.getState().activeSessionId
      );
      const targetKey = activeSession?.project_id || "genesis-default-workspace";
      let handle = await getDirectoryHandle(targetKey);
      if (!handle && targetKey !== "genesis-default-workspace") {
        handle = await getDirectoryHandle("genesis-default-workspace");
      }

      if (handle) {
        // 若只有纯文件名，在目录树中智能反查其完整相对路径
        if (!clean.includes("/")) {
          try {
            const tree = await scanDirectory(handle, "", 0, 4);
            const findPath = (nodes: any[]): string | null => {
              for (const n of nodes) {
                if (n.kind === "file" && (n.name === clean || n.path.endsWith("/" + clean))) {
                  return n.path;
                }
                if (n.children) {
                  const p = findPath(n.children);
                  if (p) return p;
                }
              }
              return null;
            };
            const matched = findPath(tree);
            if (matched) {
              clean = matched;
            }
          } catch {}
        }

        try {
          const fileRes = await readLocalFile(handle, clean);
          content = fileRes.content;
        } catch {
          if (clean.startsWith("Genesis/")) {
            const sub = clean.replace(/^Genesis\//, "");
            try {
              const fileRes = await readLocalFile(handle, sub);
              content = fileRes.content;
              clean = sub;
            } catch {}
          }
        }
      }
    } catch (err) {
      console.warn("[MarkdownRenderer] 读取本地文件失败，采用空模板打开:", err);
    }

    // 4. 调用工作台调度器打开或激活该文件 Tab
    const workbench = useWorkbenchStore.getState();
    workbench.openFileInExplorer({
      filePath: clean,
      title: fileName,
      content: content || `// ${clean}\n// (从工作区加载中...)`,
    });
  }, []);

  const components: Components = useMemo(
    () => ({
      code({
        node,
        className,
        children,
        ...props
      }: React.ComponentPropsWithoutRef<"code"> & {
        node?: { data?: { meta?: string | null } };
      }) {
        const match = /language-(\w+)/.exec(className || "");
        const isInline = !match && !String(children).includes("\n");

        if (isInline) {
          const textContent = String(children);
          const isFileRef = isFilePathOrReference(textContent);

          if (isFileRef) {
            return (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleOpenFile(textContent);
                }}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 my-0.5 rounded-[5px] bg-[#1E2430] hover:bg-[#283852] border border-[#2A4365]/60 hover:border-[#3B82F6]/60 text-[#60A5FA] hover:text-white font-mono text-[13px] transition-all shadow-sm cursor-pointer group select-none text-left"
                title={`点击在工作台中预览：${textContent}`}
              >
                <FileCode className="w-3.5 h-3.5 text-[#60A5FA] group-hover:text-blue-300 shrink-0 group-hover:scale-105 transition-transform" />
                <span className="leading-none underline decoration-transparent group-hover:decoration-blue-400/50 underline-offset-2 transition-all">
                  {children}
                </span>
              </button>
            );
          }

          return (
            <code
              className="font-mono text-[13px] px-1.5 py-0.5 rounded-[5px] bg-[#2A2A2A] text-white border border-white/[0.08] mx-0.5 font-normal"
              {...props}
            >
              {children}
            </code>
          );
        }

        const codeString = String(children).replace(/\n$/, "");
        const meta = node?.data?.meta;
        const { language, filename, filePath } = extractCodeMetadata(
          className,
          codeString,
          meta || undefined
        );

        return (
          <CodeBlock
            language={language}
            code={codeString}
            filename={filename}
            filePath={filePath}
          />
        );
      },

      p({ children }) {
        return (
          <p className="mb-3.5 last:mb-0 leading-[1.75] text-[#ECECED]">
            {children}
          </p>
        );
      },

      strong({ children }) {
        return <strong className="font-semibold text-white">{children}</strong>;
      },

      blockquote({ children }) {
        return (
          <blockquote className="border-l-2 border-[#3E3E48] pl-3.5 my-3.5 italic text-[#9E9EA8] bg-white/[0.02] py-1 rounded-r">
            {children}
          </blockquote>
        );
      },

      table({ children }) {
        return (
          <div className="my-4 overflow-x-auto rounded-xl border border-hairline/80 shadow-md">
            <table className="w-full border-collapse text-xs text-left">
              {children}
            </table>
          </div>
        );
      },

      thead({ children }) {
        return (
          <thead className="bg-[#1C1C20] border-b border-hairline text-white font-medium">
            {children}
          </thead>
        );
      },

      th({ children }) {
        return (
          <th className="p-2.5 font-medium border-r border-hairline/60 last:border-r-0">
            {children}
          </th>
        );
      },

      td({ children }) {
        return (
          <td className="p-2.5 border-t border-hairline/60 border-r border-hairline/60 last:border-r-0 text-[#A1A1AA]">
            {children}
          </td>
        );
      },

      ul({ children }) {
        return (
          <ul className="list-disc pl-5 my-3 space-y-2 text-[#ECECED] marker:text-[#6E6E78]">
            {children}
          </ul>
        );
      },

      ol({ children }) {
        return (
          <ol className="list-decimal pl-5 my-3 space-y-2 text-[#ECECED] marker:text-[#6E6E78]">
            {children}
          </ol>
        );
      },

      li({ children }) {
        return <li className="leading-[1.75]">{children}</li>;
      },

      h1({ children }) {
        return (
          <h1 className="text-xl font-semibold tracking-tight text-white mt-6 mb-3 border-b border-hairline pb-1.5 font-sans">
            {children}
          </h1>
        );
      },

      h2({ children }) {
        return (
          <h2 className="text-lg font-semibold tracking-tight text-white mt-5 mb-2.5 font-sans">
            {children}
          </h2>
        );
      },

      h3({ children }) {
        return (
          <h3 className="text-base font-semibold text-white mt-4 mb-2 font-sans">
            {children}
          </h3>
        );
      },

      hr() {
        return <hr className="my-6 border-t border-hairline/60" />;
      },

      a({ href, children }) {
        const textContent = String(children);
        const isFile = isFilePathOrReference(textContent) || (href ? isFilePathOrReference(href) : false);

        if (isFile) {
          const targetPath = href && href.startsWith("file://") ? href : textContent;
          return (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleOpenFile(targetPath);
              }}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[5px] bg-[#1E2430] hover:bg-[#283852] border border-[#2B4C7E]/50 hover:border-[#3B82F6]/60 text-[#58A6FF] hover:text-white font-mono text-[13px] transition-all my-0.5 shadow-sm group cursor-pointer select-none text-left"
              title={`点击在工作台中预览：${textContent}`}
            >
              <FileText className="w-3.5 h-3.5 text-[#58A6FF] group-hover:text-blue-300 shrink-0 group-hover:scale-105 transition-transform" />
              <span className="underline decoration-transparent group-hover:decoration-blue-400/50 underline-offset-2 transition-all">
                {children}
              </span>
            </button>
          );
        }

        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-[#58A6FF] hover:text-[#79B8FF] underline underline-offset-4 decoration-[#58A6FF]/40 hover:decoration-[#58A6FF] transition-colors inline-flex items-center gap-0.5"
          >
            <span>{children}</span>
            <ExternalLink className="w-3 h-3 opacity-60 ml-0.5" />
          </a>
        );
      },
    }),
    [handleOpenFile]
  );

  return (
    <div
      className={`prose-invert max-w-none text-[15px] leading-[1.75] transition-all duration-150 ${
        serifReading ? "font-serif tracking-normal" : "font-sans tracking-normal"
      }`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {renderedContent}
      </ReactMarkdown>
      {/* 流式生成实时光标 */}
      {isStreaming && (
        <span
          className="inline-block w-1.5 h-4 ml-1 bg-[#58A6FF] align-middle rounded-sm animate-pulse"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

