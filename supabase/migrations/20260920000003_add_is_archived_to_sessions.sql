-- ==============================================================================
-- Genesis Database Migration: 004_add_is_archived_to_sessions.sql
-- 在 sessions 表添加 is_archived 字段
-- ==============================================================================

alter table public.sessions add column if not exists is_archived boolean not null default false;
create index if not exists idx_sessions_user_archived on public.sessions (user_id, is_archived);
