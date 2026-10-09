"use client";

import React, { useState } from "react";
import {
  Server,
  Plus,
  RefreshCw,
  Trash2,
  ChevronRight,
  ChevronDown,
  Wrench,
  X,
} from "lucide-react";
import { useMarketplaceStore } from "@/stores/useMarketplaceStore";

export function McpDrawer() {
  const {
    mcpServers,
    isMcpDrawerOpen,
    closeMcpDrawer,
    toggleMcpTool,
    refreshMcpServer,
    addMcpServer,
    removeMcpServer,
  } = useMarketplaceStore();

  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({
    "mcp-github": true,
  });
  const [showAddForm, setShowAddForm] = useState(false);
  const [newServerName, setNewServerName] = useState("");
  const [newServerType, setNewServerType] = useState<"remote_url" | "local_command">(
    "remote_url"
  );
  const [newServerEndpoint, setNewServerEndpoint] = useState("");
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  if (!isMcpDrawerOpen) return null;

  const toggleExpand = (id: string) => {
    setExpandedServers((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleRefresh = async (id: string) => {
    setRefreshingId(id);
    await refreshMcpServer(id);
    setRefreshingId(null);
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerName || !newServerEndpoint) return;
    addMcpServer({
      name: newServerName,
      type: newServerType,
      endpoint: newServerEndpoint,
      status: "online",
      tools: [
        {
          name: "default_tool",
          description: "默认探测发现的 MCP 工具",
          enabled: true,
        },
      ],
    });
    setNewServerName("");
    setNewServerEndpoint("");
    setShowAddForm(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm animate-in fade-in duration-150 select-none text-codex-text"
      onClick={closeMcpDrawer}
    >
      <div
        className="w-full max-w-md bg-[#18181C] border-l border-hairline h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-[600ms]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 抽屉头部 */}
        <div className="h-12 px-5 border-b border-hairline flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-codex-muted" />
            <h3 className="text-sm font-medium text-white">
              MCP 连接池管理
            </h3>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded border border-hairline text-codex-muted">
              {mcpServers.length} Servers
            </span>
          </div>

          <button
            onClick={closeMcpDrawer}
            className="p-1.5 rounded-lg text-codex-muted hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 顶部操作区 */}
        <div className="p-3 border-b border-hairline/60 flex items-center justify-between shrink-0 bg-white/[0.01]">
          <span className="text-xs text-codex-muted">
            已配置 {mcpServers.filter((s) => s.status === "online").length} 在线节点
          </span>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="h-7 px-2.5 rounded-lg text-xs font-medium border border-hairline hover:border-white/20 hover:bg-white/[0.05] text-white flex items-center gap-1 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新增 Server</span>
          </button>
        </div>

        {/* 新增 Server 抽屉表单 */}
        {showAddForm && (
          <form
            onSubmit={handleAddSubmit}
            className="p-3 border-b border-hairline bg-[#141417] space-y-2.5 text-xs animate-in slide-in-from-top-2 duration-150"
          >
            <div>
              <label className="block text-codex-muted text-[10px] font-mono mb-1">
                Server 标识
              </label>
              <input
                type="text"
                required
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
                placeholder="例如: Custom-Jira-MCP"
                className="w-full h-7 px-2 rounded-lg bg-white/[0.03] border border-hairline text-white outline-none focus:border-codex-muted"
              />
            </div>

            <div>
              <label className="block text-codex-muted text-[10px] font-mono mb-1">
                连接类型与端点 / 指令
              </label>
              <div className="flex gap-1.5 mb-1.5">
                <button
                  type="button"
                  onClick={() => setNewServerType("remote_url")}
                  className={`flex-1 h-6 rounded-md text-[10px] font-mono border transition-colors ${
                    newServerType === "remote_url"
                      ? "bg-[#2A2A2E] border-white/20 text-white"
                      : "border-hairline text-codex-muted"
                  }`}
                >
                  Remote SSE
                </button>
                <button
                  type="button"
                  onClick={() => setNewServerType("local_command")}
                  className={`flex-1 h-6 rounded-md text-[10px] font-mono border transition-colors ${
                    newServerType === "local_command"
                      ? "bg-[#2A2A2E] border-white/20 text-white"
                      : "border-hairline text-codex-muted"
                  }`}
                >
                  Local Stdio
                </button>
              </div>
              <input
                type="text"
                required
                value={newServerEndpoint}
                onChange={(e) => setNewServerEndpoint(e.target.value)}
                placeholder={
                  newServerType === "remote_url"
                    ? "https://..."
                    : "npx -y @modelcontextprotocol/..."
                }
                className="w-full h-7 px-2 rounded-lg bg-white/[0.03] border border-hairline text-white outline-none focus:border-codex-muted font-mono text-[11px]"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-2 py-1 text-codex-muted hover:text-white"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-3 py-1 rounded-lg bg-white hover:bg-neutral-200 text-black font-medium"
              >
                保存并连接
              </button>
            </div>
          </form>
        )}

        {/* 滚动 Server 列表 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
          {mcpServers.map((server) => {
            const isExpanded = !!expandedServers[server.id];
            const isRefreshing = refreshingId === server.id;

            return (
              <div
                key={server.id}
                className="rounded-xl border border-hairline bg-[#141417] overflow-hidden"
              >
                {/* 节点条 */}
                <div
                  onClick={() => toggleExpand(server.id)}
                  className="p-3 flex items-center justify-between cursor-pointer hover:bg-white/[0.03] transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        server.status === "online"
                          ? "bg-blue-500"
                          : server.status === "connecting"
                          ? "bg-neutral-400 animate-pulse"
                          : "bg-neutral-600"
                      }`}
                      title={server.status}
                    />

                    <div className="min-w-0">
                      <div className="text-xs font-medium text-white truncate">
                        {server.name}
                      </div>
                      <div className="font-mono text-[10px] text-codex-muted truncate">
                        {server.endpoint}
                      </div>
                    </div>
                  </div>

                  <div
                    className="flex items-center gap-1.5 shrink-0 ml-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => handleRefresh(server.id)}
                      disabled={isRefreshing}
                      className="p-1 rounded text-codex-muted hover:text-white hover:bg-white/[0.06] transition-colors"
                      title="刷新探测工具"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin text-blue-400" : ""}`}
                      />
                    </button>
                    <button
                      onClick={() => removeMcpServer(server.id)}
                      className="p-1 rounded text-codex-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      title="删除连接"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => toggleExpand(server.id)}
                      className="p-1 text-codex-muted"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* 展开工具开关列表 */}
                {isExpanded && (
                  <div className="border-t border-hairline/60 bg-black/20 p-2.5 space-y-1.5 animate-in fade-in duration-100">
                    <div className="text-[10px] font-mono text-codex-muted uppercase tracking-wider mb-1 px-1">
                      可用工具 ({server.tools.length})
                    </div>

                    {server.tools.map((tool) => (
                      <div
                        key={tool.name}
                        onClick={() => toggleMcpTool(server.id, tool.name)}
                        className="px-2 py-1.5 rounded-lg hover:bg-white/[0.04] cursor-pointer flex items-center justify-between text-xs transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0 pr-2">
                          <Wrench className="w-3 h-3 text-codex-muted shrink-0" />
                          <div className="min-w-0">
                            <span className="font-mono text-xs text-white block truncate">
                              {tool.name}
                            </span>
                            <span className="text-[10px] text-codex-muted block truncate">
                              {tool.description}
                            </span>
                          </div>
                        </div>

                        {/* 自定义开关 Toggle */}
                        <div
                          className={`w-7 h-4 rounded-full p-0.5 transition-colors shrink-0 ${
                            tool.enabled
                              ? "bg-blue-600"
                              : "bg-white/[0.1] border border-hairline"
                          }`}
                        >
                          <div
                            className={`w-3 h-3 rounded-full bg-white transition-transform ${
                              tool.enabled ? "translate-x-3" : "translate-x-0"
                            }`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
