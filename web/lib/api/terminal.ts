import { apiFetch } from "./client";

export interface TerminalSessionItem {
  id: string;
  title: string;
  cwd: string;
  pid?: number;
  is_alive: boolean;
  created_at: string;
}

export interface TerminalCreatePayload {
  id?: string;
  title?: string;
  cwd?: string;
  rows?: number;
  cols?: number;
}

export async function listTerminalSessions(): Promise<TerminalSessionItem[]> {
  return apiFetch<TerminalSessionItem[]>("/api/terminal/sessions");
}

export async function createTerminalSession(
  payload: TerminalCreatePayload = {}
): Promise<TerminalSessionItem> {
  return apiFetch<TerminalSessionItem>("/api/terminal/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteTerminalSession(
  sessionId: string
): Promise<{ message: string; id: string }> {
  return apiFetch<{ message: string; id: string }>(
    `/api/terminal/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
    }
  );
}

export async function restartTerminalSession(
  sessionId: string,
  payload: TerminalCreatePayload = {}
): Promise<TerminalSessionItem> {
  return apiFetch<TerminalSessionItem>(
    `/api/terminal/sessions/${encodeURIComponent(sessionId)}/restart`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export function getTerminalWsUrl(sessionId: string): string {
  const envUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "/genesis").replace(/\/+$/, "");
  let base = envUrl !== undefined && envUrl !== "" ? envUrl : basePath;

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (base.startsWith("http://") || base.startsWith("https://")) {
      base = base.replace(/^http(s)?:/, (match) =>
        match === "https:" ? "wss:" : "ws:"
      );
    } else {
      const prefix = base.startsWith("/") ? base : `/${base}`;
      base = `${protocol}//${window.location.host}${prefix}`;
    }
  } else {
    base = "ws://localhost:8000";
  }

  base = base.replace(/\/+$/, "");
  return `${base}/api/terminal/ws/${encodeURIComponent(sessionId)}`;
}
