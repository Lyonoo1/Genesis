from typing import Any, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel


from core.security import get_current_user, AuthenticatedUser
from models.schemas.session import (
    SessionCreate,
    SessionUpdate,
    SessionResponse,
    SessionCapabilitiesUpdate,
    SessionCapabilitiesResponse,
    CapabilityItem,
)
from models.schemas.message import MessageListResponse, MessageResponse
from repositories.session_repository import SessionRepository
from repositories.message_repository import MessageRepository

router = APIRouter(tags=["Sessions & Messages"])


def get_session_repo() -> SessionRepository:
    return SessionRepository()


def get_message_repo() -> MessageRepository:
    return MessageRepository()


# ----------------------------------------------------------------------
# 1. 会话 CRUD 管理路由
# ----------------------------------------------------------------------


@router.get(
    "/sessions",
    response_model=list[SessionResponse],
    summary="获取当前用户全部会话列表",
    description="返回按置顶状态优先、更新时间降序排列的会话列表",
)
async def list_sessions(
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repo),
):
    items = await repo.list_by_user(user.id)
    return items


@router.post(
    "/sessions",
    response_model=SessionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建新会话",
    description="创建一个初始标题为'新对话'的空会话",
)
async def create_session(
    body: SessionCreate = SessionCreate(),
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repo),
):
    created = await repo.create(user.id, body)
    return created


@router.patch(
    "/sessions/{session_id}",
    response_model=SessionResponse,
    summary="更新会话信息（重命名 / 置顶切换）",
)
async def update_session(
    session_id: str,
    body: SessionUpdate,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repo),
):
    updated = await repo.update(user.id, session_id, body)
    return updated


@router.delete(
    "/sessions/{session_id}",
    summary="物理级联删除会话",
    description="删除会话及其关联的所有消息与能力开关记录",
)
async def delete_session(
    session_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repo),
):
    await repo.delete(user.id, session_id)
    return {"success": True, "id": session_id}


# ----------------------------------------------------------------------
# 2. 消息历史分页与分支修剪
# ----------------------------------------------------------------------


@router.get(
    "/sessions/{session_id}/messages",
    response_model=MessageListResponse,
    include_in_schema=False,
)
@router.get(
    "/chat/{session_id}/messages",
    response_model=MessageListResponse,
    summary="游标分页拉取会话消息历史",
    description="支持通过 ISO 8601 cursor 进行历史向前翻页，返回按时间正序排列的会话消息",
)
async def get_session_messages(
    session_id: str,
    cursor: Optional[str] = Query(
        default=None, description="分页游标（上一批次最旧消息的 created_at）"
    ),
    limit: int = Query(
        default=20, ge=1, le=100, description="单次拉取数量，默认 20 条"
    ),
    user: AuthenticatedUser = Depends(get_current_user),
    msg_repo: MessageRepository = Depends(get_message_repo),
    sess_repo: SessionRepository = Depends(get_session_repo),
):
    # 校验会话归属权限
    session = await sess_repo.get_by_id(user.id, session_id)
    if not session:
        from core.exceptions import AppException, ErrorCode

        raise AppException(
            code=ErrorCode.SESSION_NOT_FOUND,
            message="目标会话不存在或无权访问",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    items, next_cursor, has_more = await msg_repo.list_by_session(
        session_id=session_id,
        user_id=user.id,
        limit=limit,
        cursor=cursor,
    )
    return MessageListResponse(
        items=[MessageResponse.model_validate(item) for item in items],
        next_cursor=next_cursor,
        has_more=has_more,
    )


class PruneBranchRequest(BaseModel):
    parent_id: Any


@router.post(
    "/chat/{session_id}/messages/prune",
    summary="编辑重发分支修剪 (Branch Pruning)",
    description="物理删除指定 parent_id 之后的所有历史分支消息，保持单线上下文整洁",
)
async def prune_session_branch(
    session_id: str,
    body: PruneBranchRequest,
    user: AuthenticatedUser = Depends(get_current_user),
    msg_repo: MessageRepository = Depends(get_message_repo),
):
    pruned_count = await msg_repo.prune_branch(
        session_id=session_id,
        user_id=user.id,
        parent_id=body.parent_id,
    )
    return {"success": True, "session_id": session_id, "pruned_count": pruned_count}


# ----------------------------------------------------------------------
# 3. 会话能力开关配置
# ----------------------------------------------------------------------


@router.get(
    "/chat/{session_id}/capabilities",
    response_model=SessionCapabilitiesResponse,
    summary="获取指定会话的能力开关列表",
)
async def get_capabilities(
    session_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repo),
):
    records = await repo.get_capabilities(user.id, session_id)
    return SessionCapabilitiesResponse(
        session_id=session_id,
        capabilities=[
            CapabilityItem(
                capability_type=r["capability_type"],
                capability_id=r["capability_id"],
                enabled=r["enabled"],
            )
            for r in records
        ],
    )


@router.put(
    "/chat/{session_id}/capabilities",
    response_model=SessionCapabilitiesResponse,
    summary="批量更新会话级能力开关",
    description="在当前会话下开启/关闭特定 Skill 或 MCP Server 连接",
)
async def update_capabilities(
    session_id: str,
    body: SessionCapabilitiesUpdate,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: SessionRepository = Depends(get_session_repo),
):
    records = await repo.update_capabilities(user.id, session_id, body.capabilities)
    return SessionCapabilitiesResponse(
        session_id=session_id,
        capabilities=[
            CapabilityItem(
                capability_type=r["capability_type"],
                capability_id=r["capability_id"],
                enabled=r["enabled"],
            )
            for r in records
        ],
    )


@router.post(
    "/sessions/{session_id}/generate-title",
    response_model=SessionResponse,
    summary="根据会话首条消息智能生成标题并更新",
)
async def generate_title_endpoint(
    session_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
    session_repo: SessionRepository = Depends(get_session_repo),
    message_repo: MessageRepository = Depends(get_message_repo),
):
    from services.chat_service import chat_service

    db_res = await message_repo.list_by_session(user.id, session_id, limit=5)
    msgs = db_res[0] if isinstance(db_res, tuple) else db_res
    first_user_msg = next((m for m in msgs if m.get("role") == "user"), None)
    if not first_user_msg or not first_user_msg.get("content"):
        current = await session_repo.get_by_id(user.id, session_id)
        return current

    new_title = await chat_service.generate_session_title(
        content=first_user_msg["content"],
        model="deepseek-chat",
    )
    if new_title:
        updated = await session_repo.update(
            user.id, session_id, SessionUpdate(title=new_title)
        )
        return updated

    return await session_repo.get_by_id(user.id, session_id)

