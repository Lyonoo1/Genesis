from typing import Optional
from fastapi import APIRouter, Depends, Query

from core.security import AuthenticatedUser, get_current_user
from repositories.permission_rule_repository import (
    compute_workspace_key,
    permission_rule_repository,
)
from services.permission_manager import permission_manager

router = APIRouter(prefix="/permission-rules", tags=["Workspace Permission Rules"])


@router.get(
    "",
    summary="列出工作区级持久化权限规则（不传 workspace_root 时返回当前用户全部规则）",
)
async def list_permission_rules(
    workspace_root: Optional[str] = Query(default=None),
    user: AuthenticatedUser = Depends(get_current_user),
):
    ws_key: Optional[str] = None
    if workspace_root:
        ws_key, _ = compute_workspace_key(workspace_root)
    rules = await permission_rule_repository.list(str(user.id), ws_key)
    return {
        "success": True,
        "rules": rules,
    }


@router.delete(
    "/{rule_id}",
    summary="删除单条工作区级持久化权限规则",
)
async def delete_permission_rule(
    rule_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
):
    ws_key = await permission_rule_repository.delete(str(user.id), rule_id)
    if ws_key:
        permission_manager.invalidate_workspace_cache(str(user.id), ws_key)
    return {
        "success": ws_key is not None,
        "rule_id": rule_id,
    }


@router.delete(
    "",
    summary="清空指定工作区或当前用户全部工作区级持久化权限规则",
)
async def clear_permission_rules(
    workspace_root: Optional[str] = Query(default=None),
    workspace_key: Optional[str] = Query(default=None),
    user: AuthenticatedUser = Depends(get_current_user),
):
    ws_key = workspace_key
    if not ws_key and workspace_root:
        ws_key, _ = compute_workspace_key(workspace_root)
    deleted = await permission_rule_repository.delete_by_workspace(str(user.id), ws_key)
    permission_manager.invalidate_workspace_cache(str(user.id), ws_key)
    return {
        "success": True,
        "deleted": deleted,
    }
