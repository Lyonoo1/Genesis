-- ==============================================================================
-- Genesis Database Migration: 003_permission_rules.sql
-- 工作区级持久化权限规则（兼容 SQLite 与 PostgreSQL）
-- ==============================================================================
create table if not exists permission_rules (
  id text primary key,
  user_id text not null,
  workspace_key text not null,
  workspace_label text,
  scope_signature text not null,
  created_from_session text,
  created_at text not null,
  last_used_at text
);

create unique index if not exists uq_permission_rules
  on permission_rules(user_id, workspace_key, scope_signature);

create index if not exists idx_permission_rules_ws
  on permission_rules(user_id, workspace_key);
