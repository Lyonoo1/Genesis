from uuid import UUID
from fastapi import APIRouter, Depends, status
from fastapi.responses import StreamingResponse

from core.security import get_current_user, AuthenticatedUser
from core.exceptions import AppException, ErrorCode
from models.schemas.chat import ChatRequest, ChatStopResponse
from repositories.session_repository import SessionRepository
from services.chat_service import ChatService, chat_service

router = APIRouter(prefix="/chat", tags=["Agent Chat & SSE Streaming"])


def get_chat_service() -> ChatService:
    return chat_service


def get_session_repository() -> SessionRepository:
    return SessionRepository()


@router.post(
    "/{session_id}/completion",
    summary="全双工 ReAct 智能体多步 Tool Calling 与打字机流式响应",
    description="支持穿透反向代理缓冲 (X-Accel-Buffering: no) 的标准 SSE 事件流",
)
@router.post(
    "/{session_id}/stream",
    summary="全双工流式推送别名路由 (兼容前端 SDK)",
    include_in_schema=False,
)
async def send_chat_completion(
    session_id: str,
    req: ChatRequest,
    user: AuthenticatedUser = Depends(get_current_user),
    session_repo: SessionRepository = Depends(get_session_repository),
    service: ChatService = Depends(get_chat_service),
):
    # 1. 验证会话存在且属于当前用户 (若不存在自动创建初始化，确保开发环境零报错)
    sess = await session_repo.get_by_id(user.id, session_id)
    if not sess:
        from models.schemas.session import SessionCreate
        sess = await session_repo.create(user.id, SessionCreate(title="新对话"))

    # 2. 启动异步 ReAct 流式生成器
    stream_generator = service.handle_stream(
        session_id=session_id,
        req=req,
        user_id=user.id,
    )

    # 3. 构造穿透缓冲的 SSE 响应头
    sse_headers = {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",  # 核心击穿 Nginx / Caddy / Cloudflare 反向代理缓冲标记
    }

    return StreamingResponse(
        stream_generator,
        media_type="text/event-stream",
        headers=sse_headers,
    )


@router.post(
    "/{session_id}/stop",
    response_model=ChatStopResponse,
    summary="中止指定会话当前正在运行的流式生成任务",
)
async def stop_chat_completion(
    session_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
    service: ChatService = Depends(get_chat_service),
):
    stopped = service.stop_task(user.id, session_id)
    if stopped:
        return ChatStopResponse(success=True, message="已成功中止当前生成任务")
    return ChatStopResponse(success=False, message="当前会话无正在运行的生成任务")


@router.post(
    "/test-connection",
    summary="测试自定义模型与 API Key 的连通性",
)
async def test_model_connection(
    req: dict,
):
    from services.llm_adapter import llm_adapter

    provider = req.get("provider", "openai")
    base_url = req.get("base_url", "https://api.openai.com/v1")
    api_key = req.get("api_key", "")
    model = req.get("model", "gpt-4o")

    success, latency_ms, error_msg = await llm_adapter.test_connection(
        provider=provider,
        base_url=base_url,
        api_key=api_key,
        model=model,
    )
    return {
        "success": success,
        "latency_ms": latency_ms,
        "error": error_msg,
    }

