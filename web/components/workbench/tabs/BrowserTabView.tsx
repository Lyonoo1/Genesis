"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  ShieldAlert,
  AlertTriangle,
  Sparkles,
  X,
} from "lucide-react";
import { NewTabPage } from "./NewTabPage";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { useChatStore } from "@/stores/useChatStore";
import { useSessionStore } from "@/stores/useSessionStore";

interface BrowserTabViewProps {
  initialUrl?: string;
}

interface CapturedError {
  id: string;
  type: string;
  message: string;
  stack?: string;
  timestamp: number;
}

export function BrowserTabView({ initialUrl = "genesis://newtab" }: BrowserTabViewProps) {
  const { reloadTrigger, setPreviewUrl } = useWorkbenchStore();
  const [currentUrl, setCurrentUrl] = useState(initialUrl || "genesis://newtab");
  const [inputUrl, setInputUrl] = useState(
    currentUrl === "genesis://newtab" ? "" : currentUrl
  );
  const [errors, setErrors] = useState<CapturedError[]>([]);
  const [isSubmittingFix, setIsSubmittingFix] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastTriggerRef = useRef(reloadTrigger);
  const currentUrlRef = useRef(currentUrl);

  useEffect(() => {
    currentUrlRef.current = currentUrl;
  }, [currentUrl]);

  // 同步外部 initialUrl 变更 (仅当 tab 自身的 URL 改变时更新，不被全局 previewUrl 篡改)
  useEffect(() => {
    if (initialUrl && initialUrl !== currentUrl) {
      setCurrentUrl(initialUrl);
      setInputUrl(initialUrl === "genesis://newtab" ? "" : initialUrl);
    }
  }, [initialUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3. 300ms 防抖热重载机制：监听 reloadTrigger 递增
  useEffect(() => {
    if (reloadTrigger === 0 || reloadTrigger === lastTriggerRef.current) return;
    lastTriggerRef.current = reloadTrigger;

    const targetUrl = currentUrlRef.current;
    if (!targetUrl || targetUrl === "genesis://newtab") return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      if (iframeRef.current) {
        try {
          iframeRef.current.contentWindow?.location.reload();
        } catch {
          iframeRef.current.src = currentUrlRef.current;
        }
      }
    }, 300);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [reloadTrigger]);

  // 4. 监听来自预览 iframe 的运行时错误消息 (genesis-preview-bridge)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.source === "genesis-preview-bridge") {
        const { type, message, stack } = event.data;
        const msgStr = typeof message === "string" ? message : JSON.stringify(message || "未知运行时错误");
        const stackStr = typeof stack === "string" ? stack : "";

        setErrors((prev) => {
          // 防抖防洪：若最新一条错误信息与本次完全一致且时间差 < 1s，忽略重复刷屏
          const last = prev[prev.length - 1];
          if (last && last.message === msgStr && Date.now() - last.timestamp < 1000) {
            return prev;
          }
          const next = [
            ...prev,
            {
              id: `err-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              type: type || "runtime_error",
              message: msgStr,
              stack: stackStr,
              timestamp: Date.now(),
            },
          ];
          return next.slice(-20);
        });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  // 5. 若同源或可访问 iframe DOM，尝试在加载后注入监听探针
  const handleIframeLoad = () => {
    try {
      const cw = iframeRef.current?.contentWindow;
      if (cw) {
        const bridgeScriptId = "__genesis_preview_bridge__";
        if (!cw.document.getElementById(bridgeScriptId)) {
          const script = cw.document.createElement("script");
          script.id = bridgeScriptId;
          script.textContent = `
            window.addEventListener('error', function(e) {
              window.parent.postMessage({
                source: 'genesis-preview-bridge',
                type: 'error',
                message: e.message || 'Unknown runtime error',
                stack: e.error ? e.error.stack : (e.filename ? e.filename + ':' + e.lineno : ''),
              }, '*');
            });
            window.addEventListener('unhandledrejection', function(e) {
              window.parent.postMessage({
                source: 'genesis-preview-bridge',
                type: 'unhandledrejection',
                message: (e.reason && e.reason.message) || String(e.reason),
                stack: e.reason ? e.reason.stack : '',
              }, '*');
            });
          `;
          cw.document.head?.appendChild(script);
        }
      }
    } catch {
      // 跨域 iframe 安全限制忽略，外部页面通过嵌入脚本正常 postMessage 即可
    }
  };

  const handleNavigate = (url: string) => {
    let finalUrl = url.trim();
    if (finalUrl === "genesis://newtab") {
      setCurrentUrl("genesis://newtab");
      setInputUrl("");
      setPreviewUrl("genesis://newtab", false);
      return;
    }
    if (!finalUrl.startsWith("http://") && !finalUrl.startsWith("https://")) {
      finalUrl = `https://${finalUrl}`;
    }
    setCurrentUrl(finalUrl);
    setInputUrl(finalUrl);
    setPreviewUrl(finalUrl, false);
  };

  const handleRefresh = () => {
    if (currentUrl === "genesis://newtab") return;
    if (iframeRef.current) {
      try {
        iframeRef.current.contentWindow?.location.reload();
      } catch {
        iframeRef.current.src = currentUrl;
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleNavigate(inputUrl);
    }
  };

  // 6. 发送诊断信息给 Agent 自愈
  const handleSendToAgentForFix = async () => {
    if (errors.length === 0 || isSubmittingFix) return;
    setIsSubmittingFix(true);

    const errorsToReport = [...errors];
    // 遵循规范：清空当前错误列表
    setErrors([]);

    try {
      const latestErr = errorsToReport[errorsToReport.length - 1];
      const stackList = errorsToReport
        .map((err, idx) => {
          let text = `#### 异常 #${idx + 1} [${err.type}]\n- **信息**: \`${err.message}\``;
          if (err.stack) {
            text += `\n- **调用栈**:\n\`\`\`text\n${err.stack.trim()}\n\`\`\``;
          }
          return text;
        })
        .join("\n\n");

      const diagnosticPrompt = `我在浏览器预览界面（${currentUrl}）中捕获到了运行时错误，请帮我分析定位并修复代码：

**最新报错摘要**: ${latestErr.message}
**报错累计数量**: ${errorsToReport.length} 个

**错误堆栈详情**:
${stackList}
`;

      let sessionId = useSessionStore.getState().activeSessionId;
      if (!sessionId) {
        const created = await useSessionStore.getState().createSession("运行时报错自愈");
        sessionId = created?.id || null;
        if (sessionId && typeof window !== "undefined") {
          window.history.pushState({}, "", `/chat/${sessionId}`);
        }
      }

      if (sessionId) {
        await useChatStore.getState().sendStreamMessage(sessionId, diagnosticPrompt);
      }
    } catch (err) {
      console.error("[BrowserTabView] 提交自愈诊断失败:", err);
    } finally {
      setIsSubmittingFix(false);
    }
  };

  const isNewTab = currentUrl === "genesis://newtab";

  return (
    <div className="flex flex-col w-full h-full bg-[#141416] text-[#ECECED]">
      {/* 顶部 Omnibox 地址栏导航条 */}
      <div className="h-10 px-2.5 bg-[#18181A] border-b border-[#26262A] flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-1 text-[#8E8E93]">
          <button
            type="button"
            onClick={() => handleNavigate("genesis://newtab")}
            className="p-1.5 rounded hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            title="后退 / 返回主页"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="p-1.5 rounded text-[#55555C] cursor-not-allowed"
            disabled
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            className="p-1.5 rounded hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            title="刷新"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 核心输入框：搜索或输入网址 */}
        <div className="flex-1 max-w-xl mx-auto relative flex items-center">
          <div className="w-full relative flex items-center bg-[#202024] border border-white/10 rounded-full px-3 py-1 text-xs focus-within:border-blue-500/50 focus-within:bg-[#25252A] transition-all">
            <Globe className="w-3.5 h-3.5 text-[#71717A] mr-2 shrink-0" />
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="搜索或输入网址"
              className="bg-transparent text-white outline-none w-full text-xs font-mono placeholder:text-[#66666D]"
            />
          </div>
        </div>

        {/* 右侧动作 */}
        <div className="flex items-center gap-1 text-[#8E8E93]">
          {!isNewTab && (
            <a
              href={currentUrl}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded hover:text-white hover:bg-white/10 transition-colors"
              title="在新窗口打开"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* 运行时错误自愈捕获横幅 (Runtime Error Self-Healing Banner) */}
      {errors.length > 0 && (
        <div className="bg-rose-950/90 border-b border-rose-500/40 text-rose-200 px-3 py-2 flex items-center justify-between gap-3 text-xs shrink-0 animate-in slide-in-from-top-1 duration-200 shadow-md">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 animate-pulse" />
            <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 font-semibold text-[10px] border border-rose-500/30 shrink-0">
              {errors.length} 个错误
            </span>
            <span
              className="truncate font-mono text-[11px] text-rose-100 flex-1"
              title={errors[errors.length - 1].message}
            >
              {errors[errors.length - 1].message}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={isSubmittingFix}
              onClick={handleSendToAgentForFix}
              className="px-2.5 py-1 text-xs bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 active:from-rose-700 active:to-rose-600 text-white font-medium rounded shadow flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
              title="格式化诊断文本并发给 Agent 自动定位修复"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{isSubmittingFix ? "正在提交..." : "✨ 发送给 Agent 自动修复"}</span>
            </button>

            <button
              type="button"
              onClick={() => setErrors([])}
              className="p-1 rounded text-rose-400 hover:text-white hover:bg-rose-800/40 transition-colors cursor-pointer"
              title="忽略并清除报错"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 舞台区域 */}
      <div className="flex-1 min-h-0 relative bg-[#141416]">
        {isNewTab ? (
          <NewTabPage onNavigate={handleNavigate} />
        ) : (
          <div className="w-full h-full flex flex-col bg-white">
            {/* 外网安全提示条 */}
            <div className="h-6 px-3 bg-amber-500/10 border-b border-amber-500/20 text-[10px] text-amber-300 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-1.5 truncate">
                <ShieldAlert className="w-3 h-3 text-amber-400" />
                <span className="truncate">
                  部分外网因安全策略可能限制内嵌显示，如无法加载请点击右侧外部打开
                </span>
              </div>
              <a
                href={currentUrl}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-white ml-2 shrink-0"
              >
                外部打开
              </a>
            </div>

            <iframe
              ref={iframeRef}
              src={currentUrl}
              onLoad={handleIframeLoad}
              className="w-full flex-1 border-none bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        )}
      </div>
    </div>
  );
}
