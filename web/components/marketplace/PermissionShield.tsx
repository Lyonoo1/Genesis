"use client";

import React from "react";
import { Shield, Terminal, Eye, Globe, Database, Cpu } from "lucide-react";

interface PermissionShieldProps {
  permissions: Array<"exec:sandbox" | "read:file" | "net:egress" | "db:query" | "mcp:remote">;
}

const PERMISSION_MAP = {
  "exec:sandbox": {
    label: "代码沙箱执行 (exec:sandbox)",
    desc: "在轻量级隔离子进程中运行未受信任脚本，持有 30s 强杀熔断限制",
    icon: Terminal,
  },
  "read:file": {
    label: "文件只读访问 (read:file)",
    desc: "读取项目上下文中的代码或白名单文本内容",
    icon: Eye,
  },
  "net:egress": {
    label: "公网出站连接 (net:egress)",
    desc: "向外部技术文档源或远程 API 发起 HTTPS 联网请求",
    icon: Globe,
  },
  "db:query": {
    label: "数据库只读探测 (db:query)",
    desc: "执行只读 SQL 查询与元数据 Schema 分析，禁用写指令",
    icon: Database,
  },
  "mcp:remote": {
    label: "远程 MCP 协议通信 (mcp:remote)",
    desc: "通过 JSON-RPC 2.0 与经配置的远程 Server 交换工具调用契约",
    icon: Cpu,
  },
};

export function PermissionShield({ permissions }: PermissionShieldProps) {
  if (!permissions || permissions.length === 0) return null;

  return (
    <div className="rounded-xl border border-hairline bg-white/[0.02] p-3.5 space-y-2.5 select-none">
      <div className="flex items-center gap-2 text-codex-text font-mono text-xs font-medium">
        <Shield className="w-4 h-4 text-codex-muted shrink-0" />
        <span>权限声明与沙箱隔离</span>
      </div>
      <p className="text-[11px] text-codex-muted leading-relaxed">
        此能力在 Genesis 隔离沙箱环境中运行，持有以下受控安全权限：
      </p>

      <div className="space-y-1.5 pt-1">
        {permissions.map((p) => {
          const item = PERMISSION_MAP[p];
          if (!item) return null;
          const Icon = item.icon;
          return (
            <div
              key={p}
              className="flex items-start gap-2 p-2 rounded-lg bg-[#141417] border border-hairline/60 text-xs"
            >
              <Icon className="w-3.5 h-3.5 text-codex-muted mt-0.5 shrink-0" />
              <div>
                <div className="font-mono text-[11px] font-medium text-white">
                  {item.label}
                </div>
                <div className="text-[10px] text-codex-subtle mt-0.5 leading-snug">
                  {item.desc}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
