"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, FolderLock, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { useConfirmationStore } from "./store/useConfirmationStore";
import {
  clearSessionGrants,
  clearWorkspacePermissionRules,
  deleteWorkspacePermissionRule,
  fetchSessionGrants,
  fetchWorkspacePermissionRules,
} from "./engine/transport";
import type {
  ConfirmStyle,
  PermissionMode,
  WorkspacePermissionRule,
} from "./types/protocol";
import { useSessionStore } from "@/stores/useSessionStore";

const STYLE_OPTIONS: Array<{
  id: ConfirmStyle;
  name: string;
  desc: string;
  swatchBg: string;
  swatchAccent: string;
  swatchBorder: string;
}> = [
  {
    id: "auto",
    name: "自动（默认 Charcoal）",
    desc: "优先跟随服务端提示，默认使用 Charcoal 冷炭审阅台",
    swatchBg: "#212121",
    swatchAccent: "#FFFFFF",
    swatchBorder: "#333333",
  },
  {
    id: "codex_desktop",
    name: "Charcoal",
    desc: "冷炭审阅台 · 绿点状态、8 行紧凑展开审阅、高对比黑白胶囊",
    swatchBg: "#212121",
    swatchAccent: "#22C55E",
    swatchBorder: "#333333",
  },
  {
    id: "claude_desktop",
    name: "Parchment",
    desc: "暖炭羊皮纸 · Newsreader 人文衬线问句、单描边陶土橙",
    swatchBg: "#242320",
    swatchAccent: "#C96442",
    swatchBorder: "rgba(222,220,209,0.22)",
  },
  {
    id: "google_aistudio",
    name: "Material",
    desc: "色阶引导流 · 无边框大圆角色阶容器、冰蓝 Pill 胶囊",
    swatchBg: "#1E1F20",
    swatchAccent: "#A8C7FA",
    swatchBorder: "transparent",
  },
];

const PERMISSION_MODE_OPTIONS: Array<{
  id: PermissionMode;
  label: string;
  badge: string;
  desc: string;
}> = [
  {
    id: "accept_edits",
    label: "编辑放行（低打扰）",
    badge: "默认",
    desc: "常规文件编辑与只读/非破坏命令直接放行；高危破坏命令、删除、敏感与越权路径强制弹窗审批",
  },
  {
    id: "default",
    label: "标准命令审批",
    badge: "均衡",
    desc: "常规文件编辑与只读命令放行；所有非只读终端命令（如安装依赖、提交代码）及高危操作均弹窗审批",
  },
  {
    id: "review_all",
    label: "全量 Diff 审阅",
    badge: "严格",
    desc: "所有常规文件写入/编辑均弹出 Diff 审阅卡，非只读命令与高危操作同样弹窗审批",
  },
];

export type SwitcherSection = "permissions" | "style" | "grants";

export interface StylePreferenceSwitcherProps {
  sessionId?: string | null;
  sections?: SwitcherSection[];
}

const DEFAULT_SECTIONS: SwitcherSection[] = ["permissions", "style", "grants"];

/**
 * 设置面板完整确认交互配置块：
 * 1. 气泡风格切换（Auto / Charcoal / Parchment / Material）
 * 2. 3 档权限审批粒度开关（accept_edits / default / review_all）
 * 3. 允许 Agent 主动发起澄清提问开关（agent__ask_user）
 * 4. 当前会话已授权白名单查看与一键清空
 */
