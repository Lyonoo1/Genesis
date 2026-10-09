import { apiFetch } from "./client";
import { Project } from "@/types";

export interface ProjectCreatePayload {
  name: string;
  id?: string;
  icon?: string;
  description?: string;
}

export interface ProjectUpdatePayload {
  name?: string;
  icon?: string;
  description?: string;
  is_expanded?: boolean;
  is_archived?: boolean;
}

export async function fetchProjectsApi(): Promise<Project[]> {
  const data = await apiFetch<any[]>("/api/projects", {
    method: "GET",
  });
  return (data || []).map((p) => ({
    id: p.id,
    name: p.name,
    icon: p.icon || undefined,
    description: p.description || undefined,
    isExpanded: p.is_expanded ?? true,
    is_archived: p.is_archived ?? false,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));
}

export async function createProjectApi(
  payload: ProjectCreatePayload
): Promise<Project> {
  const data = await apiFetch<any>("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return {
    id: data.id,
    name: data.name,
    icon: data.icon || undefined,
    description: data.description || undefined,
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
  const data = await apiFetch<any>(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return {
    id: data.id,
    name: data.name,
    icon: data.icon || undefined,
    description: data.description || undefined,
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
