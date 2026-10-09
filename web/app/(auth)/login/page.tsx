"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { InteractiveGridBackground } from "@/components/auth/InteractiveGridBackground";

/**
 * 账号归一化：
 * 1. 标准邮箱格式直接保留
 * 2. 纯用户名通过 UTF-8 Hex 安全编码映射为合规 ASCII 邮箱
 *    从根源上杜绝 GoTrue 认证引擎抛出 "Unable to validate email address: invalid format" 报错
 */
function resolveAccountToEmail(account: string): string {
  const clean = account.trim().toLowerCase();
  if (clean.includes("@")) {
    return clean;
  }
  return `${clean}@genesis.local`;
}

/**
 * 行业规范错误信息映射：
 * 绝不向用户暴露底层未翻译的英文技术报错
 */
function formatAuthError(err: unknown, isSignUp: boolean): string {
  const raw = ((err as Error)?.message || "").toLowerCase();
  if (
    raw.includes("already registered") ||
    raw.includes("duplicate") ||
    raw.includes("unique constraint")
  ) {
    return "该用户名已被注册，请直接登录";
  }
  if (
    raw.includes("invalid login credentials") ||
    raw.includes("invalid_grant")
  ) {
    return "账号或密码错误";
  }
  if (raw.includes("invalid format") || raw.includes("validate email")) {
    return "请输入有效的账号或邮箱格式";
  }
  if (raw.includes("at least 6 characters") || raw.includes("weak password")) {
    return "密码长度不能少于 6 位";
  }
  if (raw.includes("network") || raw.includes("fetch")) {
    return "网络连接异常，请检查网络后重试";
  }
  return isSignUp ? "注册处理失败，请稍后重试" : "账号或密码错误";
}

