import { apiFetch } from "@/lib/api/client";
import type {
  ConfirmationResponsePayload,
  WorkspacePermissionRule,
} from "../types/protocol";

export interface SubmitConfirmationResponse {
  success: boolean;
  session_id?: string;
  request_id?: string;
  decision?: string;
}

export interface SessionGrantsResponse {
  success: boolean;
  session_id: string;
  grants: string[];
}

export interface WorkspacePermissionRulesResponse {
  success: boolean;
  rules: WorkspacePermissionRule[];
}

export async function submitConfirmation(
  sessionId: string,
  payload: ConfirmationResponsePayload
): Promise<SubmitConfirmationResponse> {
  return apiFetch<SubmitConfirmationResponse>(`/api/chat/${sessionId}/approve`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchSessionGrants(sessionId: string): Promise<string[]> {
  const res = await apiFetch<SessionGrantsResponse>(`/api/chat/${sessionId}/grants`);
  return Array.isArray(res?.grants) ? res.grants : [];
}

export async function clearSessionGrants(sessionId: string): Promise<void> {
  await apiFetch<SessionGrantsResponse>(`/api/chat/${sessionId}/grants`, {
    method: "DELETE",
  });
}

export async function fetchWorkspacePermissionRules(
  workspaceRoot?: string
): Promise<WorkspacePermissionRule[]> {
  const query = workspaceRoot
    ? `?workspace_root=${encodeURIComponent(workspaceRoot)}`
    : "";
  const res = await apiFetch<WorkspacePermissionRulesResponse>(
    `/api/permission-rules${query}`
  );
  return Array.isArray(res?.rules) ? res.rules : [];
}

export async function deleteWorkspacePermissionRule(
  ruleId: string
): Promise<void> {
  await apiFetch<{ success: boolean }>(
    `/api/permission-rules/${encodeURIComponent(ruleId)}`,
    { method: "DELETE" }
  );
}

export async function clearWorkspacePermissionRules(
  workspaceKey?: string
): Promise<void> {
  const query = workspaceKey
    ? `?workspace_key=${encodeURIComponent(workspaceKey)}`
    : "";
  await apiFetch<{ success: boolean }>(`/api/permission-rules${query}`, {
    method: "DELETE",
  });
}
