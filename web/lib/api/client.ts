const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("genesis_auth_token") || "";
}

export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const token = getAuthToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    // Token 过期或无效时，自动清理并跳转登录
    if (res.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("genesis_auth_token");
      document.cookie =
        "genesis_auth_token=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
      window.location.href = "/login";
      // 抛出错误阻止后续代码执行
      throw new Error("Session expired");
    }
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `HTTP ${res.status}`);
  }

  return res.json();
}