export function StylePreferenceSwitcher({
  sessionId,
  sections = DEFAULT_SECTIONS,
}: StylePreferenceSwitcherProps) {
  const showPermissions = sections.includes("permissions");
  const showStyle = sections.includes("style");
  const showGrants = sections.includes("grants");
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const targetSessionId = sessionId ?? activeSessionId ?? null;

  const style = useConfirmationStore((s) => s.style);
  const permissionMode = useConfirmationStore((s) => s.permissionMode);
  const allowAskUser = useConfirmationStore((s) => s.allowAskUser);
  const hydrated = useConfirmationStore((s) => s.hydrated);
  const hydratePreferences = useConfirmationStore((s) => s.hydratePreferences);
  const setStyle = useConfirmationStore((s) => s.setStyle);
  const setPermissionMode = useConfirmationStore((s) => s.setPermissionMode);
  const setAllowAskUser = useConfirmationStore((s) => s.setAllowAskUser);

  const syncedGrants = useConfirmationStore((s) =>
    targetSessionId ? s.grantsBySession[targetSessionId] : undefined
  );

  const [grants, setGrants] = useState<string[]>([]);
  const [loadingGrants, setLoadingGrants] = useState(false);
  const [clearing, setClearing] = useState(false);

  const [wsRules, setWsRules] = useState<WorkspacePermissionRule[]>([]);
  const [loadingWsRules, setLoadingWsRules] = useState(false);
  const [clearingWsRules, setClearingWsRules] = useState(false);

  useEffect(() => {
    if (!hydrated) {
      hydratePreferences();
    }
  }, [hydrated, hydratePreferences]);

  useEffect(() => {
    if (syncedGrants) {
      setGrants(syncedGrants);
    }
  }, [syncedGrants]);

  const loadGrants = useCallback(async () => {
    if (!showGrants || !targetSessionId) {
      setGrants([]);
      return;
    }
    setLoadingGrants(true);
    try {
      const list = await fetchSessionGrants(targetSessionId);
      setGrants(list);
    } catch {
      setGrants([]);
    } finally {
      setLoadingGrants(false);
    }
  }, [showGrants, targetSessionId]);

  const loadWsRules = useCallback(async () => {
    if (!showGrants) {
      setWsRules([]);
      return;
    }
    setLoadingWsRules(true);
    try {
      const list = await fetchWorkspacePermissionRules();
      setWsRules(list);
    } catch {
      setWsRules([]);
    } finally {
      setLoadingWsRules(false);
    }
  }, [showGrants]);

  useEffect(() => {
    if (!showGrants) return;
    void loadGrants();
    void loadWsRules();
  }, [showGrants, loadGrants, loadWsRules]);

  const handleClearGrants = async () => {
    if (!targetSessionId || clearing) return;
    setClearing(true);
    try {
      await clearSessionGrants(targetSessionId);
      setGrants([]);
    } finally {
      setClearing(false);
    }
  };

  const handleDeleteWsRule = async (ruleId: string) => {
    try {
      await deleteWorkspacePermissionRule(ruleId);
      setWsRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch {}
  };

  const handleClearWsRules = async (workspaceKey?: string) => {
    if (clearingWsRules) return;
    setClearingWsRules(true);
    try {
      await clearWorkspacePermissionRules(workspaceKey);
      setWsRules((prev) =>
        workspaceKey ? prev.filter((r) => r.workspace_key !== workspaceKey) : []
      );
    } finally {
      setClearingWsRules(false);
    }
  };

  const groupedWsRules = useMemo(() => {
    const map = new Map<
      string,
      { workspaceKey: string; label: string; rules: WorkspacePermissionRule[] }
    >();
    for (const rule of wsRules) {
      const existing = map.get(rule.workspace_key);
      if (existing) {
        existing.rules.push(rule);
      } else {
        map.set(rule.workspace_key, {
          workspaceKey: rule.workspace_key,
          label: rule.workspace_label || rule.workspace_key.slice(0, 10),
          rules: [rule],
        });
      }
    }
    return Array.from(map.values());
  }, [wsRules]);

  return (
    <div className="space-y-5">
      {/* 1. 权限审批触发粒度（3 档开关） */}
      {showPermissions && (
      <div className="p-4 rounded-xl bg-[#1A1A1E] border border-hairline space-y-3">
        <div>
          <div className="font-medium text-white text-sm">权限审批粒度</div>
          <div className="text-codex-muted text-xs mt-0.5">
            系统危险命令黑名单在任何模式下永远物理拦截；删除、敏感路径与越权路径禁止会话级白名单放行
          </div>
        </div>
        <div className="space-y-2">
          {PERMISSION_MODE_OPTIONS.map((opt) => {
            const active = permissionMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setPermissionMode(opt.id)}
                className={`w-full px-3.5 py-2.5 rounded-lg border text-left transition-colors flex items-start justify-between gap-3 cursor-pointer ${
                  active
                    ? "bg-white/[0.08] border-white/25 text-white"
                    : "bg-black/20 border-hairline text-codex-text hover:bg-white/[0.04]"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-xs text-white">
                      {opt.label}
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-white/[0.08] text-[10px] text-zinc-300">
                      {opt.badge}
                    </span>
                  </div>
                  <div className="text-[11px] text-codex-muted mt-1 leading-relaxed">
                    {opt.desc}
                  </div>
                </div>
                {active && (
                  <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                )}
              </button>
            );
          })}
        </div>

        <div className="h-[1px] bg-hairline/60 my-2" />

        {/* 允许 Agent 主动发起澄清提问开关 */}
        <div className="flex items-center justify-between gap-4 pt-1">
          <div>
            <div className="font-medium text-white text-sm">
              允许 Agent 主动发起澄清提问
            </div>
            <div className="text-codex-muted text-xs mt-0.5">
              普通与 Plan 模式均受双层防过度提问约束（单轮最多 1 次、单次上限 3 题、连续 2 次跳过自动冷却）
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={allowAskUser}
            onClick={() => setAllowAskUser(!allowAskUser)}
            className={`w-10 h-5 rounded-full p-0.5 transition-colors shrink-0 cursor-pointer ${
              allowAskUser ? "bg-[#007AFF]" : "bg-[#3A3A3C]"
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white transition-transform ${
                allowAskUser ? "translate-x-5" : ""
              }`}
            />
          </button>
        </div>
      </div>
      )}

      {/* 2. 确认气泡视觉风格切换 */}
      {showStyle && (
      <div className="p-4 rounded-xl bg-[#1A1A1E] border border-hairline space-y-3">
        <div>
          <div className="font-medium text-white text-sm">确认气泡视觉风格</div>
          <div className="text-codex-muted text-xs mt-0.5">
            支持热切换，切换时完整保留当前气泡内的已选项、表单草稿、代码展开态与输入框焦点
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {STYLE_OPTIONS.map((opt) => {
            const active = style === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setStyle(opt.id)}
                className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                  active
                    ? "bg-white/[0.08] border-white/30"
                    : "bg-black/20 border-hairline hover:bg-white/[0.04]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-5 h-5 rounded-md flex items-center justify-center shrink-0"
                      style={{
                        backgroundColor: opt.swatchBg,
                        border: `1px solid ${opt.swatchBorder}`,
                      }}
                    >
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: opt.swatchAccent }}
                      />
                    </span>
                    <span className="font-medium text-xs text-white truncate">
                      {opt.name}
                    </span>
                  </div>
                  {active && (
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  )}
                </div>
                <div className="text-[11px] text-codex-muted mt-1.5 leading-snug">
                  {opt.desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      )}

      {/* 3. 当前会话权限白名单管理 */}
      {showGrants && (
      <div className="p-4 rounded-xl bg-[#1A1A1E] border border-hairline space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-medium text-white text-sm flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>当前会话权限白名单</span>
            </div>
            <div className="text-codex-muted text-xs mt-0.5">
              点击「本会话始终允许」后记录的精确签名，仅在当前会话有效
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void loadGrants()}
              disabled={!targetSessionId || loadingGrants}
              className="h-7 px-2.5 rounded-lg border border-hairline text-xs text-codex-muted hover:text-white hover:bg-white/[0.05] disabled:opacity-40 flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw
                className={`w-3 h-3 ${loadingGrants ? "animate-spin" : ""}`}
              />
              <span>刷新</span>
            </button>
            <button
              type="button"
              onClick={() => void handleClearGrants()}
              disabled={!targetSessionId || grants.length === 0 || clearing}
              className="h-7 px-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>一键清空</span>
            </button>
          </div>
        </div>

        {!targetSessionId ? (
          <div className="text-xs text-codex-subtle py-2">
            当前尚未进入具体会话
          </div>
        ) : grants.length === 0 ? (
          <div className="text-xs text-codex-subtle py-2">
            当前会话暂无已授权白名单签名
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {grants.map((sig) => (
              <span
                key={sig}
                className="px-2.5 py-1 rounded-md bg-black/35 border border-hairline text-[11px] font-mono text-zinc-200"
              >
                {sig}
              </span>
            ))}
          </div>
        )}
      </div>
      )}

      {/* 4. 工作区级永久允许权限规则管理（P2-3） */}
      {showGrants && (
      <div className="p-4 rounded-xl bg-[#1A1A1E] border border-hairline space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-medium text-white text-sm flex items-center gap-1.5">
              <FolderLock className="w-4 h-4 text-amber-400" />
              <span>工作区级永久允许规则</span>
            </div>
            <div className="text-codex-muted text-xs mt-0.5">
              跨会话、跨重启持久生效；仅作用于对应工作区，高危操作与危险命令永远不受此规则影响
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void loadWsRules()}
              disabled={loadingWsRules}
              className="h-7 px-2.5 rounded-lg border border-hairline text-xs text-codex-muted hover:text-white hover:bg-white/[0.05] disabled:opacity-40 flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw
                className={`w-3 h-3 ${loadingWsRules ? "animate-spin" : ""}`}
              />
              <span>刷新</span>
            </button>
            <button
              type="button"
              onClick={() => void handleClearWsRules()}
              disabled={wsRules.length === 0 || clearingWsRules}
              className="h-7 px-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>全部清空</span>
            </button>
          </div>
        </div>

        {groupedWsRules.length === 0 ? (
          <div className="text-xs text-codex-subtle py-2">
            暂无工作区级永久允许规则
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            {groupedWsRules.map((group) => (
              <div
                key={group.workspaceKey}
                className="rounded-lg bg-black/25 border border-hairline/70 p-2.5 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-200 truncate">
                    {group.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleClearWsRules(group.workspaceKey)}
                    className="text-[11px] text-rose-300/80 hover:text-rose-200 cursor-pointer"
                  >
                    清空此工作区
                  </button>
                </div>
                <div className="space-y-1.5">
                  {group.rules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-black/30 border border-hairline/50"
                    >
                      <div className="min-w-0">
                        <div className="text-[11px] font-mono text-zinc-100 truncate">
                          {rule.scope_signature}
                        </div>
                        <div className="text-[10px] text-codex-subtle">
                          创建：{rule.created_at.slice(0, 16).replace("T", " ")}
                          {rule.last_used_at
                            ? ` · 最近使用：${rule.last_used_at.slice(0, 16).replace("T", " ")}`
                            : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDeleteWsRule(rule.id)}
                        title="删除此规则"
                        className="p-1 rounded text-codex-muted hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
