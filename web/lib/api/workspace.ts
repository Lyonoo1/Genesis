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

export interface WorkspaceFileWriteResponse {
  success: boolean;
  path: string;
  size: number;
  is_bridge?: boolean;
  error?: string;
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
  sessionId?: string | null,
  projectId?: string | null
): Promise<WorkspaceFileResponse> {
  const params = new URLSearchParams();
  params.append("path", path);
  if (sessionId) params.append("session_id", sessionId);
  if (projectId) params.append("project_id", projectId);
  return apiFetch<WorkspaceFileResponse>(`/api/workspace/file?${params.toString()}`, {
    method: "GET",
  });
}

export async function writeWorkspaceFileApi(
  path: string,
  content: string,
  sessionId?: string | null,
  projectId?: string | null,
  overwrite: boolean = true
): Promise<WorkspaceFileWriteResponse> {
  return apiFetch<WorkspaceFileWriteResponse>("/api/workspace/file", {
    method: "POST",
    body: JSON.stringify({
      path,
      content,
      session_id: sessionId || null,
      project_id: projectId || null,
      overwrite,
    }),
  });
}

