"use client";

import React from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";

// 复刻 iOS / macOS 极简开关 Switch
function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`w-11 h-6 rounded-full transition-colors relative focus:outline-none cursor-pointer ${
        checked ? "bg-[#007AFF]" : "bg-[#3A3A3C]"
      }`}
    >
      <span
        className={`w-5 h-5 bg-white rounded-full absolute top-0.5 shadow-sm transition-transform duration-200 ease-in-out ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function GeneralTab() {
  const { general, updateGeneralSettings } = useSettingsStore();

  return (
    <div className="space-y-8 max-w-4xl">
      {/* 顶栏大标题 */}
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">常规</h2>
      </div>

      {/* 模块 1：权限 */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[#8E8E93] tracking-wide">
          权限
        </h3>

        <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl divide-y divide-[#27272a]/60">
          {/* 默认权限 */}
          <div className="p-4 sm:p-5 flex items-center justify-between gap-6">
            <div className="space-y-1 pr-4">
              <div className="text-sm font-medium text-white">默认权限</div>
              <div className="text-xs text-[#8E8E93] leading-relaxed">
                默认情况下，Genesis 可以读取和编辑其工作空间中的文件。需要时，它可以请求额外访问权限。
              </div>
            </div>
            <Switch
              checked={general.defaultPermission}
              onChange={(val) =>
                updateGeneralSettings({ defaultPermission: val })
              }
            />
          </div>

          {/* 完整访问权限 */}
          <div className="p-4 sm:p-5 flex items-center justify-between gap-6">
            <div className="space-y-1 pr-4">
              <div className="text-sm font-medium text-white">完整访问权限</div>
              <div className="text-xs text-[#8E8E93] leading-relaxed">
                当 Genesis 以完整访问权限运行时，它无需你的批准即可编辑你电脑上的任何文件，并运行可访问网络的命令。这会显著增加数据丢失、泄露或意外行为的风险。{" "}
                <span className="text-[#007AFF] hover:underline cursor-pointer">
                  了解更多
                </span>{" "}
                关于风险升高的信息。
              </div>
            </div>
            <Switch
              checked={general.fullAccess}
              onChange={(val) => updateGeneralSettings({ fullAccess: val })}
            />
          </div>
        </div>
      </div>

      {/* 模块 2：常规 */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[#8E8E93] tracking-wide">
          常规
        </h3>

        <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl divide-y divide-[#27272a]/60">
          {/* 无项目任务文件夹 */}
          <div className="p-4 sm:p-5 flex items-center justify-between gap-6">
            <div className="space-y-1 pr-4">
              <div className="text-sm font-medium text-white">
                无项目任务文件夹
              </div>
              <div className="text-xs text-[#8E8E93] leading-relaxed">
                在项目外启动的任务默认存储数据的位置。
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs font-mono text-[#8E8E93] max-w-[200px] sm:max-w-xs truncate">
                /Users/lyon/Desktop/agentProject
              </span>
              <button
                type="button"
                className="px-2.5 py-1 rounded-lg text-xs font-medium text-[#A1A1AA] hover:text-white bg-[#222226] hover:bg-[#2C2C32] border border-[#2E2E36] transition-colors cursor-pointer"
              >
                更改
              </button>
            </div>
          </div>

          {/* 默认文件打开位置 */}
          <div className="p-4 sm:p-5 flex items-center justify-between gap-6">
            <div className="space-y-1 pr-4">
              <div className="text-sm font-medium text-white">
                默认文件打开位置
              </div>
              <div className="text-xs text-[#8E8E93] leading-relaxed">
                默认打开文件和文件夹的位置
              </div>
            </div>
            <div className="relative shrink-0">
              <select
                value={general.defaultFileOpener}
                onChange={(e) =>
                  updateGeneralSettings({
                    defaultFileOpener: e.target.value as "VS Code" | "Cursor" | "System",
                  })
                }
                className="appearance-none bg-[#222226] border border-[#2E2E36] text-xs text-white rounded-xl pl-3 pr-8 py-1.5 focus:outline-none focus:border-[#4B4B55] transition-colors cursor-pointer"
              >
                <option value="VS Code">VS Code</option>
                <option value="Cursor">Cursor</option>
                <option value="System">系统默认</option>
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-[#8E8E93] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          {/* 语言 */}
          <div className="p-4 sm:p-5 flex items-center justify-between gap-6">
            <div className="space-y-1 pr-4">
              <div className="text-sm font-medium text-white">语言</div>
              <div className="text-xs text-[#8E8E93] leading-relaxed">
                应用 UI 语言
              </div>
            </div>
            <div className="relative shrink-0">
              <select
                value={general.language}
                onChange={(e) =>
                  updateGeneralSettings({
                    language: e.target.value as "zh-CN" | "en-US",
                  })
                }
                className="appearance-none bg-[#222226] border border-[#2E2E36] text-xs text-white rounded-xl pl-3 pr-8 py-1.5 focus:outline-none focus:border-[#4B4B55] transition-colors cursor-pointer"
              >
                <option value="zh-CN">简体中文</option>
                <option value="en-US">English</option>
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-[#8E8E93] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          {/* 在菜单栏中显示 */}
          <div className="p-4 sm:p-5 flex items-center justify-between gap-6">
            <div className="space-y-1 pr-4">
              <div className="text-sm font-medium text-white">
                在菜单栏中显示
              </div>
              <div className="text-xs text-[#8E8E93] leading-relaxed">
                关闭主窗口后，仍在 macOS 菜单栏中保留 Genesis
              </div>
            </div>
            <Switch
              checked={general.showInMenuBar}
              onChange={(val) =>
                updateGeneralSettings({ showInMenuBar: val })
              }
            />
          </div>

          {/* 底部面板 */}
          <div className="p-4 sm:p-5 flex items-center justify-between gap-6">
            <div className="space-y-1 pr-4">
              <div className="text-sm font-medium text-white">底部面板</div>
              <div className="text-xs text-[#8E8E93] leading-relaxed">
                在应用标题栏中显示底部面板控件
              </div>
            </div>
            <Switch
              checked={general.showBottomPanel}
              onChange={(val) =>
                updateGeneralSettings({ showBottomPanel: val })
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
