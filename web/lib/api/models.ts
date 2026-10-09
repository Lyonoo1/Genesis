import { apiFetch } from "./client";
import { CustomModelConfig } from "@/stores/useModelConfigStore";

export async function fetchModelsApi(): Promise<CustomModelConfig[]> {
  return apiFetch<CustomModelConfig[]>("/api/models", {
    method: "GET",
  });
}

export async function saveModelApi(
  model: CustomModelConfig
): Promise<CustomModelConfig> {
  return apiFetch<CustomModelConfig>("/api/models", {
    method: "POST",
    body: JSON.stringify(model),
  });
}

export async function deleteModelApi(
  modelId: string
): Promise<{ success: boolean; id: string }> {
  return apiFetch<{ success: boolean; id: string }>(`/api/models/${modelId}`, {
    method: "DELETE",
  });
}
