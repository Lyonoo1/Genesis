-- ==============================================================================
-- Genesis Database Migration: 005_update_sessions_rls_policy.sql
-- 优化 sessions 与 messages 表的 RLS 策略，支持开发模式与已登录用户
-- ==============================================================================

drop policy if exists "Users manage own sessions" on public.sessions;
create policy "Users manage own sessions"
  on public.sessions
  for all
  using (auth.uid() = user_id or auth.uid() is null)
  with check (auth.uid() = user_id or auth.uid() is null);

drop policy if exists "Users manage own messages" on public.messages;
create policy "Users manage own messages"
  on public.messages
  for all
  using (auth.uid() = user_id or auth.uid() is null)
  with check (auth.uid() = user_id or auth.uid() is null);
