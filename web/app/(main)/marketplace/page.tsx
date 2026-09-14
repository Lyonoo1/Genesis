import React from "react";
import { ShoppingBag } from "lucide-react";

export default function MarketplacePage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 border-b border-hairline pb-4">
        <div className="w-8 h-8 rounded bg-accent-amber/10 border border-accent-amber/30 flex items-center justify-center">
          <ShoppingBag className="w-4 h-4 text-accent-amber" />
        </div>
        <div>
          <h2 className="text-base font-medium text-genesis-primary">
            Genesis 插件与 Skill 市场
          </h2>
          <p className="text-xs text-genesis-secondary">
            浏览、安装、一键热插拔官方与社区能力包
          </p>
        </div>
      </div>
      <div className="p-8 text-center border border-dashed border-hairline rounded-lg text-sm text-genesis-muted">
        插件市场模块骨架已就绪，将在 FE-Step 6 / BE-Step 6 完成全流程联动。
      </div>
    </div>
  );
}
