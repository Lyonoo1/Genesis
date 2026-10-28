import { apiFetch } from "./client";
import { Project } from "@/types";

export interface ProjectCreatePayload {
  name: string;
  id?: string;
  icon?: string;
  description?: string;
  folder_name?: string;
  folder_path?: string;
}

export interface ProjectUpdatePayload {
  name?: string;
  icon?: string;
  description?: string;
  folder_name?: string;
  folder_path?: string;
  is_expanded?: boolean;
  is_archived?: boolean;
}

interface ApiProjectRaw {
  id: string;
  name: string;
  icon?: string | null;
  description?: string | null;
  folder_name?: string | null;
  folder_path?: string | null;
  is_expanded?: boolean;
  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;
}

export async function fetchProjectsApi(): Promise<Project[]> {
  const data = await apiFetch<ApiProjectRaw[]>("/api/projects", {
    method: "GET",
  });
  return (data || []).map((p) => ({
    id: p.id,
    name: p.name,
    icon: p.icon || undefined,
    description: p.description || undefined,
    folder_name: p.folder_name || undefined,
    folder_path: p.folder_path || undefined,
    isExpanded: p.is_expanded ?? true,
    is_archived: p.is_archived ?? false,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));
}

export async function createProjectApi(
  payload: ProjectCreatePayload
): Promise<Project> {
  const data = await apiFetch<ApiProjectRaw>("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return {
    id: data.id,
    name: data.name,
    icon: data.icon || undefined,
    description: data.description || undefined,
    folder_name: data.folder_name || undefined,
    folder_path: data.folder_path || undefined,
    isExpanded: data.is_expanded ?? true,
    is_archived: data.is_archived ?? false,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

export async function updateProjectApi(
  projectId: string,
  payload: ProjectUpdatePayload
): Promise<Project> {
  const data = await apiFetch<ApiProjectRaw>(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return {
    id: data.id,
    name: data.name,
    icon: data.icon || undefined,
    description: data.description || undefined,
    folder_name: data.folder_name || undefined,
    folder_path: data.folder_path || undefined,
    isExpanded: data.is_expanded ?? true,
    is_archived: data.is_archived ?? false,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

export async function deleteProjectApi(
  projectId: string
): Promise<{ success: boolean; id: string }> {
  return apiFetch<{ success: boolean; id: string }>(`/api/projects/${projectId}`, {
    method: "DELETE",
  });
}
