"use client";

import React, { useState } from "react";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  language?: string;
  code: string;
}

export function CodeBlock({ language = "plaintext", code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
    }
  };

  const cleanLang = language.replace(/^language-/, "");

  return (
    <div className="my-3 rounded-2xl border border-[#383838]/60 bg-[#242424] overflow-hidden group shadow-sm select-text">
      {/* 顶部状态栏：截图同款 </> lang + 操作项 */}
      <div className="h-9 px-4 flex items-center justify-between select-none">
        <div className="flex items-center gap-2 text-xs font-mono text-[#A1A1AA]">
          <span className="text-[#8E8E93] font-semibold">&lt;/&gt;</span>
          <span className="font-medium text-[#ECECED]">{cleanLang}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-md text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-colors"
            title="复制代码"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-white" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* 代码内容 */}
      <div className="px-4 pb-4 pt-0 overflow-x-auto font-mono text-[13.5px] leading-relaxed text-[#ECECED] scrollbar-thin">
        <pre className="m-0 whitespace-pre">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}
