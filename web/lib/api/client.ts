export function getBasePath(): string {
  if (process.env.NEXT_PUBLIC_BASE_PATH !== undefined) {
    return process.env.NEXT_PUBLIC_BASE_PATH;
  }
  return "/genesis";
}

export function getApiBaseUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (envUrl !== undefined && envUrl !== "") {
    return envUrl.replace(/\/+$/, "");
  }
  const bp = getBasePath().replace(/\/+$/, "");
  if (typeof window !== "undefined") {
    // 浏览器运行环境：默认带上二级目录前缀 (如 /genesis)；桌面端为空串时使用同源相对路径 ""
    return bp;
  }
  return "http://localhost:8000";
}

const API_BASE_URL = getApiBaseUrl();

export function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("genesis_auth_token") || "";
}

export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const token = getAuthToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };

  const controller = new AbortController();
  const timeoutMs = options.timeout ?? 15000;
  const timeoutId = setTimeout(() => {
    controller.abort(new Error("请求超时，服务未在规定时间内响应"));
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: options.signal || controller.signal,
    });

    if (!res.ok) {
      // Token 过期或无效时，桌面端优先尝试静默刷新
      if (res.status === 401 && typeof window !== "undefined") {
        const isDesktopEnv =
          Boolean((window as any).electronAPI?.isDesktop) ||
          process.env.NEXT_PUBLIC_BASE_PATH === "";
        if (isDesktopEnv && !endpoint.includes("/auth/silent-login")) {
          try {
            const silentRes = await fetch(`${baseUrl}/api/auth/silent-login`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            });
            if (silentRes.ok) {
              const data = await silentRes.json();
              if (data?.access_token) {
                localStorage.setItem("genesis_auth_token", data.access_token);
                document.cookie = `genesis_auth_token=${encodeURIComponent(
                  data.access_token
                )}; path=/; max-age=2592000; SameSite=Lax;`;
                return apiFetch<T>(endpoint, options);
              }
            }
          } catch {}
        }

        localStorage.removeItem("genesis_auth_token");
        document.cookie =
          "genesis_auth_token=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
        window.location.href = `${getBasePath()}/login`;
        throw new Error("Session expired");
      }
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData?.error?.message || `HTTP ${res.status}`);
    }

    return res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}
