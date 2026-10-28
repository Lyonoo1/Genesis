import { apiFetch } from "./client";

export interface BridgeMetadata {
  hostname?: string;
  platform?: string;
  arch?: string;
  cwd?: string;
  node_version?: string;
}

export interface BridgeStatusResponse {
  connected: boolean;
  metadata?: BridgeMetadata | null;
}

export async function fetchBridgeStatusApi(): Promise<BridgeStatusResponse> {
  return apiFetch<BridgeStatusResponse>("/api/bridge/status");
}
