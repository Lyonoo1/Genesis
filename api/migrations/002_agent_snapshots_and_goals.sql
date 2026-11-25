-- ==============================================================================
-- Genesis Database Migration: 002_agent_snapshots_and_goals.sql
-- ==============================================================================

-- 1. 文件快照与 Diff 回滚追踪表 (file_snapshots)
create table if not exists file_snapshots (
  id text primary key,
  session_id text not null,
  turn_id text,
  tool_call_id text,
  file_path text not null,
  original_content text,
  modified_content text,
  unified_diff text,
  shadow_commit_hash text,
  status text not null default 'applied' check (status in ('applied', 'accepted', 'rejected')),
  created_at text not null
);
create index if not exists idx_file_snapshots_session on file_snapshots(session_id, created_at desc);
create index if not exists idx_file_snapshots_path on file_snapshots(session_id, file_path);

-- 2. Agent 目标与规划状态持久化表 (agent_goals)
create table if not exists agent_goals (
  id text primary key,
  session_id text not null,
  mode text not null default 'act',
  lifecycle_state text not null default 'IDLE',
  proposed_plan text,
  updated_at text not null
);
create index if not exists idx_agent_goals_session on agent_goals(session_id);
