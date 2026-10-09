export type MessageRole = "user" | "assistant" | "tool" | "system";
export type MessageStatus = "sending" | "streaming" | "success" | "failed";

export interface ToolCallItem {
  id: string;
  name: string;
  args: Record<string, unknown>;
  output?: string | Record<string, unknown>;
  status?: "running" | "success" | "failed";
  latency_ms?: number;
}

export interface Message {
  id: string;
  session_id: string;
  parent_id?: string | null;
  role: MessageRole;
  content: string | null;
  reasoning_content?: string | null;
  raw_tool_calls?: ToolCallItem[] | null;
  tool_call_id?: string | null;
  active_skill_id?: string | null;
  status: MessageStatus;
  created_at: string;
  metrics?: {
    latency_ms?: number;
    tokens?: number;
  };
}

export interface Session {
  id: string;
  project_id?: string;
  user_id?: string;
  title: string;
  pinned: boolean;
  is_archived?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  isExpanded?: boolean;
  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface UserProfile {
  id: string;
  name: string;
  avatarText: string;
  usagePercentage: number;
  isPlus: boolean;
}

export interface InstalledSkill {
  id: string;
  user_id: string;
  name: string;
  version: string;
  storage_path: string;
  local_dir?: string | null;
  manifest: Record<string, unknown>;
  auto_trigger: boolean;
  installed_at: string;
}

export interface McpConnection {
  id: string;
  user_id: string;
  name: string;
  connection_type: "local_command" | "remote_url";
  connection_config: Record<string, unknown>;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  enabled: boolean;
  created_at: string;
}
