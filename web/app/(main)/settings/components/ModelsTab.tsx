"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  Check,
  Eye,
  EyeOff,
  Zap,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  Server,
  KeyRound,
  Layers,
  Cpu,
  ArrowRight,
} from "lucide-react";
import { useModelConfigStore } from "@/stores/useModelConfigStore";
import { useSessionStore } from "@/stores/useSessionStore";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export function ModelsTab() {
  const {
    models,
    activeModelId,
    addModel,
    updateModel,
    deleteModel,
    setActiveModelId,
  } = useModelConfigStore();

  const { setSelectedModel } = useSessionStore();

  const [selectedId, setSelectedId] = useState<string>(activeModelId);
  const [isCreatingNew, setIsCreatingNew] = useState(false);

  // 表单状态
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState("");
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [contextWindow, setContextWindow] = useState<number>(1048576);
  const [isDefault, setIsDefault] = useState(false);

  // UI 交互状态
  const [showKey, setShowKey] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    latency_ms?: number;
    error?: string;
  } | null>(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState(false);

  // 切换为新建空白模型
  const handleStartCreate = useCallback(() => {
    setIsCreatingNew(true);
    setName("");
    setModelId("");
    setProvider("openai");
    setBaseUrl("");
    setApiKey("");
    setContextWindow(1048576);
    setIsDefault(models.length === 0);
    setTestResult(null);
  }, [models.length]);

  // 当选择的模型切换或初始化时，同步表单
  useEffect(() => {
    if (models.length === 0) {
      handleStartCreate();
      return;
    }
    const target = models.find((m) => m.id === selectedId) || models[0];
    if (target && !isCreatingNew) {
      setSelectedId(target.id);
      setName(target.name);
      setModelId(target.modelId);
      setProvider(target.provider);
      setBaseUrl(target.baseUrl);
      setApiKey(target.apiKey || "");
      setContextWindow(
        target.contextWindow ??
          (target.maxTokens && target.maxTokens > 65536
            ? target.maxTokens
            : 1048576)
      );
      setIsDefault(target.isDefault || false);
      setTestResult(null);
    }
  }, [selectedId, models, isCreatingNew, handleStartCreate]);

  // 切换选择已有模型
  const handleSelectModel = (id: string) => {
    setIsCreatingNew(false);
    setSelectedId(id);
    setTestResult(null);
  };

  // 保存当前模型配置
  const handleSave = () => {
    const trimmedName = name.trim();
    const trimmedModelId = modelId.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();

    if (!trimmedName) {
      setTestResult({ success: false, error: "请输入模型显示名称" });
      return;
    }
    if (!trimmedModelId) {
      setTestResult({ success: false, error: "请输入模型标识 (Model ID)" });
      return;
    }
    if (!trimmedBaseUrl) {
      setTestResult({ success: false, error: "请输入 API Base URL" });
      return;
    }

    if (isCreatingNew || models.length === 0) {
      const newId = addModel({
        name: trimmedName,
        modelId: trimmedModelId,
        provider,
        baseUrl: trimmedBaseUrl,
        apiKey: trimmedApiKey,
        contextWindow: contextWindow || 1048576,
        maxTokens: 8192,
        isDefault: isDefault || models.length === 0,
      });
      setIsCreatingNew(false);
      setSelectedId(newId);
    } else {
      updateModel(selectedId, {
        name: trimmedName,
        modelId: trimmedModelId,
        provider,
        baseUrl: trimmedBaseUrl,
        apiKey: trimmedApiKey,
        contextWindow: contextWindow || 1048576,
        maxTokens: 8192,
        isDefault,
      });
    }

    setSaveSuccessMsg(true);
    setTimeout(() => setSaveSuccessMsg(false), 2500);
  };

  // 删除当前选中的模型
  const handleDelete = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    deleteModel(id);
    const remaining = models.filter((m) => m.id !== id);
    if (remaining.length > 0) {
      setSelectedId(remaining[0].id);
      setIsCreatingNew(false);
    } else {
      handleStartCreate();
    }
  };

  // 激活使用模型
  const handleApplyActive = (targetId: string, targetName: string) => {
    setActiveModelId(targetId);
    setSelectedModel(targetName);
    setSaveSuccessMsg(true);
    setTimeout(() => setSaveSuccessMsg(false), 2000);
  };

  // 连通性测试
  const handleTestConnection = async () => {
    if (!apiKey.trim()) {
      setTestResult({ success: false, error: "请先填入 API Key 再进行测试" });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const res = await fetch(`${API_BASE_URL}/api/chat/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          base_url: baseUrl.trim(),
          api_key: apiKey.trim(),
          model: modelId.trim(),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setTestResult({
          success: data.success,
          latency_ms: data.latency_ms,
          error: data.error,
        });
      } else {
        const errJson = await res.json().catch(() => ({}));
        setTestResult({
          success: false,
          error: errJson?.error?.message || `HTTP ${res.status}`,
        });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const displayMsg =
        errMsg.includes("Failed to fetch")
          ? "后端服务 (8000 端口) 未连接，请确保后端服务已启动"
          : `请求发送失败: ${errMsg}`;
      setTestResult({
        success: false,
        error: displayMsg,
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* 标题说明 */}
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
          <Cpu className="w-6 h-6 text-blue-400" />
          <span>模型配置</span>
        </h2>
        <p className="text-xs text-[#8E8E93] mt-1.5 leading-relaxed">
          管理自定义大语言模型与 API 凭证，支持 DeepSeek、OpenAI、Claude、Ollama、OneAPI 等，配置与密钥仅持久化存储在本地客户端与已连接数据库中。
        </p>
      </div>

      {/* 左右分栏核心区域 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* 左侧：模型列表栏 (4 列) */}
        <div className="lg:col-span-4 bg-[#18181b]/70 border border-[#27272a] rounded-2xl p-4 flex flex-col min-h-[500px]">
          <div className="flex items-center justify-between pb-3 border-b border-[#27272a]/60">
            <span className="text-xs font-semibold text-[#8E8E93] tracking-wide">
              已配置模型 ({models.length})
            </span>
            <button
              type="button"
              onClick={handleStartCreate}
              className={`h-7 px-2.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                isCreatingNew
                  ? "bg-white text-black font-semibold shadow-sm"
                  : "bg-white/[0.08] hover:bg-white/[0.14] text-white border border-white/[0.08]"
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加模型</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto mt-3 space-y-1.5 pr-0.5">
            {models.length === 0 ? (
              <div className="py-12 px-4 text-center text-xs text-[#71717A] space-y-2">
                <Sparkles className="w-8 h-8 text-[#52525B] mx-auto opacity-50" />
                <p className="font-medium text-[#A1A1AA]">暂无已配置模型</p>
                <p className="text-[11px] text-[#52525B]">
                  点击上方“添加模型”，在右侧输入 API 端点与 Key 即可立即启用。
                </p>
              </div>
            ) : (
              models.map((m) => {
                const isSelected = !isCreatingNew && m.id === selectedId;
                const isCurrentActive = m.id === activeModelId;

                return (
                  <div
                    key={m.id}
                    onClick={() => handleSelectModel(m.id)}
                    className={`group relative p-3 rounded-xl text-xs cursor-pointer flex items-center justify-between transition-all border ${
                      isSelected
                        ? "bg-[#222227] text-white border-blue-500/40 shadow-sm"
                        : "text-[#A1A1AA] hover:text-white hover:bg-white/[0.03] border-transparent"
                    }`}
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium truncate text-white">
                          {m.name}
                        </span>
                        {m.isDefault && (
                          <span className="px-1.5 py-0.2 text-[9px] bg-blue-500/20 text-blue-400 rounded font-normal shrink-0">
                            默认
                          </span>
                        )}
                        {isCurrentActive && (
                          <span className="px-1.5 py-0.2 text-[9px] bg-emerald-500/20 text-emerald-400 rounded font-normal shrink-0">
                            当前激活
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-[#71717A] truncate mt-1 font-mono">
                        {m.modelId}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => handleDelete(m.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-red-500/20 text-[#71717A] hover:text-red-400 transition-all cursor-pointer"
                        title="删除模型"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 右侧：表单配置区域 (8 列) */}
        <div className="lg:col-span-8 bg-[#18181b]/70 border border-[#27272a] rounded-2xl p-6 flex flex-col justify-between">
          <div className="space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#27272a]/60">
              <div className="text-xs font-semibold text-white tracking-wider flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-blue-400" />
                <span>
                  {isCreatingNew ? "新建模型配置" : `编辑模型: ${name || "未命名"}`}
                </span>
              </div>

              {!isCreatingNew && (
                <button
                  type="button"
                  onClick={() => handleApplyActive(selectedId, name)}
                  className={`h-7 px-2.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                    activeModelId === selectedId
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                      : "bg-white/[0.06] hover:bg-white/[0.1] text-white border border-[#3E3E48]"
                  }`}
                >
                  <ArrowRight className="w-3 h-3" />
                  <span>
                    {activeModelId === selectedId ? "已设为当前激活" : "设为当前激活模型"}
                  </span>
                </button>
              )}
            </div>

            {/* 1. 模型显示名称 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#A1A1AA]">
                显示名称
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如: DeepSeek V3 / 公司中转 GPT-4o"
                className="w-full h-9 px-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs text-white placeholder-[#52525B] focus:outline-none focus:border-blue-500/60 transition-colors"
              />
            </div>

            {/* 2. 接口协议 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#A1A1AA] flex items-center justify-between">
                <span>接口协议</span>
                <span className="text-[10px] text-[#71717A]">
                  标准 OpenAI 或 Anthropic Messages
                </span>
              </label>
              <select
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as "openai" | "anthropic";
                  setProvider(p);
                  if (p === "openai" && !baseUrl) {
                    setBaseUrl("https://api.deepseek.com/v1");
                  } else if (p === "anthropic" && !baseUrl) {
                    setBaseUrl("https://api.anthropic.com/v1");
                  }
                }}
                className="w-full h-9 px-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs text-white focus:outline-none focus:border-blue-500/60 transition-colors cursor-pointer"
              >
                <option value="openai">
                  OpenAI 兼容 (OpenAI, DeepSeek, Qwen, Ollama, OneAPI, 中转等)
                </option>
                <option value="anthropic">
                  Anthropic 原生 (Claude 官方与反向代理)
                </option>
              </select>
            </div>

            {/* 3. API Base URL */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-[#A1A1AA] flex items-center gap-1.5">
                  <Server className="w-3 h-3 text-[#71717A]" />
                  <span>API Base URL</span>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setBaseUrl("https://api.deepseek.com/v1")}
                    className="text-[10px] text-blue-400/80 hover:text-blue-300 underline cursor-pointer"
                  >
                    填入 DeepSeek
                  </button>
                  <button
                    type="button"
                    onClick={() => setBaseUrl("https://api.openai.com/v1")}
                    className="text-[10px] text-blue-400/80 hover:text-blue-300 underline cursor-pointer"
                  >
                    填入 OpenAI
                  </button>
                  <button
                    type="button"
                    onClick={() => setBaseUrl("http://localhost:11434/v1")}
                    className="text-[10px] text-blue-400/80 hover:text-blue-300 underline cursor-pointer"
                  >
                    填入 Ollama 本地
                  </button>
                </div>
              </div>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.deepseek.com/v1"
                className="w-full h-9 px-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs font-mono text-white placeholder-[#52525B] focus:outline-none focus:border-blue-500/60 transition-colors"
              />
            </div>

            {/* 4. 模型标识 Model ID */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#A1A1AA]">
                模型标识 (Model ID)
              </label>
              <input
                type="text"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="如: deepseek-chat, deepseek-reasoner, gpt-4o, claude-3-5-sonnet"
                className="w-full h-9 px-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs font-mono text-white placeholder-[#52525B] focus:outline-none focus:border-blue-500/60 transition-colors"
              />
            </div>

            {/* 5. API Key */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#A1A1AA] flex items-center gap-1.5">
                <KeyRound className="w-3 h-3 text-[#71717A]" />
                <span>API Key</span>
              </label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full h-9 pl-3 pr-10 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs font-mono text-white placeholder-[#52525B] focus:outline-none focus:border-blue-500/60 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#71717A] hover:text-white transition-colors cursor-pointer"
                  title={showKey ? "隐藏密钥" : "查看密钥"}
                >
                  {showKey ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>

            {/* 6. 最大上下文容量 (Context Window) */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-[#A1A1AA] flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  <span>最大上下文容量 (Context Window)</span>
                </label>
                <span className="text-[10px] text-[#71717A]">
                  最高支持 1M (1,048,576) ~ 2M
                </span>
              </div>
              <input
                type="number"
                min={4096}
                max={2097152}
                step={1024}
                value={contextWindow}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setContextWindow(isNaN(val) ? 1048576 : val);
                }}
                placeholder="默认 1048576 (1M)"
                className="w-full h-9 px-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs font-mono text-white placeholder-[#52525B] focus:outline-none focus:border-blue-500/60 transition-colors"
              />
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {[
                  { label: "64K (DeepSeek官方)", val: 65536 },
                  { label: "128K (标准扩展)", val: 131072 },
                  { label: "256K", val: 262144 },
                  { label: "512K", val: 524288 },
                  { label: "1M (推荐)", val: 1048576 },
                  { label: "2M", val: 2097152 },
                ].map((preset) => (
                  <button
                    key={preset.val}
                    type="button"
                    onClick={() => setContextWindow(preset.val)}
                    className={`px-2 py-0.5 rounded-md text-[10px] font-mono border transition-all cursor-pointer ${
                      contextWindow === preset.val
                        ? "bg-white text-black border-white font-semibold"
                        : "bg-[#18181B] text-[#A1A1AA] border-[#2E2E36] hover:text-white hover:border-[#3E3E48]"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-[#71717A] leading-relaxed pt-0.5">
                💡 <b>最大上下文容量</b>：包含用户输入文档、历史对话及 AI 回答的全局记忆总上限。系统将依此自动分配滑动上下文预算并动态修剪历史分支；DeepSeek 官方标准上下文为 <b>64K</b>，长文本模型（如 Kimi / Gemini）可直接设为 <b>1M</b>。
              </p>
            </div>

            {/* 7. 连通性测试与设为默认 */}
            <div className="pt-2 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={isTesting}
                  onClick={handleTestConnection}
                  className="h-8 px-3.5 rounded-xl text-xs font-medium bg-[#1F1F24] hover:bg-[#282830] text-white border border-[#2E2E36] flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {isTesting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  <span>{isTesting ? "测试中..." : "测试连接"}</span>
                </button>

                {testResult && (
                  <div
                    className={`flex items-center gap-1.5 text-xs ${
                      testResult.success ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {testResult.success ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>连接成功 ({testResult.latency_ms ?? 0}ms)</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate max-w-xs text-[11px]">
                          {testResult.error || "连接失败"}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="model-default-page"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  className="rounded bg-[#141416] border-[#2C2C33] text-blue-600 focus:ring-0 cursor-pointer"
                />
                <label
                  htmlFor="model-default-page"
                  className="text-xs text-[#A1A1AA] cursor-pointer"
                >
                  设为默认模型
                </label>
              </div>
            </div>
          </div>

          {/* 底部保存与提示 */}
          <div className="pt-6 mt-6 border-t border-[#27272a]/60 flex items-center justify-between">
            <div>
              {saveSuccessMsg && (
                <span className="text-xs text-emerald-400 flex items-center gap-1.5 animate-in fade-in">
                  <Check className="w-4 h-4" /> 已成功保存配置
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                className="h-8 px-5 rounded-xl text-xs font-semibold bg-white text-black hover:bg-white/90 shadow-sm transition-all cursor-pointer"
              >
                保存模型配置
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
