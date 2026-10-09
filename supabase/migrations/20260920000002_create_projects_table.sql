-- ==============================================================================
-- Genesis Database Migration: 003_create_projects_table.sql
-- 项目表 (projects) 与会话关联
-- ==============================================================================

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  icon text,
  is_expanded boolean not null default true,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 索引
create index if not exists idx_projects_user_created on public.projects (user_id, created_at desc);

-- 开启 RLS
alter table public.projects enable row level security;

-- 允许用户管理自己的项目
drop policy if exists "Users manage own projects" on public.projects;
create policy "Users manage own projects"
  on public.projects
  for all
  using (auth.uid() = user_id or auth.uid() is null)
  with check (auth.uid() = user_id or auth.uid() is null);

-- 在 sessions 表添加 project_id 外键
alter table public.sessions add column if not exists project_id uuid references public.projects(id) on delete set null;
create index if not exists idx_sessions_project_id on public.sessions (project_id);
