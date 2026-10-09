import { apiFetch } from "./client";
import { Session } from "@/types";

export interface SessionCreatePayload {
  id?: string;
  title?: string;
  project_id?: string;
}

export interface SessionUpdatePayload {
  title?: string;
  pinned?: boolean;
  project_id?: string | null;
  is_archived?: boolean;
}

export async function fetchSessionsApi(): Promise<Session[]> {
  return apiFetch<Session[]>("/api/sessions", {
    method: "GET",
  });
}

export async function createSessionApi(
  payload: SessionCreatePayload = {}
): Promise<Session> {
  return apiFetch<Session>("/api/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateSessionApi(
  sessionId: string,
  payload: SessionUpdatePayload
): Promise<Session> {
  return apiFetch<Session>(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteSessionApi(
  sessionId: string
): Promise<{ success: boolean; id: string }> {
  return apiFetch<{ success: boolean; id: string }>(`/api/sessions/${sessionId}`, {
    method: "DELETE",
  });
}
