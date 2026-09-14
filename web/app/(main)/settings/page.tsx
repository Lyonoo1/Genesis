import React from "react";
import { Settings } from "lucide-react";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 border-b border-hairline pb-4">
        <div className="w-8 h-8 rounded bg-accent-cyan/10 border border-accent-cyan/30 flex items-center justify-center">
          <Settings className="w-4 h-4 text-accent-cyan" />
        </div>
        <div>
          <h2 className="text-base font-medium text-genesis-primary">
            系统偏好设置
          </h2>
          <p className="text-xs text-genesis-secondary">
            外观排版、MCP 远程服务连接池与 Token 成本用量审计
          </p>
        </div>
      </div>
      <div className="p-8 text-center border border-dashed border-hairline rounded-lg text-sm text-genesis-muted">
        设置中心骨架已就绪，将在 FE-Step 6 完善完整配置项。
      </div>
    </div>
  );
}
