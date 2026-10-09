from typing import Any
from fastapi import APIRouter, Depends, status

from core.security import get_current_user, AuthenticatedUser
from models.schemas.project import ProjectCreate, ProjectUpdate, ProjectResponse
from repositories.project_repository import ProjectRepository

router = APIRouter(tags=["Projects"])


def get_project_repo() -> ProjectRepository:
    return ProjectRepository()


@router.get(
    "/projects",
    response_model=list[ProjectResponse],
    summary="获取当前用户全部项目列表",
)
async def list_projects(
    user: AuthenticatedUser = Depends(get_current_user),
    repo: ProjectRepository = Depends(get_project_repo),
):
    items = await repo.list_by_user(user.id)
    return items


@router.post(
    "/projects",
    response_model=ProjectResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建新项目",
)
async def create_project(
    body: ProjectCreate,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: ProjectRepository = Depends(get_project_repo),
):
    created = await repo.create(user.id, body)
    return created


@router.patch(
    "/projects/{project_id}",
    response_model=ProjectResponse,
    summary="更新项目信息",
)
async def update_project(
    project_id: str,
    body: ProjectUpdate,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: ProjectRepository = Depends(get_project_repo),
):
    updated = await repo.update(user.id, project_id, body)
    return updated


@router.delete(
    "/projects/{project_id}",
    summary="删除项目",
)
async def delete_project(
    project_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: ProjectRepository = Depends(get_project_repo),
):
    await repo.delete(user.id, project_id)
    return {"success": True, "id": project_id}
