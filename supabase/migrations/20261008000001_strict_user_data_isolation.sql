-- ==============================================================================
-- Genesis Database Migration: 20261008000001_strict_user_data_isolation.sql
-- 彻底收紧 Row Level Security (RLS) 策略，强制多租户 user_id 严格隔离
-- 严禁任何跨账号越权查询，严禁未登录/匿名绕过
-- ==============================================================================

-- 1. 项目表 (projects) 严格数据隔离
alter table public.projects enable row level security;
drop policy if exists "Users manage own projects" on public.projects;
create policy "Users manage own projects"
  on public.projects
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2. 会话表 (sessions) 严格数据隔离
alter table public.sessions enable row level security;
drop policy if exists "Users manage own sessions" on public.sessions;
create policy "Users manage own sessions"
  on public.sessions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 3. 消息表 (messages) 严格数据隔离
alter table public.messages enable row level security;
drop policy if exists "Users manage own messages" on public.messages;
create policy "Users manage own messages"
  on public.messages
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
