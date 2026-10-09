"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export function useStickyScroll<T extends HTMLElement>() {
  const containerRef = useRef<T | null>(null);

  // 是否处于吸附状态 (在底部时流式推流自动跟随)
  const isAutoScrollEnabledRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // 标记是否正在执行主动平滑回到底部的动画中
  const isProgrammaticScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 核心滚动检测函数：根据物理距离准确决定按钮是否出现与是否跟随
  const checkScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;

    // 如果正在执行回到底部的平滑动画
    if (isProgrammaticScrollingRef.current) {
      if (dist <= 15) {
        isProgrammaticScrollingRef.current = false;
        isAutoScrollEnabledRef.current = true;
        setShowScrollButton(false);
      }
      return;
    }

    if (dist > 40) {
      // 视口远离底部：用户正在阅读历史，显示“回到底部”按钮，关闭流式自动跟随
      setShowScrollButton(true);
      isAutoScrollEnabledRef.current = false;
    } else {
      // 视口贴近底部：隐藏按钮，开启流式跟随
      setShowScrollButton(false);
      isAutoScrollEnabledRef.current = true;
    }
  }, []);

  // 主动滚动到底部
  const scrollToBottom = useCallback((smooth = false) => {
    const el = containerRef.current;
    if (!el) return;

    isAutoScrollEnabledRef.current = true;
    setShowScrollButton(false);

    if (smooth) {
      isProgrammaticScrollingRef.current = true;
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      // 安全超时，防止某些浏览器平滑滚动结束时事件不精确
      scrollTimeoutRef.current = setTimeout(() => {
        isProgrammaticScrollingRef.current = false;
        checkScrollState();
      }, 500);
    }

    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, [checkScrollState]);

  // 新增流式内容时的跟随处理
  const onNewContent = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isProgrammaticScrollingRef.current) {
      return;
    }

    const el = containerRef.current;
    if (!el) return;

    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist > 40) {
      isAutoScrollEnabledRef.current = false;
      setShowScrollButton(true);
      return;
    }

    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // 初始检查
    checkScrollState();

    // 监听原生滚动（覆盖鼠标滚轮、触控板双指、拖动原生滚动条、键盘 PageUp/Down）
    const onScroll = () => {
      checkScrollState();
    };

    // 向上滚轮瞬间主动切断自动吸附
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -1) {
        isProgrammaticScrollingRef.current = false;
        isAutoScrollEnabledRef.current = false;
        setShowScrollButton(true);
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, [checkScrollState]);

  return {
    containerRef,
    isAtBottom: isAutoScrollEnabledRef.current,
    showScrollButton,
    scrollToBottom,
    onNewContent,
  };
}
