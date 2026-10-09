import time
from uuid import UUID
from fastapi import APIRouter, Depends, status

from core.security import get_current_user, AuthenticatedUser
from core.exceptions import AppException, ErrorCode
from models.schemas.skill import (
    SkillInstallRequest,
    SkillAutoTriggerToggle,
    SkillResponse,
    SkillExecuteRequest,
    SkillExecuteResponse,
)
from repositories.skill_repository import SkillRepository
from services.skill_engine import skill_engine, SkillEngine

router = APIRouter(prefix="/skills", tags=["Skills & Sandbox"])


def get_skill_repository() -> SkillRepository:
    return SkillRepository()


def get_skill_engine() -> SkillEngine:
    return skill_engine


@router.get(
    "",
    response_model=list[SkillResponse],
    summary="获取当前用户已安装的全部 Skill 列表",
)
async def list_skills(
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SkillRepository = Depends(get_skill_repository),
):
    skills = await repo.list_by_user(user.id)
    return skills


@router.post(
    "/install",
    response_model=SkillResponse,
    status_code=status.HTTP_201_CREATED,
    summary="安装并注册新 Skill",
)
async def install_skill(
    skill_in: SkillInstallRequest,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SkillRepository = Depends(get_skill_repository),
):
    created = await repo.install(user.id, skill_in)
    return created


@router.get(
    "/{skill_id}",
    response_model=SkillResponse,
    summary="获取指定 Skill 详情",
)
async def get_skill_detail(
    skill_id: UUID,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SkillRepository = Depends(get_skill_repository),
):
    skill = await repo.get_by_id(user.id, skill_id)
    if not skill:
        raise AppException(
            code=ErrorCode.NOT_FOUND,
            message="指定的技能不存在",
        )
    return skill


@router.put(
    "/{skill_id}/auto-trigger",
    response_model=SkillResponse,
    summary="切换 Skill 的 Agent 自动感知触发开关",
)
async def toggle_auto_trigger(
    skill_id: UUID,
    toggle_in: SkillAutoTriggerToggle,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SkillRepository = Depends(get_skill_repository),
):
    updated = await repo.update_auto_trigger(
        user.id, skill_id, toggle_in.auto_trigger
    )
    return updated


@router.post(
    "/{skill_id}/execute",
    response_model=SkillExecuteResponse,
    summary="在安全沙箱子进程中调试/执行 Skill",
)
async def execute_skill(
    skill_id: UUID,
    req: SkillExecuteRequest,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SkillRepository = Depends(get_skill_repository),
    engine: SkillEngine = Depends(get_skill_engine),
):
    skill = await repo.get_by_id(user.id, skill_id)
    if not skill:
        raise AppException(
            code=ErrorCode.NOT_FOUND,
            message="指定的技能不存在",
        )

    t0 = time.time()
    try:
        res = await engine.execute_skill(
            skill=skill,
            arguments=req.arguments,
            timeout=req.timeout,
        )
        latency = int((time.time() - t0) * 1000)
        return SkillExecuteResponse(
            skill_id=skill_id,
            skill_name=skill["name"],
            result=res,
            is_error=False,
            latency_ms=latency,
        )
    except AppException as exc:
        latency = int((time.time() - t0) * 1000)
        return SkillExecuteResponse(
            skill_id=skill_id,
            skill_name=skill["name"],
            result=None,
            is_error=True,
            error_message=exc.message,
            latency_ms=latency,
        )
    except Exception as exc:
        latency = int((time.time() - t0) * 1000)
        return SkillExecuteResponse(
            skill_id=skill_id,
            skill_name=skill["name"],
            result=None,
            is_error=True,
            error_message=str(exc),
            latency_ms=latency,
        )


@router.delete(
    "/{skill_id}",
    summary="卸载 Skill 并清理本地沙箱环境",
)
async def delete_skill(
    skill_id: UUID,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SkillRepository = Depends(get_skill_repository),
    engine: SkillEngine = Depends(get_skill_engine),
):
    await repo.delete(user.id, skill_id)
    engine.cleanup_sandbox(str(skill_id))
    return {"success": True, "message": "技能已成功卸载并清理沙箱缓存"}
