"use client";

import React from "react";

interface CodeEditorFallbackProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

export function CodeEditorFallback({
  value,
  onChange,
  readOnly = false,
}: CodeEditorFallbackProps) {
  const lines = value.split("\n");
  const lineNumbersRef = React.useRef<HTMLDivElement>(null);

  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  };

  return (
    <div className="flex-1 w-full h-full flex flex-col bg-[#161618] text-[#ECECED] font-mono text-[13px] overflow-hidden select-text">
      <div className="px-3 py-1 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-[11px] flex items-center justify-between select-none font-sans">
        <span>当前运行于轻量行号编辑器容错模式</span>
      </div>
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* 行号侧栏 */}
        <div
          ref={lineNumbersRef}
          className="w-12 py-3 bg-[#131315] border-r border-[#262629] text-right pr-3 select-none text-[#52525B] shrink-0 overflow-hidden font-mono text-[11px]"
        >
          {lines.map((_, i) => (
            <div key={i} className="leading-5">
              {i + 1}
            </div>
          ))}
        </div>

        {/* 文本输入区 */}
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={handleScroll}
          readOnly={readOnly}
          spellCheck={false}
          className="flex-1 p-3 bg-transparent text-[#ECECED] resize-none outline-none font-mono text-[13px] leading-5 whitespace-pre overflow-auto scrollbar-thin select-text"
        />
      </div>
    </div>
  );
}
