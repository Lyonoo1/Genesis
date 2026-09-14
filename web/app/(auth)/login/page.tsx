import React from "react";
import { Terminal } from "lucide-react";

export default function LoginPage() {
  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-void text-genesis-primary px-4">
      <div className="w-full max-w-sm p-6 rounded-xl border border-hairline bg-surface-sidebar space-y-6">
        <div className="flex flex-col items-center space-y-2 text-center">
          <div className="w-10 h-10 rounded-lg bg-accent-cyan/10 border border-accent-cyan/30 flex items-center justify-center drop-shadow-[0_0_8px_rgba(34,211,238,0.3)]">
            <Terminal className="w-5 h-5 text-accent-cyan" />
          </div>
          <h1 className="text-lg font-medium tracking-wide">Genesis Code</h1>
          <p className="text-xs text-genesis-secondary">
            基于 Supabase Auth 驱动的安全工作空间
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1 text-xs">
            <label className="text-genesis-secondary">邮箱地址</label>
            <input
              type="email"
              placeholder="developer@example.com"
              className="w-full h-9 px-3 rounded-md bg-void border border-hairline focus:border-accent-cyan focus:outline-none text-xs text-genesis-primary placeholder:text-genesis-muted"
            />
          </div>
          <div className="space-y-1 text-xs">
            <label className="text-genesis-secondary">访问密钥 / 密码</label>
            <input
              type="password"
              placeholder="••••••••"
              className="w-full h-9 px-3 rounded-md bg-void border border-hairline focus:border-accent-cyan focus:outline-none text-xs text-genesis-primary placeholder:text-genesis-muted"
            />
          </div>
          <button className="w-full h-9 rounded-md bg-accent-cyan/20 border border-accent-cyan/40 hover:bg-accent-cyan/30 text-accent-cyan text-xs font-medium transition-all">
            登录进入控制台
          </button>
        </div>
      </div>
    </div>
  );
}
