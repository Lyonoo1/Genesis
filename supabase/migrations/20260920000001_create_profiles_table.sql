-- ==============================================================================
-- Genesis Database Migration: 002_create_profiles_table.sql
-- 用户个人资料表及用户名唯一性约束
-- ==============================================================================

-- 设置数据库时区为北京时间 (UTC+8)
alter database postgres set timezone to 'Asia/Shanghai';
alter role postgres set timezone to 'Asia/Shanghai';
alter role authenticator set timezone to 'Asia/Shanghai';
alter role authenticated set timezone to 'Asia/Shanghai';
alter role anon set timezone to 'Asia/Shanghai';
alter role service_role set timezone to 'Asia/Shanghai';

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  email text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 用户名全局大小写不敏感唯一索引（防止 admin 与 Admin 重复注册）
create unique index if not exists idx_profiles_username_lower on public.profiles (lower(username));
create unique index if not exists idx_profiles_username on public.profiles (username);

-- 开启 RLS
alter table public.profiles enable row level security;

-- 允许公开读取 Profile（供前端验证用户名唯一性与展示）
create policy "Profiles are viewable by everyone" 
  on public.profiles for select 
  using (true);

-- 允许登录用户插入自己的 Profile
create policy "Users can insert own profile" 
  on public.profiles for insert 
  with check (auth.uid() = id);

-- 允许用户更新自己的 Profile
create policy "Users can update own profile" 
  on public.profiles for update 
  using (auth.uid() = id);

-- 自动触发器：auth.users 注册时同步写入 profiles
create or replace function public.handle_new_user()
returns trigger as $$
declare
  chosen_username text;
begin
  chosen_username := coalesce(
    new.raw_user_meta_data->>'account',
    new.raw_user_meta_data->>'username',
    new.raw_user_meta_data->>'name',
    split_part(new.email, '@', 1)
  );

  insert into public.profiles (id, username, email)
  values (new.id, chosen_username, new.email)
  on conflict (id) do update set
    username = excluded.username,
    email = excluded.email,
    updated_at = now();

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 回填已有用户至 profiles 表
insert into public.profiles (id, username, email)
select
  id,
  coalesce(raw_user_meta_data->>'account', raw_user_meta_data->>'username', raw_user_meta_data->>'name', split_part(email, '@', 1)) as username,
  email
from auth.users
on conflict (id) do nothing;
