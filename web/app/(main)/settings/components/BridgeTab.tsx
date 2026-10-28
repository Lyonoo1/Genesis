"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Radio,
  Check,
  Copy,
  RefreshCw,
  Terminal,
  Folder,
  ShieldCheck,
  Key,
  Eye,
  EyeOff,
  Laptop,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { getAuthToken, getBasePath } from "@/lib/api/client";
import { fetchBridgeStatusApi, BridgeMetadata } from "@/lib/api/bridge";

export function BridgeTab() {
  const [token, setToken] = useState<string>("");
  const [showToken, setShowToken] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [metadata, setMetadata] = useState<BridgeMetadata | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [copiedCmd, setCopiedCmd] = useState<boolean>(false);
  const [copiedToken, setCopiedToken] = useState<boolean>(false);

  // 用户可自适应配置本地目录与服务器地址
  const [targetDir, setTargetDir] = useState<string>("/Users/lyon/Desktop/你的项目");
  const [serverUrl, setServerUrl] = useState<string>("");

  useEffect(() => {
    const currentToken = getAuthToken();
    setToken(currentToken);

    if (typeof window !== "undefined") {
      const full = `${window.location.origin}${getBasePath()}`.replace(/\/+$/, "");
      setServerUrl(full);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const res = await fetchBridgeStatusApi();
      setIsConnected(Boolean(res?.connected));
      setMetadata(res?.metadata || null);
    } catch {
      setIsConnected(false);
      setMetadata(null);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const timer = setInterval(checkStatus, 6000);
    return () => clearInterval(timer);
  }, [checkStatus]);

  const activeServer = serverUrl || "http://124.221.147.57";
  const runCommand = `node scripts/genesis-bridge.mjs --server ${activeServer} --token ${token || "<TOKEN>"} --dir "${targetDir}"`;

  const handleCopyCmd = () => {
    navigator.clipboard.writeText(runCommand);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const handleCopyToken = () => {
    navigator.clipboard.writeText(token);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  };

  return (
    <div className="space-y-8 max-w-4xl text-white">
      {/* 头部标题 */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
          <Radio className="w-6 h-6 text-emerald-400" />
          <span>本地 Bridge 隧道</span>
        </h2>
        <p className="text-xs text-[#8E8E93] mt-1.5 leading-relaxed">
          建立本地 Mac/PC 与云端 Genesis 智能体的专属反向加密安全隧道。无需公网 IP 与 NAT 穿透，让云端 Agent 实时读写你的本地物理代码、检索工程与执行 Shell 终端指令。
        </p>
      </div>

      {/* 状态看板卡片 */}
      <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-[#27272a] pb-4">
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center">
              <span
                className={`w-3.5 h-3.5 rounded-full ${
                  isConnected ? "bg-emerald-500" : "bg-zinc-600"
                }`}
              />
              {isConnected && (
                <span className="absolute w-3.5 h-3.5 rounded-full bg-emerald-400 animate-ping opacity-75" />
              )}
            </div>
            <div>
              <div className="text-sm font-semibold flex items-center gap-2">
                <span>{isConnected ? "本地节点已在线就绪" : "本地节点未连接"}</span>
                {isConnected ? (
                  <span className="text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                    Active
                  </span>
                ) : (
                  <span className="text-[10px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700 px-2 py-0.5 rounded-full">
                    Offline
                  </span>
                )}
              </div>
              <p className="text-xs text-[#8E8E93] mt-0.5">
                {isConnected
                  ? "云端 Agent 工具调用已自动路由至你的本地 Mac 物理环境"
                  : "启动本地 Bridge 客户端后，隧道将在此自动点亮"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={checkStatus}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs bg-[#222226] hover:bg-[#2c2c31] text-zinc-300 transition-colors border border-zinc-700/50 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
            <span>检测状态</span>
          </button>
        </div>

        {/* 节点详细元数据 (已连接时展示) */}
        {isConnected && metadata && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
            <div className="p-3.5 rounded-xl bg-[#141416] border border-[#27272a] space-y-1">
              <div className="text-[11px] text-[#8E8E93] flex items-center gap-1.5">
                <Laptop className="w-3.5 h-3.5 text-blue-400" />
                <span>连接主机 & 系统</span>
              </div>
              <div className="text-xs font-mono font-medium text-white">
                {metadata.hostname || "Local-Machine"} ({metadata.platform} / {metadata.arch})
              </div>
              {metadata.node_version && (
                <div className="text-[10px] text-zinc-500">Node: {metadata.node_version}</div>
              )}
            </div>

            <div className="p-3.5 rounded-xl bg-[#141416] border border-[#27272a] space-y-1">
              <div className="text-[11px] text-[#8E8E93] flex items-center gap-1.5">
                <Folder className="w-3.5 h-3.5 text-amber-400" />
                <span>本地挂载工作区路径</span>
              </div>
              <div className="text-xs font-mono font-medium text-amber-300 truncate" title={metadata.cwd}>
                {metadata.cwd || "."}
              </div>
              <div className="text-[10px] text-zinc-500">所有写操作均限制在该根目录内</div>
            </div>
          </div>
        )}
      </div>

      {/* 一键启动命令卡片 */}
      <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-indigo-400" />
          <h3 className="text-sm font-semibold">快速启动指令</h3>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#A1A1AA]">欲挂载的本地目录路径</label>
              <input
                type="text"
                value={targetDir}
                onChange={(e) => setTargetDir(e.target.value)}
                placeholder="/Users/lyon/Desktop/你的项目"
                className="w-full h-9 px-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs font-mono text-white focus:outline-none focus:border-blue-500/60 transition-colors"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#A1A1AA]">Genesis 云端服务器地址</label>
              <input
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://124.221.147.57"
                className="w-full h-9 px-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs font-mono text-white focus:outline-none focus:border-blue-500/60 transition-colors"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-[#A1A1AA]">
                在本地终端执行以下命令 (已自动拼接凭据与参数)：
              </label>
              <button
                type="button"
                onClick={handleCopyCmd}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
              >
                {copiedCmd ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400 font-medium">已复制命令</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>一键复制指令</span>
                  </>
                )}
              </button>
            </div>

            <div className="relative group">
              <pre className="p-3.5 rounded-xl bg-[#101012] border border-[#2C2C33] text-xs font-mono text-emerald-400 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed select-all">
                {runCommand}
              </pre>
            </div>
          </div>
        </div>
      </div>

      {/* 身份凭据 Token 卡片 */}
      <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="w-5 h-5 text-amber-400" />
            <h3 className="text-sm font-semibold">你的登录凭证 (JWT Token)</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors px-2 py-1 rounded-lg hover:bg-zinc-800 cursor-pointer"
            >
              {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span>{showToken ? "隐藏" : "显示"}</span>
            </button>
            <button
              type="button"
              onClick={handleCopyToken}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-lg hover:bg-zinc-800 cursor-pointer"
            >
              {copiedToken ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-medium">已复制 Token</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>复制 Token</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="p-3 rounded-xl bg-[#141416] border border-[#2C2C33] text-xs font-mono text-zinc-400 break-all select-all">
          {token
            ? showToken
              ? token
              : `${token.slice(0, 16)}••••••••••••••••••••••••••••••••••••••••••••${token.slice(-16)}`
            : "未检测到本地登录凭据，请确保已登录"}
        </div>
      </div>

      {/* 安全与机制保证 */}
      <div className="p-5 rounded-2xl bg-blue-500/5 border border-blue-500/20 space-y-2 text-xs text-zinc-300">
        <div className="flex items-center gap-2 text-blue-400 font-semibold text-sm">
          <ShieldCheck className="w-4 h-4" />
          <span>双向零信任安全机制</span>
        </div>
        <ul className="space-y-1.5 list-disc list-inside text-zinc-400 pl-1">
          <li>
            <strong className="text-zinc-200">防目录穿越：</strong>本地客户端严格校验文件读写边界，任何超出挂载根目录的路径请求（如 <code className="text-amber-300">../</code>）均会被本地客户端直接硬拦截。
          </li>
          <li>
            <strong className="text-zinc-200">即时可控：</strong>只要在本地终端按下 <code className="text-amber-300">Ctrl + C</code>，长连接立刻中断，云端 Agent 即刻丧失一切本地访问权限。
          </li>
          <li>
            <strong className="text-zinc-200">Token 记忆：</strong>本地客户端首次连接成功后会自动将 Token 安全存储在 <code className="text-amber-300">~/.genesis/bridge_token</code>，后续在项目目录下直接运行 <code className="text-emerald-300">node scripts/genesis-bridge.mjs</code> 即可极速连通。
          </li>
        </ul>
      </div>
    </div>
  );
}
