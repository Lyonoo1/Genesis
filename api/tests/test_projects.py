import uuid
from datetime import datetime, timezone
import pytest
from fastapi.testclient import TestClient

from main import app
from core.security import get_current_user, AuthenticatedUser
from routers.projects import get_project_repo
from repositories.project_repository import ProjectRepository
from models.schemas.project import ProjectCreate, ProjectUpdate


class InMemoryProjectRepository(ProjectRepository):
    def __init__(self):
        super().__init__(client=None)
        self.projects: dict[str, dict] = {}

    async def list_by_user(self, user_id: str):
        items = [p for p in self.projects.values() if p["user_id"] == str(user_id)]
        items.sort(key=lambda x: x["created_at"], reverse=True)
        return items

    async def get_by_id(self, user_id: str, project_id: str):
        p = self.projects.get(str(project_id))
        if p and p["user_id"] == str(user_id):
            return p
        return None

    async def create(self, user_id: str, project_in: ProjectCreate):
        pid = str(project_in.id) if project_in.id else str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        payload = {
            "id": pid,
            "user_id": str(user_id),
            "name": project_in.name,
            "icon": project_in.icon,
            "is_expanded": True,
            "is_archived": False,
            "created_at": now,
            "updated_at": now,
        }
        self.projects[pid] = payload
        return payload

    async def update(self, user_id: str, project_id: str, project_in: ProjectUpdate):
        proj = await self.get_by_id(user_id, project_id)
        if not proj:
            from core.exceptions import AppException, ErrorCode
            raise AppException(code=ErrorCode.NOT_FOUND, message="项目不存在", status_code=404)
        if project_in.name is not None:
            proj["name"] = project_in.name
        if project_in.icon is not None:
            proj["icon"] = project_in.icon
        if project_in.is_expanded is not None:
            proj["is_expanded"] = project_in.is_expanded
        if project_in.is_archived is not None:
            proj["is_archived"] = project_in.is_archived
        proj["updated_at"] = datetime.now(timezone.utc).isoformat()
        return proj

    async def delete(self, user_id: str, project_id: str):
        self.projects.pop(str(project_id), None)


@pytest.fixture
def mock_user():
    return AuthenticatedUser(
        user_id="00000000-0000-0000-0000-000000000001",
        email="developer@genesis.local",
    )


@pytest.fixture
def test_client(mock_user):
    project_repo = InMemoryProjectRepository()
    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[get_project_repo] = lambda: project_repo

    with TestClient(app) as client:
        yield client

    app.dependency_overrides.clear()


def test_project_crud_lifecycle(test_client):
    # 1. 创建项目
    res = test_client.post("/api/projects", json={"name": "测试项目 Alpha"})
    assert res.status_code == 201
    data = res.json()
    project_id = data["id"]
    assert data["name"] == "测试项目 Alpha"
    assert data["is_expanded"] is True
    assert data["is_archived"] is False

    # 2. 获取项目列表
    res = test_client.get("/api/projects")
    assert res.status_code == 200
    items = res.json()
    assert len(items) == 1
    assert items[0]["id"] == project_id

    # 3. 更新项目信息（重命名 + 归档）
    res = test_client.patch(
        f"/api/projects/{project_id}",
        json={"name": "测试项目 Beta", "is_archived": True},
    )
    assert res.status_code == 200
    updated = res.json()
    assert updated["name"] == "测试项目 Beta"
    assert updated["is_archived"] is True

    # 4. 删除项目
    res = test_client.delete(f"/api/projects/{project_id}")
    assert res.status_code == 200
    assert res.json()["success"] is True

    # 5. 验证删除后列表为空
    res = test_client.get("/api/projects")
    assert res.status_code == 200
    assert len(res.json()) == 0
