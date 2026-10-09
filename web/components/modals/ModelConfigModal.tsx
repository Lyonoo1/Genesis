"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  X,
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
} from "lucide-react";
import {
  useModelConfigStore,
} from "@/stores/useModelConfigStore";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export function ModelConfigModal() {
  const {
    models,
    activeModelId,
    isConfigModalOpen,
    closeConfigModal,
    addModel,
    updateModel,
    deleteModel,
    setActiveModelId,
  } = useModelConfigStore();

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

  // 当选择的模型切换或弹窗打开时，同步表单
  useEffect(() => {
    if (!isConfigModalOpen) return;
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
      setContextWindow(target.contextWindow ?? (target.maxTokens && target.maxTokens > 65536 ? target.maxTokens : 1048576));
      setIsDefault(target.isDefault || false);
      setTestResult(null);
    }
  }, [selectedId, isConfigModalOpen, models, isCreatingNew, handleStartCreate]);

  // 全局 Esc 快捷键关闭
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isConfigModalOpen) {
        closeConfigModal();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isConfigModalOpen, closeConfigModal]);

  if (!isConfigModalOpen) return null;

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
        maxTokens: 32768,
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
        maxTokens: 32768,
        isDefault,
      });
    }

    setSaveSuccessMsg(true);
    setTimeout(() => setSaveSuccessMsg(false), 2000);
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
          ? "后端服务 (8000 端口) 未连接，请确保后端已启动"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm select-none p-4">
      {/* 弹窗主体容器：左右分栏 */}
      <div className="w-[840px] max-w-full h-[580px] bg-[#181818] border border-[#303033] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
        {/* 1. 顶栏 */}
        <div className="h-14 px-5 border-b border-[#26262B] flex items-center justify-between bg-[#18181B] shrink-0">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-4 h-4 text-[#8E8E93]" />
            <div>
              <div className="text-sm font-semibold text-white tracking-wide">
                自定义模型与 API 密钥
              </div>
              <div className="text-[11px] text-[#8E8E93]">
                配置你的大语言模型端点，密钥仅持久化在本地浏览器客户端中
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={closeConfigModal}
            className="p-1.5 rounded-lg text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-colors"
            title="关闭 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 2. 左右分栏核心区域 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧栏：模型列表导航 (宽度 240px) */}
          <div className="w-60 border-r border-[#26262B] bg-[#161618] flex flex-col shrink-0">
            {/* 顶部新增按钮 */}
            <div className="p-3 border-b border-[#26262B]/80">
              <button
                type="button"
                onClick={handleStartCreate}
                className={`w-full h-8 px-3 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-all ${
                  isCreatingNew
                    ? "bg-white text-black font-semibold shadow-sm"
                    : "bg-white/[0.06] hover:bg-white/[0.1] text-white border border-white/[0.08]"
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>添加模型</span>
              </button>
            </div>

            {/* 模型列表 */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {models.length === 0 ? (
                <div className="p-4 text-center text-[11px] text-[#71717A] space-y-1.5 mt-4">
                  <div className="font-medium text-[#A1A1AA]">暂无已配置模型</div>
                  <div className="text-[10px] text-[#52525B] leading-relaxed">
                    点击上方“添加模型”，在右侧输入你自己的模型端点与 API Key
                  </div>
                </div>
              ) : (
                models.map((m) => {
                  const isSelected = !isCreatingNew && m.id === selectedId;
                  const isCurrentActive = m.id === activeModelId;

                  return (
                    <div
                      key={m.id}
                      onClick={() => handleSelectModel(m.id)}
                      className={`group relative px-3 py-2 rounded-xl text-xs cursor-pointer flex items-center justify-between transition-all ${
                        isSelected
                          ? "bg-[#222227] text-white border border-[#383842]"
                          : "text-[#A1A1AA] hover:text-white hover:bg-white/[0.04]"
                      }`}
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium truncate">{m.name}</span>
                          {m.isDefault && (
                            <span className="px-1.5 py-0.2 text-[9px] bg-blue-500/20 text-blue-400 rounded font-normal shrink-0">
                              默认
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-[#71717A] truncate mt-0.5 font-mono">
                          {m.modelId}
                        </div>
                      </div>

                      {/* 操作项：激活状态或删除按钮 */}
                      <div className="flex items-center gap-1 shrink-0">
                        {isCurrentActive && (
                          <div
                            className="w-2 h-2 rounded-full bg-emerald-500"
                            title="当前会话正在使用"
                          />
                        )}
                        <button
                          type="button"
                          onClick={(e) => handleDelete(m.id, e)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/20 text-[#71717A] hover:text-red-400 transition-all"
                          title="删除模型"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* 右侧栏：表单配置区域 */}
          <div className="flex-1 p-6 overflow-y-auto bg-[#181818] flex flex-col justify-between">
            <div className="space-y-4 max-w-lg">
              <div className="text-xs font-semibold text-white tracking-wider flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-[#8E8E93]" />
                <span>
                  {isCreatingNew ? "新建模型配置" : `编辑模型: ${name}`}
                </span>
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
                  className="w-full h-8 px-3 rounded-lg bg-[#1B1B1F] border border-[#2C2C33] text-xs text-white placeholder-[#52525B] focus:outline-none focus:border-[#4B4B55] transition-colors"
                />
              </div>

              {/* 2. 协议类型 */}
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
                  className="w-full h-8 px-2.5 rounded-lg bg-[#1B1B1F] border border-[#2C2C33] text-xs text-white focus:outline-none focus:border-[#4B4B55] transition-colors cursor-pointer"
                >
                  <option value="openai">
                    OpenAI 兼容 (OpenAI, DeepSeek, Qwen, Ollama, OneAPI, 中转)
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
                      className="text-[10px] text-[#71717A] hover:text-white underline"
                    >
                      填入 DeepSeek
                    </button>
                    <button
                      type="button"
                      onClick={() => setBaseUrl("https://api.openai.com/v1")}
                      className="text-[10px] text-[#71717A] hover:text-white underline"
                    >
                      填入 OpenAI
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                  className="w-full h-8 px-3 rounded-lg bg-[#1B1B1F] border border-[#2C2C33] text-xs font-mono text-white placeholder-[#52525B] focus:outline-none focus:border-[#4B4B55] transition-colors"
                />
              </div>

              {/* 4. 模型实际标识符 (Model ID) */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[#A1A1AA]">
                  模型名称 (Model ID)
                </label>
                <input
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="如: deepseek-chat, gpt-4o, claude-3-5-sonnet-20241022"
                  className="w-full h-8 px-3 rounded-lg bg-[#1B1B1F] border border-[#2C2C33] text-xs font-mono text-white placeholder-[#52525B] focus:outline-none focus:border-[#4B4B55] transition-colors"
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
                    className="w-full h-8 pl-3 pr-9 rounded-lg bg-[#1B1B1F] border border-[#2C2C33] text-xs font-mono text-white placeholder-[#52525B] focus:outline-none focus:border-[#4B4B55] transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#71717A] hover:text-white transition-colors"
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
                    原生支持高达 1M (1,048,576)
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
                  className="w-full h-8 px-3 rounded-lg bg-[#1B1B1F] border border-[#2C2C33] text-xs font-mono text-white placeholder-[#52525B] focus:outline-none focus:border-[#4B4B55] transition-colors"
                />
                {/* 快捷预设 pills */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {[
                    { label: "64K", val: 65536 },
                    { label: "128K", val: 131072 },
                    { label: "256K", val: 262144 },
                    { label: "512K", val: 524288 },
                    { label: "1M (推荐)", val: 1048576 },
                    { label: "2M", val: 2097152 },
                  ].map((preset) => (
                    <button
                      key={preset.val}
                      type="button"
                      onClick={() => setContextWindow(preset.val)}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-all ${
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
                  💡 <b>上下文窗口容量</b>：模型可处理的历史对话与输入总容量。系统将基于此自动动态分配历史记忆；单次输出已由系统自动根据各模型特性安全接力调配，并内置 Claude 式无感断点续写，绝不中断或报 400 错误。
                </p>
              </div>

              {/* 6. 连通性测试动作 */}
              <div className="pt-1">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={isTesting}
                    onClick={handleTestConnection}
                    className="h-7 px-3 rounded-lg text-xs font-medium bg-[#1F1F24] hover:bg-[#282830] text-white border border-[#2E2E36] flex items-center gap-1.5 transition-colors disabled:opacity-50"
                  >
                    {isTesting ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Zap className="w-3 h-3 text-amber-400" />
                    )}
                    <span>{isTesting ? "测试中..." : "测试连接"}</span>
                  </button>

                  {/* 测通状态显示 */}
                  {testResult && (
                    <div
                      className={`flex items-center gap-1.5 text-xs ${
                        testResult.success ? "text-emerald-400" : "text-red-400"
                      }`}
                    >
                      {testResult.success ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>
                            连接成功 ({testResult.latency_ms ?? 0}ms)
                          </span>
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
              </div>

              {/* 7. 设为默认 */}
              <div className="pt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="model-default"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  className="rounded bg-[#1B1B1F] border-[#2C2C33] text-blue-600 focus:ring-0 cursor-pointer"
                />
                <label
                  htmlFor="model-default"
                  className="text-xs text-[#A1A1AA] cursor-pointer"
                >
                  设为默认模型
                </label>
              </div>
            </div>

            {/* 底部保存与激活操作条 */}
            <div className="pt-4 border-t border-[#26262B] flex items-center justify-between">
              <div>
                {saveSuccessMsg && (
                  <span className="text-xs text-emerald-400 flex items-center gap-1 animate-in fade-in">
                    <Check className="w-3.5 h-3.5" /> 已成功保存配置
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {!isCreatingNew && (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveModelId(selectedId);
                      closeConfigModal();
                    }}
                    className="h-8 px-3 rounded-lg text-xs font-medium text-white hover:bg-white/[0.08] transition-colors"
                  >
                    立即使用此模型
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleSave}
                  className="h-8 px-4 rounded-lg text-xs font-semibold bg-white text-black hover:bg-white/90 shadow-sm transition-all"
                >
                  保存配置
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
