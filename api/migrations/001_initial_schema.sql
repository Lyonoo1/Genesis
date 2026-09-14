-- ==============================================================================
-- Genesis (GenesisCode) Database Migration: 001_initial_schema.sql
-- ==============================================================================

-- 启用 uuid 扩展
create extension if not exists "uuid-ossp";

-- 1. 会话表 (增加 user_id 与更新时间索引)
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '新对话',
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sessions_user_updated on sessions(user_id, updated_at desc);

-- 2. 消息表 (支持 Tool Calling 结构与 parent_id 分支截断)
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references messages(id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text,
  raw_tool_calls jsonb null,
  tool_call_id text null,
  active_skill_id uuid null,
  status text not null default 'success' check (status in ('sending', 'streaming', 'success', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_session_time on messages(session_id, created_at asc);
create index if not exists idx_messages_parent on messages(parent_id);

-- 3. 已安装 Skill 表
create table if not exists installed_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  version text not null,
  storage_path text not null,
  local_dir text,
  manifest jsonb not null,
  auto_trigger boolean not null default true,
  installed_at timestamptz not null default now(),
  unique(user_id, name)
);

-- 4. 已连接 MCP Server
create table if not exists mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  connection_type text not null default 'remote_url' check (connection_type in ('local_command', 'remote_url')),
  connection_config jsonb not null,
  tools jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- 5. 会话级能力开关
create table if not exists session_capabilities (
  session_id uuid not null references sessions(id) on delete cascade,
  capability_type text not null check (capability_type in ('skill', 'mcp')),
  capability_id uuid not null,
  enabled boolean not null default true,
  primary key (session_id, capability_type, capability_id)
);

-- 6. 用量记录表 (包含 model 字段支持多模型精细核算)
create table if not exists usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  skill_id uuid null references installed_skills(id) on delete set null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_usage_user_created on usage_logs(user_id, created_at desc);

-- 7. 自研插件草稿表
create table if not exists my_plugins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  manifest jsonb not null,
  storage_path text,
  status text not null default 'draft' check (status in ('draft', 'unpublished')),
  created_at timestamptz not null default now()
);

-- 8. 启用 RLS 并建立隔离策略
alter table sessions enable row level security;
alter table messages enable row level security;
alter table installed_skills enable row level security;
alter table mcp_connections enable row level security;
alter table session_capabilities enable row level security;
alter table usage_logs enable row level security;
alter table my_plugins enable row level security;

create policy "Users manage own sessions" on sessions for all using (auth.uid() = user_id);
create policy "Users manage own messages" on messages for all using (auth.uid() = user_id);
create policy "Users manage own skills" on installed_skills for all using (auth.uid() = user_id);
create policy "Users manage own mcps" on mcp_connections for all using (auth.uid() = user_id);
create policy "Users manage own usage" on usage_logs for all using (auth.uid() = user_id);
create policy "Users manage own my_plugins" on my_plugins for all using (auth.uid() = user_id);
