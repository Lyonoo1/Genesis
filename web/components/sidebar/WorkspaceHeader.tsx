"use client";

import React from "react";

export function WorkspaceHeader() {
  return (
    <div className="h-11 px-3.5 flex items-center select-none flex-shrink-0">
      {/* 工作区标题：给最左侧常驻按钮 (14px~64px) 留空，紧随其后呈现 Genesis */}
      <div className="flex items-center pl-[56px] px-1.5 py-0.5 text-[14px] font-semibold text-[#ECECED]">
        <span>Genesis</span>
      </div>
    </div>
  );
}
