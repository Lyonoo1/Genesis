-- ==============================================================================
-- Genesis Database Migration: 20261008000002_fix_auth_users_null_tokens.sql
-- 修复 auth.users 中历史写入用户的 token 为 NULL 导致 GoTrue 认证引擎 Scan error 500 的问题
-- ==============================================================================

UPDATE auth.users
SET 
  confirmation_token = COALESCE(confirmation_token, ''),
  recovery_token = COALESCE(recovery_token, ''),
  email_change_token_new = COALESCE(email_change_token_new, ''),
  email_change = COALESCE(email_change, ''),
  phone_change_token = COALESCE(phone_change_token, ''),
  phone_change = COALESCE(phone_change, ''),
  reauthentication_token = COALESCE(reauthentication_token, ''),
  email_change_token_current = COALESCE(email_change_token_current, '');

-- 确保 profiles 表中已有用户的 email 字段与 auth.users 保持同步
UPDATE public.profiles p
SET email = u.email
FROM auth.users u
WHERE p.id = u.id AND (p.email IS NULL OR p.email = '');
