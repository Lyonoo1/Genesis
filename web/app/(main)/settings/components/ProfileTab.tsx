"use client";

import React, { useState } from "react";
import { User, Mail, Check, Shield } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";

export function ProfileTab() {
  const { profile, updateProfileSettings } = useSettingsStore();
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    updateProfileSettings({ name, email });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
          <User className="w-6 h-6 text-blue-400" />
          <span>个人资料</span>
        </h2>
        <p className="text-xs text-[#8E8E93] mt-1.5 leading-relaxed">
          管理你的开发者身份标识与本地个性化昵称。
        </p>
      </div>

      <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl p-6 space-y-6">
        {/* 头像区域 */}
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-bold text-xl flex items-center justify-center shadow-lg">
            {profile.avatarText || "LY"}
          </div>
          <div>
            <div className="text-base font-semibold text-white">{name}</div>
            <div className="text-xs text-[#8E8E93] mt-0.5">{email}</div>
          </div>
        </div>

        <div className="space-y-4 max-w-md pt-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#A1A1AA]">昵称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-9 px-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs text-white focus:outline-none focus:border-blue-500/60 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#A1A1AA]">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-9 px-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs text-white focus:outline-none focus:border-blue-500/60 transition-colors"
            />
          </div>

          <div className="pt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              className="h-8 px-4 rounded-xl text-xs font-semibold bg-white text-black hover:bg-white/90 shadow-sm transition-all cursor-pointer"
            >
              保存修改
            </button>
            {saved && (
              <span className="text-xs text-emerald-400 flex items-center gap-1 animate-in fade-in">
                <Check className="w-3.5 h-3.5" /> 已保存
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
