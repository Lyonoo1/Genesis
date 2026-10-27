"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import { ChevronRight, ChevronDown, FileCode, Check } from "lucide-react";
import { WorkspaceFileNode } from "@/lib/workspace/localWorkspaceManager";

interface BreadcrumbsDropdownProps {
  filePath: string;
  fileTree: WorkspaceFileNode[];
  onSelectFile: (path: string) => void;
}

// 文件类型徽章小图标 (对标图 2 中的绿色 M↓ 与各类代码小标)
function getLanguageBadgeIcon(name: string) {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".md")) {
    return <span className="text-emerald-400 font-bold text-[10px] shrink-0 leading-none">M↓</span>;
  }
  if (n.endsWith(".vue")) {
    return <span className="text-emerald-400 font-bold text-[9px] shrink-0">V</span>;
  }
  if (n.endsWith(".js") || n.endsWith(".jsx")) {
    return (
      <span className="bg-amber-400 text-black px-0.5 rounded-[2px] font-bold text-[7px] shrink-0">
        JS
      </span>
    );
  }
  if (n.endsWith(".ts") || n.endsWith(".tsx")) {
    return (
      <span className="bg-blue-500 text-white px-0.5 rounded-[2px] font-bold text-[7px] shrink-0">
        TS
      </span>
    );
  }
  if (n.endsWith(".py")) {
    return <span className="text-blue-400 font-bold text-[8px] shrink-0">PY</span>;
  }
  if (n.endsWith(".toml") || n.endsWith(".yaml") || n.endsWith(".yml") || n.endsWith(".json")) {
    return <span className="text-amber-400 font-bold text-[8px] shrink-0">&#123;&#125;</span>;
  }
  if (n.startsWith(".env")) {
    return <span className="text-emerald-400 font-bold text-[8px] shrink-0">ENV</span>;
  }
  return <FileCode className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
}

// 辅助方法：在文件树中按段名称或路径查找目标节点
function findNodeBySegmentName(
  nodes: WorkspaceFileNode[],
  segmentName: string
): WorkspaceFileNode | null {
  for (const n of nodes) {
    if (n.name === segmentName || n.path === segmentName || n.path.endsWith("/" + segmentName)) {
      return n;
    }
    if (n.children && n.children.length > 0) {
      const found = findNodeBySegmentName(n.children, segmentName);
      if (found) return found;
    }
  }
  return null;
}

// 辅助方法：查找某个节点在整棵树中的父目录节点
function findParentOfNode(
  nodes: WorkspaceFileNode[],
  childNameOrPath: string
): WorkspaceFileNode | null {
  for (const n of nodes) {
    if (n.children && n.children.length > 0) {
      if (
        n.children.some(
          (c) =>
            c.name === childNameOrPath ||
            c.path === childNameOrPath ||
            childNameOrPath.endsWith("/" + c.name)
        )
      ) {
        return n;
      }
      const deep = findParentOfNode(n.children, childNameOrPath);
      if (deep) return deep;
    }
  }
  return null;
}