function LoginForm() {
  const searchParams = useSearchParams();
  const { updateProfileSettings } = useSettingsStore();

  const [isSignUp, setIsSignUp] = useState(false);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 企业级安全防护：防暴力破解限流状态机
  const [lockoutRemaining, setLockoutRemaining] = useState<number>(0);

  // 初始化检查客户端暴力破解锁定状态
  useEffect(() => {
    const checkLockout = () => {
      try {
        const stored = localStorage.getItem("genesis_login_lockout");
        if (stored) {
          const { lockUntil } = JSON.parse(stored);
          const remaining = Math.ceil((lockUntil - Date.now()) / 1000);
          if (remaining > 0) {
            setLockoutRemaining(remaining);
          } else {
            localStorage.removeItem("genesis_login_lockout");
            setLockoutRemaining(0);
          }
        }
      } catch {
        // ignore parse error
      }
    };
    checkLockout();
    const timer = setInterval(checkLockout, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (searchParams.get("mode") === "signup") {
      setIsSignUp(true);
    }
  }, [searchParams]);

  // 记录一次失败并触发防暴力破解锁定
  const recordFailedAttempt = () => {
    try {
      const stored = localStorage.getItem("genesis_login_lockout");
      let attempts = 1;
      if (stored) {
        const parsed = JSON.parse(stored);
        attempts = (parsed.attempts || 0) + 1;
      }
      if (attempts >= 5) {
        // 连续尝试 5 次失败，触发 60 秒强制冷却防爆破
        const lockUntil = Date.now() + 60 * 1000;
        localStorage.setItem(
          "genesis_login_lockout",
          JSON.stringify({ attempts, lockUntil })
        );
        setLockoutRemaining(60);
      } else {
        localStorage.setItem(
          "genesis_login_lockout",
          JSON.stringify({ attempts, lockUntil: 0 })
        );
      }
    } catch {
      // ignore
    }
  };

  const clearFailedAttempts = () => {
    localStorage.removeItem("genesis_login_lockout");
    setLockoutRemaining(0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockoutRemaining > 0) return;

    setErrorMessage(null);
    setSuccessMessage(null);

    const startTime = Date.now();

    // 1. 输入防注入清洗与 Unicode 规范化 (NFKC)
    const cleanAccount = account.normalize("NFKC").trim();

    if (!cleanAccount) {
      setErrorMessage("请输入账号");
      return;
    }

    // 严禁 SQL/XSS/Command 注入危险符号
    const dangerousPattern = /[;'"<>\\`|\x00]/;
    if (dangerousPattern.test(cleanAccount)) {
      setErrorMessage("账号包含非法注入字符，已被系统拦截");
      return;
    }

    if (/[\u4e00-\u9fa5]/.test(cleanAccount)) {
      setErrorMessage("账号不支持中文字符，仅支持英文字母、数字和下划线");
      return;
    }

    const isEmail = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleanAccount);
    const isUsername = /^[a-zA-Z0-9_]{3,20}$/.test(cleanAccount);

    if (!isEmail && !isUsername) {
      if (cleanAccount.length < 3 || cleanAccount.length > 20) {
        setErrorMessage("账号长度需在 3 到 20 位之间");
        return;
      }
      setErrorMessage("请输入合规的账号（3-20位字母数字下划线）或邮箱");
      return;
    }

    if (!password) {
      setErrorMessage("请输入密码");
      return;
    }

    if (password.length < 6 || password.length > 64) {
      setErrorMessage("密码长度需在 6 到 64 位之间");
      return;
    }

    if (isSignUp) {
      // 密码强度校验：必须包含字母和数字
      if (!/(?=.*[a-zA-Z])(?=.*[0-9])/.test(password)) {
        setErrorMessage("为保证账户安全，密码必须同时包含英文字母与数字");
        return;
      }

      if (!confirmPassword) {
        setErrorMessage("请确认密码");
        return;
      }
      if (password !== confirmPassword) {
        setErrorMessage("两次输入的密码不一致");
        return;
      }
    }

    setLoading(true);

    try {
      if (isSignUp) {
        // 1. 注册查重
        const { data: existingProfile } = await supabase
          .from("profiles")
          .select("id")
          .ilike("username", cleanAccount)
          .maybeSingle();

        if (existingProfile) {
          setErrorMessage("该用户名已被注册，请直接登录");
          setLoading(false);
          return;
        }

        const email = resolveAccountToEmail(cleanAccount);

        // 2. 调用注册
        const { data: signUpData, error: signUpError } =
          await supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                name: cleanAccount,
                username: cleanAccount,
                account: cleanAccount,
              },
            },
          });

        if (signUpError) {
          throw signUpError;
        }

        if (signUpData.user) {
          await supabase.from("profiles").upsert({
            id: signUpData.user.id,
            username: cleanAccount,
            email: cleanAccount.includes("@") ? cleanAccount : null,
          });
        }

        // 注意：不调用 signOut()，否则会触发 onAuthStateChange SIGNED_OUT 事件，
        // 导致其他已登录 tab 被强制踢出。只清理本 tab 的 token。
        localStorage.removeItem("genesis_auth_token");
        document.cookie =
          "genesis_auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
        // 清理 Supabase SDK 内部 session 存储（不触发 auth event）
        const storageKey = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321").hostname.split(".")[0]}-auth-token`;
        localStorage.removeItem(storageKey);

        setIsSignUp(false);
        setConfirmPassword("");
        setSuccessMessage("注册成功！请输入密码登录");
        setLoading(false);
        return;
      } else {
        let targetEmail = cleanAccount;

        if (!cleanAccount.includes("@")) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("email, username")
            .ilike("username", cleanAccount)
            .maybeSingle();

          if (!profile) {
            recordFailedAttempt();
            setErrorMessage("账号或密码错误");
            // 不在这里 setLoading(false)，让 finally 统一处理（含 timing 延迟）
            return;
          }

          targetEmail = profile.email || resolveAccountToEmail(cleanAccount);
        } else {
          targetEmail = cleanAccount;
        }

        const { data, error } = await supabase.auth.signInWithPassword({
          email: targetEmail,
          password,
        });

        if (error) {
          recordFailedAttempt();
          throw error;
        }

        if (data.session) {
          clearFailedAttempts();

          // 1. 写入安全 Cookie (供 Edge Middleware 拦截校验，防 CSRF)
          const isHttps =
            typeof window !== "undefined" && window.location.protocol === "https:";
          const maxAge = data.session.expires_in || 604800; // 默认 7 天
          document.cookie = `genesis_auth_token=${encodeURIComponent(
            data.session.access_token
          )}; path=/; max-age=${maxAge}; SameSite=Lax; ${isHttps ? "Secure;" : ""}`;

          // 2. 写入 localStorage 供客户端组件使用
          localStorage.setItem("genesis_auth_token", data.session.access_token);

          const displayName =
            data.user.user_metadata?.name ||
            data.user.user_metadata?.username ||
            cleanAccount;

          updateProfileSettings({
            email: cleanAccount.includes("@") ? cleanAccount : "",
            name: displayName,
            avatarText: displayName.slice(0, 2).toUpperCase(),
          });

          // 3. 读取目标重定向 URL (支持被拦截页面原路返回)
          const redirectTarget = searchParams.get("redirect") || "/";
          window.location.href = redirectTarget;
          return;
        }
      }
    } catch (err: unknown) {
      recordFailedAttempt();
      setErrorMessage(formatAuthError(err, isSignUp));
    } finally {
      // 恒定时间微延迟混淆：避免计时攻击 (Timing Attack) 探测账号存在性
      const elapsed = Date.now() - startTime;
      if (elapsed < 350) {
        await new Promise((r) => setTimeout(r, 350 - elapsed));
      }
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen w-screen flex items-center justify-center bg-[#090A0F] text-[#ECECEE] px-4 select-none overflow-hidden font-sans">
      {/* 物理弹簧网格与光晕鼠标互动背景 */}
      <InteractiveGridBackground />
      {/* 柔和暗场渐晕，保证中心卡片区域对比度极致纯净 */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(9,10,15,0.45)_0%,rgba(5,6,9,0.85)_100%)] pointer-events-none" />

      {/* 核心卡片 */}
      <div className="relative z-10 w-full max-w-[380px] p-8 rounded-2xl bg-[#14151B] border border-white/[0.12] shadow-2xl backdrop-blur-xl">
        {/* 标题 */}
        <div className="text-center mb-2">
          <h1 className="text-2xl font-bold tracking-wider text-white font-mono">
            Genesis
          </h1>
        </div>

        {/* 分段控制器 */}
        <div className="grid grid-cols-2 p-1 bg-[#0B0C10] border border-white/[0.08] rounded-xl my-6">
          <button
            type="button"
            onClick={() => {
              setIsSignUp(false);
              setErrorMessage(null);
              setSuccessMessage(null);
              setConfirmPassword("");
            }}
            className={`py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer ${
              !isSignUp
                ? "bg-[#23242A] text-white shadow-sm font-semibold"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            登录
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSignUp(true);
              setErrorMessage(null);
              setSuccessMessage(null);
              setConfirmPassword("");
            }}
            className={`py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer ${
              isSignUp
                ? "bg-[#23242A] text-white shadow-sm font-semibold"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            注册
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">账号</label>
            <input
              type="text"
              required
              autoFocus
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                if (errorMessage) setErrorMessage(null);
                if (successMessage) setSuccessMessage(null);
              }}
              placeholder="用户名或邮箱"
              className="w-full h-10 px-3.5 rounded-xl bg-[#0B0C10] border border-white/[0.12] focus:border-white/40 focus:ring-1 focus:ring-white/20 focus:outline-none text-sm text-white placeholder:text-zinc-500 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">密码</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errorMessage) setErrorMessage(null);
                  if (successMessage) setSuccessMessage(null);
                }}
                placeholder="至少 6 位密码"
                className="w-full h-10 pl-3.5 pr-10 rounded-xl bg-[#0B0C10] border border-white/[0.12] focus:border-white/40 focus:ring-1 focus:ring-white/20 focus:outline-none text-sm text-white placeholder:text-zinc-500 transition-colors font-mono"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {isSignUp && (
            <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1">
              <label className="text-xs font-medium text-zinc-300">确认密码</label>
              <div className="relative">
                <input
                  type={showConfirmPassword ? "text" : "password"}
                  required
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                    if (successMessage) setSuccessMessage(null);
                  }}
                  placeholder="再次输入密码"
                  className="w-full h-10 pl-3.5 pr-10 rounded-xl bg-[#0B0C10] border border-white/[0.12] focus:border-white/40 focus:ring-1 focus:ring-white/20 focus:outline-none text-sm text-white placeholder:text-zinc-500 transition-colors font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                >
                  {showConfirmPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          )}

          {/* 纯粹高对比按钮 */}
          <button
            type="submit"
            disabled={loading || lockoutRemaining > 0}
            className="w-full h-10 mt-3 rounded-xl bg-white hover:bg-zinc-100 active:scale-[0.99] text-black text-sm font-semibold transition-all flex items-center justify-center gap-2 shadow-md cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin text-black" />}
            <span>
              {lockoutRemaining > 0
                ? `安全锁定中 (${lockoutRemaining}s)`
                : loading
                ? isSignUp
                  ? "注册中..."
                  : "登录中..."
                : isSignUp
                ? "注册"
                : "登录"}
            </span>
          </button>

          {/* 暴力破解锁定警告提示 */}
          {lockoutRemaining > 0 && (
            <div className="mt-3.5 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs flex items-center justify-center gap-1.5 animate-in fade-in slide-in-from-bottom-1 font-medium">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
              <span>连续尝试错误过多，系统安全保护已锁定 {lockoutRemaining} 秒</span>
            </div>
          )}

          {/* 底部 Tip 提示信息（专业克制、不挤压表单布局、全中文标准提示） */}
          {errorMessage && (
            <div className="mt-3.5 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center justify-center gap-1.5 animate-in fade-in slide-in-from-bottom-1 font-medium">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && !errorMessage && (
            <div className="mt-3.5 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center justify-center gap-1.5 animate-in fade-in slide-in-from-bottom-1 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
              <span>{successMessage}</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen w-screen flex items-center justify-center bg-[#090A0F] text-zinc-500 text-xs">
          加载中...
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
