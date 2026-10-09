-- ==============================================================================
-- Genesis Database Migration: 006_add_description_to_projects.sql
-- 在 projects 表添加 description 字段
-- ==============================================================================

alter table public.projects add column if not exists description text;