export function BreadcrumbsDropdown({
  filePath,
  fileTree,
  onSelectFile,
}: BreadcrumbsDropdownProps) {
  const [openSegmentIndex, setOpenSegmentIndex] = useState<number | null>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const segments = useMemo(() => {
    return filePath ? filePath.split("/").filter(Boolean) : [];
  }, [filePath]);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setOpenSegmentIndex(null);
        setDropdownPos(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 监听页面滚动与窗口大小调整时关闭浮层，避免错位 (忽略浮窗自身内部的滚动)
  useEffect(() => {
    if (openSegmentIndex === null) return;
    const handleScrollOrResize = (e: Event) => {
      // 若滚动来自于浮窗自身的内容或滚动条，绝不关闭！
      if (
        dropdownRef.current &&
        (dropdownRef.current === e.target || dropdownRef.current.contains(e.target as Node))
      ) {
        return;
      }
      setOpenSegmentIndex(null);
      setDropdownPos(null);
    };
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [openSegmentIndex]);

  // 点击面包屑段：计算 Fixed 坐标彻底脱离父级 overflow 截断
  const handleOpenDropdown = (idx: number, e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (openSegmentIndex === idx) {
      setOpenSegmentIndex(null);
      setDropdownPos(null);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const dropdownWidth = 320;
    const top = rect.bottom + 6;
    const maxLeft = typeof window !== "undefined" ? window.innerWidth - dropdownWidth - 16 : 800;
    const left = Math.max(12, Math.min(rect.left, maxLeft));

    setDropdownPos({ top, left });

    // 默认预设展开当前段及路径
    const nextExpanded = new Set<string>();
    let acc = "";
    for (let i = 0; i < segments.length - 1; i++) {
      acc = acc ? `${acc}/${segments[i]}` : segments[i];
      nextExpanded.add(acc);
      nextExpanded.add(segments[i]);
    }
    if (idx < segments.length) {
      nextExpanded.add(segments[idx]);
    }

    setExpandedPaths(nextExpanded);
    setOpenSegmentIndex(idx);
  };

  // 切换目录展开/折叠 (原地切换，不关闭浮层)
  const toggleDirExpand = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // 计算当前下拉浮层应展示的节点列表
  const dropdownNodes = useMemo(() => {
    if (!fileTree || fileTree.length === 0) return [];
    if (openSegmentIndex === null) return [];

    const isLast = openSegmentIndex === segments.length - 1;
    const isFirst = openSegmentIndex === 0;

    // 1. 若点击第 0 项（工作区根）或单段路径，展示整棵树
    if (isFirst || segments.length <= 1) {
      return fileTree;
    }

    // 2. 若点击末尾文件段：展示其父目录中的所有文件与同级项
    if (isLast) {
      const parentSeg = segments[segments.length - 2];
      const parentNode = findNodeBySegmentName(fileTree, parentSeg);
      if (parentNode && parentNode.children && parentNode.children.length > 0) {
        return parentNode.children;
      }
      return fileTree;
    }

    // 3. 若点击中间目录段（例如 "repositories"）：
    //    精准展示该目录下的所有文件与子目录！
    const targetSeg = segments[openSegmentIndex];
    const targetNode = findNodeBySegmentName(fileTree, targetSeg);
    if (targetNode) {
      if (targetNode.children && targetNode.children.length > 0) {
        return targetNode.children;
      }
      // 若当前节点无 children（可能是文件），寻找其所在父级的所有兄弟
      const parentNode = findParentOfNode(fileTree, targetNode.path);
      if (parentNode && parentNode.children && parentNode.children.length > 0) {
        return parentNode.children;
      }
      return [targetNode];
    }

    return fileTree;
  }, [fileTree, openSegmentIndex, segments]);

  // 递归树节点渲染组件 (对标图 2 样式)
  const renderTreeItems = (nodes: WorkspaceFileNode[], depth = 0) => {
    return nodes.map((node) => {
      const isDir = node.kind === "directory";
      const isExpanded = expandedPaths.has(node.path) || expandedPaths.has(node.name);
      const isCurrentFile = !isDir && (filePath === node.path || filePath.endsWith("/" + node.name));
      const isCurrentDir = isDir && segments.includes(node.name);

      if (isDir) {
        return (
          <div key={node.path || node.name} className="flex flex-col">
            {/* 目录行：图 2 中的 > .github / v branches 样式 */}
            <div
              onClick={(e) => toggleDirExpand(node.path || node.name, e)}
              style={{ paddingLeft: `${depth * 14 + 8}px` }}
              className={`flex items-center gap-1.5 py-1.5 pr-2 rounded-lg text-xs cursor-pointer select-none transition-colors ${
                isCurrentDir || isExpanded
                  ? "bg-white/10 text-white font-medium"
                  : "text-[#A1A1AA] hover:text-white hover:bg-white/[0.06]"
              }`}
            >
              {/* 细线箭头 (展开为 v，折叠为 >) */}
              <span className="shrink-0 flex items-center justify-center w-4 h-4 text-[#8E8E93]">
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 stroke-[1.8]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 stroke-[1.8]" />
                )}
              </span>

              {/* 目录名称 */}
              <span className="truncate font-sans">{node.name}</span>
            </div>

            {/* 展开的子项递归渲染 */}
            {isExpanded && node.children && node.children.length > 0 && (
              <div className="flex flex-col mt-0.5">
                {renderTreeItems(node.children, depth + 1)}
              </div>
            )}
          </div>
        );
      }

      // 文件行：图 2 中的 M↓ DESIGN.md 样式
      return (
        <button
          key={node.path}
          type="button"
          onClick={() => {
            setOpenSegmentIndex(null);
            setDropdownPos(null);
            onSelectFile(node.path);
          }}
          style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
          className={`w-full flex items-center gap-2 py-1.5 pr-2.5 rounded-lg text-left text-xs transition-colors cursor-pointer outline-none focus:outline-none ${
            isCurrentFile
              ? "bg-white/15 text-white font-medium shadow-sm"
              : "text-[#D4D4D8] hover:text-white hover:bg-white/[0.08]"
          }`}
          title={node.path}
        >
          {/* 文件类型徽章小标 (对标图 2 的绿色 M↓ 等) */}
          <span className="shrink-0 flex items-center justify-center w-4 h-4">
            {getLanguageBadgeIcon(node.name)}
          </span>

          {/* 文件名 */}
          <span className="truncate flex-1 font-sans text-xs">
            {node.name}
          </span>

          {/* 当前选中文档打勾指示 */}
          {isCurrentFile && (
            <Check className="w-3 h-3 text-emerald-400 shrink-0 ml-auto" />
          )}
        </button>
      );
    });
  };

  if (segments.length === 0) {
    return (
      <div className="inline-flex items-center px-3.5 py-1 rounded-full bg-[#242426] border border-white/[0.08] text-xs font-sans text-[#8E8E93]">
        <span>工作区根目录</span>
      </div>
    );
  }

  return (
    <>
      {/* 顶部胶囊面包屑药丸栏 (图 1 样式) */}
      <div
        ref={containerRef}
        className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[#242426] border border-white/[0.08] text-xs font-sans text-[#A1A1AA] select-none shadow-sm relative max-w-full overflow-x-auto scrollbar-none"
      >
        {segments.map((segment, idx) => {
          const isLast = idx === segments.length - 1;
          const isOpen = openSegmentIndex === idx;

          return (
            <div key={idx} className="relative flex items-center shrink-0">
              {idx > 0 && (
                <ChevronRight className="w-3 h-3 text-[#55555C] shrink-0 mx-0.5 stroke-[1.8]" />
              )}

              {/* 面包屑文字胶囊段：去除生硬的浏览器蓝框 focus:outline-none */}
              <button
                type="button"
                onClick={(e) => handleOpenDropdown(idx, e)}
                className={`px-2 py-0.5 rounded-full transition-colors flex items-center cursor-pointer outline-none focus:outline-none focus-visible:outline-none ${
                  isOpen
                    ? "bg-white/20 text-white font-medium ring-1 ring-white/20"
                    : isLast
                    ? "text-white font-normal hover:bg-white/10"
                    : "text-[#C4C4C8] hover:text-white hover:bg-white/10"
                }`}
                title={`点击展开 ${segment} 目录下的文件`}
              >
                <span className="truncate max-w-[160px]">{segment}</span>
              </button>
            </div>
          );
        })}
      </div>

      {/* 图 2 下拉树状浮层：使用 fixed 定位彻底逃逸父容器的 overflow 裁剪 */}
      {openSegmentIndex !== null && dropdownPos && (
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            top: dropdownPos.top,
            left: dropdownPos.left,
            zIndex: 99999,
          }}
          className="min-w-[280px] max-w-[360px] max-h-[380px] bg-[#1E1E20] border border-white/10 rounded-2xl shadow-2xl p-2 overflow-y-auto backdrop-blur-md animate-in fade-in zoom-in-95 duration-100 scrollbar-thin"
        >
          {dropdownNodes.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-[#71717A]">
              该目录下暂无文件
            </div>
          ) : (
            <div className="space-y-0.5">
              {renderTreeItems(dropdownNodes, 0)}
            </div>
          )}
        </div>
      )}
    </>
  );
}
