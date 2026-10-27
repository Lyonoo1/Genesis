"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Globe,
  ChevronDown,
  ExternalLink,
  PanelRight,
  Copy,
  Check,
} from "lucide-react";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { useUIStore } from "@/stores/useUIStore";

interface WebPreviewCardProps {
  url: string;
  title?: string;
  secondaryUrls?: string[];
}

export function WebPreviewCard({ url, title, secondaryUrls = [] }: WebPreviewCardProps) {
  const [currentUrl, setCurrentUrl] = useState(url);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { setPreviewUrl } = useWorkbenchStore();
  const { openRightSidebar } = useUIStore();

  useEffect(() => {
    setCurrentUrl(url);
  }, [url]);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!isDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isDropdownOpen]);

  // 解析简明地址展示
  const formatDisplayHost = (targetUrl: string) => {
    try {
      const parsed = new URL(targetUrl);
      return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      return targetUrl;
    }
  };

  const displayHost = formatDisplayHost(currentUrl);

  // 1. 在工作台右侧打开 (幂等复用，杜绝标签页泄漏)
  const handleOpenWorkbench = (targetUrl = currentUrl, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setIsDropdownOpen(false);
    setPreviewUrl(targetUrl, true);
    openRightSidebar("preview");
  };

  // 2. 在外部浏览器新标签页打开
  const handleOpenExternal = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDropdownOpen(false);
    window.open(currentUrl, "_blank", "noopener,noreferrer");
  };

  // 3. 复制服务地址
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(currentUrl);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      setIsDropdownOpen(false);
    }, 1200);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => handleOpenWorkbench()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleOpenWorkbench();
        }
      }}
      className="group relative w-full h-14 px-3.5 rounded-xl bg-[#202023] hover:bg-[#252529] border border-white/[0.06] hover:border-white/[0.12] transition-all flex items-center justify-between cursor-pointer select-none my-2.5 animate-in fade-in duration-200"
    >
      {/* 左侧：小地球图标 + 标题/打开地址 */}
      <div className="flex items-center gap-3 min-w-0">
        {/* 拟物高质感暗黑图标底座 */}
        <div className="w-9 h-9 rounded-lg bg-[#141416] border border-white/[0.06] flex items-center justify-center shrink-0 shadow-inner">
          <Globe className="w-5 h-5 text-sky-400 stroke-[1.8]" />
        </div>

        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-white group-hover:text-white transition-colors truncate">
            {title || "网页预览"}
          </span>
          <div className="flex items-center gap-1.5 text-xs text-[#8E8E93]">
            <span>打开</span>
            <span className="text-[11px] font-mono text-zinc-400 truncate max-w-[280px]">
              {displayHost}
            </span>
          </div>
        </div>
      </div>

      {/* 右侧：打开方式下拉菜单 */}
      <div className="relative shrink-0 ml-3" ref={dropdownRef}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsDropdownOpen((prev) => !prev);
          }}
          className="h-7 px-3 rounded-full bg-[#2A2A2D] hover:bg-[#343438] text-xs font-normal text-white/90 border border-white/[0.06] flex items-center gap-1 transition-colors cursor-pointer"
        >
          <span>打开方式</span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-[#8E8E93] transition-transform duration-150 ${
              isDropdownOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        {/* 浮层下拉选单 */}
        {isDropdownOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-0 top-full mt-1.5 w-52 rounded-xl bg-[#1C1C1F] border border-white/[0.08] shadow-2xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100 font-sans"
          >
            {/* 选项 1: 在工作台打开 (默认推荐) */}
            <button
              type="button"
              onClick={(e) => handleOpenWorkbench(currentUrl, e)}
              className="w-full px-3 py-2 text-left text-xs text-white hover:bg-white/[0.08] flex items-center gap-2.5 transition-colors cursor-pointer"
            >
              <PanelRight className="w-3.5 h-3.5 text-sky-400" />
              <span>在工作台右侧打开</span>
            </button>

            {/* 选项 2: 在浏览器新标签页打开 */}
            <button
              type="button"
              onClick={handleOpenExternal}
              className="w-full px-3 py-2 text-left text-xs text-[#D4D4D8] hover:bg-white/[0.08] flex items-center gap-2.5 transition-colors cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5 text-[#8E8E93]" />
              <span>在浏览器新标签页打开</span>
            </button>

            {/* 选项 3: 复制地址 */}
            <button
              type="button"
              onClick={handleCopy}
              className="w-full px-3 py-2 text-left text-xs text-[#A1A1AA] hover:bg-white/[0.08] flex items-center justify-between transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-[#8E8E93]" />
                )}
                <span>{copied ? "已复制到剪贴板" : "复制链接地址"}</span>
              </div>
            </button>

            {/* 选项 4: 切换次级端口服务 */}
            {secondaryUrls.length > 0 && (
              <>
                <div className="my-1 border-t border-white/[0.06]" />
                <div className="px-3 py-1 text-[11px] font-medium text-zinc-500">
                  其他可用端口服务
                </div>
                {secondaryUrls.map((sUrl) => (
                  <button
                    key={sUrl}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentUrl(sUrl);
                      handleOpenWorkbench(sUrl, e);
                    }}
                    className="w-full px-3 py-1.5 text-left text-xs text-[#D4D4D8] hover:bg-white/[0.08] flex items-center justify-between transition-colors cursor-pointer"
                  >
                    <span className="font-mono text-zinc-300 truncate max-w-[120px]">
                      {formatDisplayHost(sUrl)}
                    </span>
                    <span className="text-[10px] text-sky-400">切换预览</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
