import { apiFetch } from "./client";

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  environment: string;
}

export async function checkBackendHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/api/health");
}
