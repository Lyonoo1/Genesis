"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Search,
  Settings,
  User,
  Sliders,
  Archive,
  Check,
  Plus,
  RotateCcw,
  Trash2,
  Folder,
  MoreHorizontal,
  Puzzle,
} from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useSessionStore } from "@/stores/useSessionStore";

function formatArchiveDate(dateStr: string) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}年${month}月${day}日，${hours}:${minutes}`;
}

export function SettingsModal() {
  const {
    isSettingsModalOpen,
    activeSettingsTab,
    general,
    profile,
    density,
    setDensity,
    closeSettingsModal,
    setActiveSettingsTab,
    updateGeneralSettings,
    updateProfileSettings,
  } = useSettingsStore();

  const {
    sessions,
    projects,
    unarchiveSession,
    deleteSession,
    unarchiveProject,
    deleteProject,
  } = useSessionStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [archiveSearchQuery, setArchiveSearchQuery] = useState("");
  const router = useRouter();

  // 全局快捷键 ⌘, 呼出 / Esc 关闭
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        if (isSettingsModalOpen) {
          closeSettingsModal();
        } else {
          useSettingsStore.getState().openSettingsModal("general");
        }
      } else if (e.key === "Escape" && isSettingsModalOpen) {
        closeSettingsModal();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSettingsModalOpen, closeSettingsModal]);

  if (!isSettingsModalOpen) return null;

  const archivedSessions = sessions.filter((s) => s.is_archived);
  const archivedProjects = projects.filter((p) => p.is_archived);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md select-none animate-in fade-in duration-200">
      <div className="w-[960px] h-[640px] max-w-[95vw] max-h-[90vh] bg-[#181818] border border-[#303033] rounded-2xl shadow-2xl flex overflow-hidden">
        {/* 1. 左侧二级设置导航 (Settings Sidebar) */}
        <div className="w-56 bg-[#18181B] border-r border-hairline flex flex-col flex-shrink-0">
          {/* 顶部返回应用按钮 */}
          <div className="p-3 border-b border-hairline">
            <button
              type="button"
              onClick={closeSettingsModal}
              className="flex items-center gap-2 text-xs font-medium text-codex-muted hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>返回应用</span>
            </button>
          </div>

          {/* 搜索框 */}
          <div className="p-3">
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-black/30 border border-hairline text-xs">
              <Search className="w-3.5 h-3.5 text-codex-subtle" />
              <input
                type="text"
                placeholder="搜索设置..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-transparent text-codex-text placeholder:text-codex-subtle outline-none"
              />
            </div>
          </div>

          {/* 导航分类 */}
          <div className="flex-1 overflow-y-auto px-2 space-y-4 py-1 scrollbar-thin text-xs flex flex-col justify-between">
            {/* 分组：个人 */}
            <div>
              <div className="px-2.5 py-1 text-[11px] font-medium text-codex-subtle">
                个人
              </div>
              <div className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => setActiveSettingsTab("general")}
                  className={`w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 text-left transition-colors ${
                    activeSettingsTab === "general"
                      ? "bg-white/[0.08] text-white font-medium"
                      : "text-codex-muted hover:text-white hover:bg-white/[0.04]"
                  }`}
                >
                  <Settings className="w-3.5 h-3.5" />
                  <span>常规</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSettingsTab("profile")}
                  className={`w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 text-left transition-colors ${
                    activeSettingsTab === "profile"
                      ? "bg-white/[0.08] text-white font-medium"
                      : "text-codex-muted hover:text-white hover:bg-white/[0.04]"
                  }`}
                >
                  <User className="w-3.5 h-3.5" />
                  <span>个人资料</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSettingsTab("appearance")}
                  className={`w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 text-left transition-colors ${
                    activeSettingsTab === "appearance"
                      ? "bg-white/[0.08] text-white font-medium"
                      : "text-codex-muted hover:text-white hover:bg-white/[0.04]"
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>外观</span>
                </button>
                <div className="opacity-40 pointer-events-none space-y-0.5 pt-1">
                  <div className="px-2.5 py-1 text-codex-subtle">语音</div>
                  <div className="px-2.5 py-1 text-codex-subtle">配置</div>
                  <div className="px-2.5 py-1 text-codex-subtle">个性化</div>
                  <div className="px-2.5 py-1 text-codex-subtle">宠物</div>
                  <div className="px-2.5 py-1 text-codex-subtle">键盘快捷键</div>
                </div>
              </div>
            </div>

            {/* 分组：已归档 */}
            <div className="pt-2 border-t border-hairline/40">
              <div className="px-2.5 py-1 text-[11px] font-medium text-codex-subtle">
                已归档
              </div>
              <div className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => setActiveSettingsTab("archived")}
                  className={`w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 text-left transition-colors ${
                    activeSettingsTab === "archived"
                      ? "bg-white/[0.08] text-white font-medium"
                      : "text-codex-muted hover:text-white hover:bg-white/[0.04]"
                  }`}
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>已归档的聊天</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 2. 右侧设置详情面板 (Settings Content) */}
        <div className="flex-1 overflow-y-auto p-6 scrollbar-thin text-xs text-codex-text">
          {/* TAB 1: 常规 (对标截图 3) */}
          {activeSettingsTab === "general" && (
            <div className="space-y-6">
              {/* 权限控制卡片 */}
              <div className="p-4 rounded-xl bg-[#1A1A1E] border border-hairline space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-white text-sm">默认权限</div>
                    <div className="text-codex-muted text-xs mt-0.5">
                      默认情况下，可以读取和编辑其工作空间中的文件。需要时，它可请求额外访问权限
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateGeneralSettings({
                        defaultPermission: !general.defaultPermission,
                      })
                    }
                    className={`w-10 h-5 rounded-full p-0.5 transition-colors ${
                      general.defaultPermission ? "bg-accent-blue" : "bg-white/20"
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition-transform ${
                        general.defaultPermission ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>

                <div className="h-[1px] bg-hairline/60" />

                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-white text-sm">自动审核</div>
                    <div className="text-codex-muted text-xs mt-0.5">
                      可以读取和编辑其工作空间中的文件。会自动审查额外访问权限请求
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateGeneralSettings({ autoReview: !general.autoReview })
                    }
                    className={`w-10 h-5 rounded-full p-0.5 transition-colors ${
                      general.autoReview ? "bg-accent-blue" : "bg-white/20"
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition-transform ${
                        general.autoReview ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>

                <div className="h-[1px] bg-hairline/60" />

                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-white text-sm">完整访问权限</div>
                    <div className="text-codex-muted text-xs mt-0.5">
                      以完整访问权限运行时，无需批准即可编辑电脑上的任何文件并运行网络命令
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateGeneralSettings({ fullAccess: !general.fullAccess })
                    }
                    className={`w-10 h-5 rounded-full p-0.5 transition-colors ${
                      general.fullAccess ? "bg-accent-blue" : "bg-white/20"
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition-transform ${
                        general.fullAccess ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* 常规设置字段 */}
              <div className="space-y-4">
                <div className="text-sm font-semibold text-white">常规</div>

                {/* 默认打开目标 */}
                <div className="flex items-center justify-between py-1">
                  <div>
                    <div className="font-medium text-white">默认文件打开目标</div>
                    <div className="text-codex-muted text-xs">默认打开文件和文件夹的位置</div>
                  </div>
                  <select
                    value={general.defaultFileOpener}
                    onChange={(e) =>
                      updateGeneralSettings({
                        defaultFileOpener: e.target.value as "VS Code" | "Cursor" | "System",
                      })
                    }
                    className="h-8 px-3 rounded-lg bg-[#1A1A1E] border border-hairline text-xs text-codex-text outline-none"
                  >
                    <option value="VS Code">VS Code</option>
                    <option value="Cursor">Cursor</option>
                    <option value="System">系统默认</option>
                  </select>
                </div>

                {/* 语言 */}
                <div className="flex items-center justify-between py-1">
                  <div>
                    <div className="font-medium text-white">语言</div>
                    <div className="text-codex-muted text-xs">应用 UI 语言</div>
                  </div>
                  <select
                    value={general.language}
                    onChange={(e) =>
                      updateGeneralSettings({
                        language: e.target.value as "zh-CN" | "en-US",
                      })
                    }
                    className="h-8 px-3 rounded-lg bg-[#1A1A1E] border border-hairline text-xs text-codex-text outline-none"
                  >
                    <option value="zh-CN">简体中文</option>
                    <option value="en-US">English</option>
                  </select>
                </div>

                {/* 在菜单栏中显示 */}
                <div className="flex items-center justify-between py-1">
                  <div>
                    <div className="font-medium text-white">在菜单栏中显示</div>
                    <div className="text-codex-muted text-xs">
                      关闭主窗口后，仍保留在后台或菜单栏
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateGeneralSettings({
                        showInMenuBar: !general.showInMenuBar,
                      })
                    }
                    className={`w-10 h-5 rounded-full p-0.5 transition-colors ${
                      general.showInMenuBar ? "bg-accent-blue" : "bg-white/20"
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition-transform ${
                        general.showInMenuBar ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>

                {/* 默认终端位置 */}
                <div className="flex items-center justify-between py-1">
                  <div>
                    <div className="font-medium text-white">默认终端位置</div>
                    <div className="text-codex-muted text-xs">
                      选择终端快捷键和环境操作在何处打开终端标签页
                    </div>
                  </div>
                  <div className="flex rounded-lg bg-[#1A1A1E] border border-hairline p-0.5">
                    <button
                      type="button"
                      onClick={() =>
                        updateGeneralSettings({ defaultTerminalPosition: "bottom" })
                      }
                      className={`px-3 py-1 rounded-md text-xs transition-colors ${
                        general.defaultTerminalPosition === "bottom"
                          ? "bg-white/[0.1] text-white font-medium"
                          : "text-codex-muted"
                      }`}
                    >
                      底部
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateGeneralSettings({ defaultTerminalPosition: "right" })
                      }
                      className={`px-3 py-1 rounded-md text-xs transition-colors ${
                        general.defaultTerminalPosition === "right"
                          ? "bg-white/[0.1] text-white font-medium"
                          : "text-codex-muted"
                      }`}
                    >
                      右侧
                    </button>
                  </div>
                </div>

                {/* 运行时防止休眠 */}
                <div className="flex items-center justify-between py-1">
                  <div>
                    <div className="font-medium text-white">运行时防止系统休眠</div>
                    <div className="text-codex-muted text-xs">
                      在运行任务时，让电脑保持唤醒状态
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateGeneralSettings({
                        preventSleep: !general.preventSleep,
                      })
                    }
                    className={`w-10 h-5 rounded-full p-0.5 transition-colors ${
                      general.preventSleep ? "bg-accent-blue" : "bg-white/20"
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition-transform ${
                        general.preventSleep ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: 个人资料 */}
          {activeSettingsTab === "profile" && (
            <div className="space-y-5">
              <div className="text-sm font-semibold text-white">个人资料</div>
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-full bg-[#D9383A] text-white flex items-center justify-center font-bold text-lg shadow-md">
                  {profile.avatarText}
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium text-white">{profile.name}</div>
                  <div className="text-xs text-codex-muted">{profile.email}</div>
                </div>
              </div>

              <div className="space-y-3 pt-2">
                <div>
                  <label className="block text-xs font-medium text-codex-muted mb-1">
                    用户昵称
                  </label>
                  <input
                    type="text"
                    value={profile.name}
                    onChange={(e) => updateProfileSettings({ name: e.target.value })}
                    className="w-full h-9 px-3 rounded-lg bg-[#1A1A1E] border border-hairline text-xs text-white outline-none focus:border-accent-blue"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-codex-muted mb-1">
                    邮箱地址
                  </label>
                  <input
                    type="email"
                    value={profile.email}
                    onChange={(e) => updateProfileSettings({ email: e.target.value })}
                    className="w-full h-9 px-3 rounded-lg bg-[#1A1A1E] border border-hairline text-xs text-white outline-none focus:border-accent-blue"
                  />
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: 外观 */}
          {activeSettingsTab === "appearance" && (
            <div className="space-y-5">
              <div className="text-sm font-semibold text-white">界面外观</div>
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="font-medium text-white">字号与内容密度</div>
                  <div className="text-codex-muted text-xs">切换紧凑或舒适行高</div>
                </div>
                <div className="flex rounded-lg bg-[#1A1A1E] border border-hairline p-0.5">
                  <button
                    type="button"
                    onClick={() => setDensity("compact")}
                    className={`px-3 py-1 rounded-md text-xs transition-colors ${
                      density === "compact"
                        ? "bg-white/[0.1] text-white font-medium"
                        : "text-codex-muted"
                    }`}
                  >
                    紧凑
                  </button>
                  <button
                    type="button"
                    onClick={() => setDensity("comfortable")}
                    className={`px-3 py-1 rounded-md text-xs transition-colors ${
                      density === "comfortable"
                        ? "bg-white/[0.1] text-white font-medium"
                        : "text-codex-muted"
                    }`}
                  >
                    舒适
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: 插件与技能 (对标截图 2) */}
          {activeSettingsTab === "plugins" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-hairline pb-3">
                <div>
                  <h3 className="text-base font-medium text-white">技能与插件</h3>
                  <p className="text-xs text-codex-muted mt-0.5">
                    通过任务专用技能扩展 Genesis 的全景工程能力
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    closeSettingsModal();
                    router.push("/marketplace");
                  }}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-white flex items-center gap-1.5 font-medium transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>添加技能</span>
                </button>
              </div>

              {/* 技能网格 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                {[
                  {
                    id: "frontend",
                    name: "Frontend Skill",
                    desc: "Design visually strong landing pages and components...",
                  },
                  {
                    id: "pet",
                    name: "Hatch Pet",
                    desc: "Hatch style-flexible Codex pets and companion widgets",
                  },
                  {
                    id: "image",
                    name: "Image Gen",
                    desc: "Generate or edit images for websites and UI mocks",
                  },
                  {
                    id: "karpathy",
                    name: "Karpathy Guidelines",
                    desc: "Behavioral guidelines to reduce hallucinations and ensure precision",
                  },
                  {
                    id: "docs",
                    name: "OpenAI Docs",
                    desc: "OpenAI and Codex documentation for models and tools",
                  },
                  {
                    id: "petpal",
                    name: "PetPal",
                    desc: "PetPal Taro 前端与 Spring Boot 后端开发协同专有套件",
                  },
                ].map((skill) => (
                  <div
                    key={skill.id}
                    className="p-3.5 rounded-xl bg-[#1A1A1E] border border-hairline flex items-start justify-between gap-3 group hover:border-[#3E3E48] transition-colors"
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center shrink-0">
                        <Puzzle className="w-4 h-4 text-purple-400" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-white text-xs truncate">
                          {skill.name}
                        </div>
                        <div className="text-[11px] text-codex-muted line-clamp-2 mt-0.5">
                          {skill.desc}
                        </div>
                      </div>
                    </div>
                    <Check className="w-4 h-4 text-codex-muted shrink-0" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 5: 已归档的聊天 (完全对标截图样式) */}
          {activeSettingsTab === "archived" && (() => {
            const query = archiveSearchQuery.trim().toLowerCase();
            const projectMap = new Map<string, string>();
            projects.forEach((p) => {
              if (p?.id) projectMap.set(p.id, p.name);
            });

            // 过滤会话
            const filteredSessions = archivedSessions.filter((s) => {
              if (!s) return false;
              const titleMatch = s.title?.toLowerCase().includes(query) ?? false;
              const projName = s.project_id
                ? projectMap.get(s.project_id)?.toLowerCase() || ""
                : "";
              return titleMatch || projName.includes(query);
            });

            // 按项目分组
            const groupMap = new Map<string, typeof archivedSessions>();
            filteredSessions.forEach((s) => {
              const key = s.project_id || "__no_project__";
              if (!groupMap.has(key)) {
                groupMap.set(key, []);
              }
              groupMap.get(key)!.push(s);
            });

            const groups: {
              projectId: string | null;
              projectName: string;
              sessions: typeof archivedSessions;
            }[] = [];

            // 按已有项目列表排序
            projects.forEach((p) => {
              if (groupMap.has(p.id)) {
                groups.push({
                  projectId: p.id,
                  projectName: p.name,
                  sessions: groupMap.get(p.id)!,
                });
                groupMap.delete(p.id);
              }
            });

            // 补充剩余项目与无项目
            groupMap.forEach((sessList, key) => {
              if (key === "__no_project__") {
                groups.push({
                  projectId: null,
                  projectName: "无项目",
                  sessions: sessList,
                });
              } else {
                groups.push({
                  projectId: key,
                  projectName: projectMap.get(key) || "未命名项目",
                  sessions: sessList,
                });
              }
            });

            const totalArchivedCount =
              archivedSessions.length + archivedProjects.length;

            const handleDeleteAll = async () => {
              if (
                window.confirm(
                  `确定要永久删除全部 ${archivedSessions.length} 个已归档的聊天吗？此操作无法撤销。`
                )
              ) {
                for (const s of archivedSessions) {
                  await deleteSession(s.id);
                }
                for (const p of archivedProjects) {
                  await deleteProject(p.id);
                }
              }
            };

            return (
              <div className="space-y-6 max-w-3xl">
                {/* 顶部标题栏与全部删除操作 */}
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-white tracking-tight">
                    已归档的聊天
                  </h2>
                  {totalArchivedCount > 0 && (
                    <button
                      type="button"
                      onClick={handleDeleteAll}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF453A]/10 hover:bg-[#FF453A]/20 border border-[#FF453A]/30 text-[#FF453A] text-xs font-medium transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>全部删除</span>
                    </button>
                  )}
                </div>

                {/* 搜索栏 */}
                <div className="relative">
                  <Search className="w-4 h-4 text-[#8E8E93] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="搜索已归档聊天"
                    value={archiveSearchQuery}
                    onChange={(e) => setArchiveSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-[#1C1C1E] border border-white/[0.08] text-xs text-white placeholder-[#8E8E93] outline-none focus:border-white/20 transition-colors"
                  />
                </div>

                {/* 分组列表区域 */}
                {groups.length === 0 ? (
                  <div className="py-20 text-center text-xs text-[#8E8E93]">
                    {archiveSearchQuery
                      ? "没有匹配的已归档聊天"
                      : "暂无已归档的聊天"}
                  </div>
                ) : (
                  <div className="space-y-5">
                    {groups.map((g) => (
                      <div
                        key={g.projectId || "no-proj"}
                        className="space-y-2"
                      >
                        {/* 分组头部：📁 项目名、聊天计数、更多 */}
                        <div className="flex items-center justify-between px-1">
                          <div className="flex items-center gap-2 text-xs font-medium text-[#ECECED]">
                            <Folder className="w-3.5 h-3.5 text-[#8E8E93]" />
                            <span>{g.projectName}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-[#8E8E93]">
                              {g.sessions.length} 个聊天
                            </span>
                            <button
                              type="button"
                              className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
                            >
                              <MoreHorizontal className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* 分组内容卡片容器 */}
                        <div className="rounded-xl bg-[#1C1C1E] border border-white/[0.06] overflow-hidden divide-y divide-white/[0.04]">
                          {g.sessions.map((s) => (
                            <div
                              key={s.id}
                              className="p-3.5 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
                            >
                              {/* 左侧：标题与格式化时间 */}
                              <div className="min-w-0 pr-4">
                                <div className="text-[13px] font-medium text-white truncate">
                                  {s.title || "未命名会话"}
                                </div>
                                <div className="text-[11px] text-[#8E8E93] mt-1">
                                  {formatArchiveDate(s.updated_at)}
                                </div>
                              </div>

                              {/* 右侧：🗑 单独删除 与 [取消归档] */}
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => deleteSession(s.id)}
                                  title="永久删除"
                                  className="p-1.5 rounded-md text-[#8E8E93] hover:text-[#FF453A] hover:bg-white/[0.06] transition-colors cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => unarchiveSession(s.id)}
                                  className="px-3 py-1 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-[#ECECED] transition-colors cursor-pointer"
                                >
                                  取消归档
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
