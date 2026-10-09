"use client";

import React, { useEffect, useState, useRef, useMemo } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileCode, FileText, ExternalLink } from "lucide-react";
import { CodeBlock } from "./CodeBlock";
import { useSettingsStore } from "@/stores/useSettingsStore";

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

// 辅助函数：判断是否是代码文件路径引用（如 auth.ts, .env, AuthController.java, line 48 等）
function isFilePathOrReference(text: string): boolean {
  return (
    /\.(ts|tsx|js|jsx|py|java|json|env|md|css|html|sql|go|rs|sh|yaml|yml)(\b|:|\s)/i.test(
      text
    ) ||
    /\bline\s+\d+\b/i.test(text) ||
    /^\.env/i.test(text)
  );
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

  const components: Components = useMemo(
    () => ({
      code({ className, children, ...props }) {
        const match = /language-(\w+)/.exec(className || "");
        const isInline = !match && !String(children).includes("\n");

        if (isInline) {
          const textContent = String(children);
          const isFileRef = isFilePathOrReference(textContent);

          if (isFileRef) {
            return (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 my-0.5 rounded-[5px] bg-[#1E2430] border border-[#2A4365]/60 text-[#60A5FA] font-mono text-[13px] hover:bg-[#233044] transition-colors shadow-sm">
                <FileCode className="w-3.5 h-3.5 text-[#60A5FA] shrink-0" />
                <span className="leading-none">{children}</span>
              </span>
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

        const language = match ? match[1] : "plaintext";
        const codeString = String(children).replace(/\n$/, "");

        return <CodeBlock language={language} code={codeString} />;
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
        const isFile = isFilePathOrReference(textContent);

        if (isFile) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[5px] bg-[#1E2430] hover:bg-[#253247] border border-[#2B4C7E]/50 text-[#58A6FF] hover:text-[#79B8FF] font-mono text-[13px] transition-all my-0.5 shadow-sm group"
            >
              <FileText className="w-3.5 h-3.5 text-[#58A6FF] shrink-0 group-hover:scale-105 transition-transform" />
              <span>{children}</span>
            </a>
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
    []
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

