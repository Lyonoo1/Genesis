import { apiFetch } from "./client";
import { WorkspaceFileNode } from "@/lib/workspace/localWorkspaceManager";

export interface WorkspaceTreeResponse {
  success: boolean;
  workspace_root: string;
  name: string;
  tree: WorkspaceFileNode[];
  error?: string;
}

export interface WorkspaceFileResponse {
  success: boolean;
  path: string;
  name: string;
  content: string;
  size: number;
}

export async function fetchWorkspaceTreeApi(
  sessionId?: string | null,
  projectId?: string | null
): Promise<WorkspaceTreeResponse> {
  const params = new URLSearchParams();
  if (sessionId) params.append("session_id", sessionId);
  if (projectId) params.append("project_id", projectId);
  const qs = params.toString();
  return apiFetch<WorkspaceTreeResponse>(`/api/workspace/tree${qs ? `?${qs}` : ""}`, {
    method: "GET",
  });
}

export async function fetchWorkspaceFileApi(
  path: string,
  sessionId?: string | null
): Promise<WorkspaceFileResponse> {
  const params = new URLSearchParams();
  params.append("path", path);
  if (sessionId) params.append("session_id", sessionId);
  return apiFetch<WorkspaceFileResponse>(`/api/workspace/file?${params.toString()}`, {
    method: "GET",
  });
}
