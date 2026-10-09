from datetime import datetime, timezone
from typing import Any, Optional
import uuid as uuid_mod
from supabase import Client

from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from core.config import settings
from core.sqlite_db import (
    db_list_projects,
    db_get_project,
    db_upsert_project,
    db_delete_project,
)
from models.schemas.project import ProjectCreate, ProjectUpdate


class ProjectRepository:
    """项目数据访问仓储（基于本地 SQLite 物理落地，兼备 Supabase 云端同步）"""

    def __init__(self, client: Optional[Client] = None):
        self._client = client

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = get_supabase_client()
        return self._client

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """获取用户全部项目，按创建时间倒序"""
        projects = db_list_projects(str(user_id))
        if projects:
            return projects

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                res = (
                    self.client.table("projects")
                    .select("*")
                    .eq("user_id", str(user_id))
                    .order("created_at", desc=True)
                    .execute()
                )
                if res.data:
                    for p in res.data:
                        db_upsert_project(p)
                    return res.data
            except Exception:
                pass
        return projects

    async def get_by_id(
        self, user_id: str, project_id: str
    ) -> Optional[dict[str, Any]]:
        pid = str(project_id)
        proj = db_get_project(str(user_id), pid)
        if proj:
            return proj

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                res = (
                    self.client.table("projects")
                    .select("*")
                    .eq("id", pid)
                    .eq("user_id", str(user_id))
                    .execute()
                )
                if res.data:
                    db_upsert_project(res.data[0])
                    return res.data[0]
            except Exception:
                pass
        return None

    async def create(self, user_id: str, project_in: ProjectCreate) -> dict[str, Any]:
        pid = str(project_in.id) if project_in.id else str(uuid_mod.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        payload = {
            "id": pid,
            "user_id": str(user_id),
            "name": project_in.name,
            "icon": project_in.icon,
            "description": project_in.description,
            "is_expanded": True,
            "is_archived": False,
            "created_at": now,
            "updated_at": now,
        }
        saved = db_upsert_project(payload)

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                self.client.table("projects").insert(payload).execute()
            except Exception:
                pass
        return saved

    async def update(
        self, user_id: str, project_id: str, project_in: ProjectUpdate
    ) -> dict[str, Any]:
        pid = str(project_id)
        proj = db_get_project(str(user_id), pid)
        if not proj:
            raise AppException(
                code=ErrorCode.NOT_FOUND, message="项目不存在", status_code=404
            )

        now = datetime.now(timezone.utc).isoformat()
        update_data: dict[str, Any] = {"updated_at": now}
        if project_in.name is not None:
            update_data["name"] = project_in.name
        if project_in.icon is not None:
            update_data["icon"] = project_in.icon
        if project_in.description is not None:
            update_data["description"] = project_in.description
        if project_in.is_expanded is not None:
            update_data["is_expanded"] = project_in.is_expanded
        if project_in.is_archived is not None:
            update_data["is_archived"] = project_in.is_archived

        proj.update(update_data)
        saved = db_upsert_project(proj)

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                self.client.table("projects").update(update_data).eq("id", pid).eq("user_id", str(user_id)).execute()
            except Exception:
                pass
        return saved

    async def delete(self, user_id: str, project_id: str) -> None:
        pid = str(project_id)
        db_delete_project(str(user_id), pid)

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                self.client.table("projects").delete().eq("id", pid).eq(
                    "user_id", str(user_id)
                ).execute()
            except Exception:
                pass
