"use client";

import React, { useEffect, useState } from "react";

export function WorkspaceHeader() {
  const [isDesktopMac, setIsDesktopMac] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const isMac =
        (window as any).electronAPI?.platform === "darwin" ||
        (Boolean((window as any).electronAPI?.isDesktop) && /Mac/i.test(navigator.userAgent));
      setIsDesktopMac(isMac);
    }
  }, []);

  return (
    <div className="h-11 px-3.5 flex items-center select-none flex-shrink-0 app-drag">
      {/* 工作区标题：Web 留空 56px 给常驻按钮；macOS 桌面端留空 130px 给红绿灯与常驻按钮 */}
      <div
        className={`flex items-center ${
          isDesktopMac ? "pl-[130px]" : "pl-[56px]"
        } px-1.5 py-0.5 text-[14px] font-semibold text-[#ECECED] pointer-events-none select-none`}
      >
        <span>Genesis</span>
      </div>
    </div>
  );
}
