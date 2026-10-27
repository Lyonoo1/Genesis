from uuid import UUID
from typing import Optional
from pydantic import BaseModel
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

    # 2. 检查会话是否正在运行中，若正在运行则自动进入实时插话 (Mid-task Steering) 流程
    if service.is_task_running(user.id, session_id):
        from services.chat_service import format_sse
        enqueued = service.add_steering_message(user.id, session_id, req.content)
        async def _steer_event_stream():
            yield format_sse("mid_task_steered", {
                "session_id": str(session_id),
                "content": req.content,
                "status": "enqueued" if enqueued else "failed",
                "message": "插话指令已加入队列，将在本步骤工具执行完毕后生效",
            })
            yield format_sse("done", {
                "session_id": str(session_id),
                "message": "插话完成",
            })
        return StreamingResponse(
            _steer_event_stream(),
            media_type="text/event-stream",
            headers={
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # 3. 启动异步 ReAct 流式生成器
    stream_generator = service.handle_stream(
        session_id=session_id,
        req=req,
        user_id=user.id,
    )

    # 4. 构造穿透缓冲的 SSE 响应头
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
    "/{session_id}/steer",
    summary="运行中实时插话 (Mid-task Steering)",
    description="在 Agent Loop 运行期间实时注入新指令，不打断当前正在执行的工具，在下一步前自动转向",
)
async def steer_chat_completion(
    session_id: str,
    req: dict,
    user: AuthenticatedUser = Depends(get_current_user),
    service: ChatService = Depends(get_chat_service),
):
    content = req.get("content") or req.get("message", "")
    if not content or not str(content).strip():
        raise AppException(
            code=ErrorCode.VALIDATION_ERROR,
            message="插话指令内容不能为空",
        )
    steered = service.add_steering_message(user.id, session_id, str(content).strip())
    return {
        "success": steered,
        "session_id": session_id,
        "steered": steered,
        "message": "插话指令已加入队列，将在当前步骤工具执行完毕后生效" if steered else "当前会话未在运行中或未就绪",
    }


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


@router.post(
    "/{session_id}/approve",
    summary="人机协同高危操作人工审批回调",
)
async def approve_tool_call(
    session_id: str,
    req: dict,
):
    from services.permission_manager import permission_manager

    tool_call_id = req.get("tool_call_id") or req.get("approval_id", "")
    approved = req.get("approved", True)

    resolved = permission_manager.resolve_approval(
        session_id=session_id,
        tool_call_id=tool_call_id,
        approved=bool(approved),
    )
    return {
        "success": resolved,
        "session_id": session_id,
        "tool_call_id": tool_call_id,
        "approved": approved,
    }


@router.post(
    "/processes/{pid}/stop",
    summary="强制终止指定的后台守护进程",
)
async def stop_background_process_endpoint(pid: int):
    from services.workspace_tool_executor import WorkspaceToolExecutor

    success = WorkspaceToolExecutor.stop_background_process(pid)
    return {
        "success": success,
        "pid": pid,
        "message": f"进程 (PID: {pid}) 已成功终止并释放端口",
    }


@router.get(
    "/processes",
    summary="列出当前存活的所有后台守护进程",
)
async def list_background_processes_endpoint(session_id: Optional[str] = None):
    from services.workspace_tool_executor import WorkspaceToolExecutor

    processes = WorkspaceToolExecutor.list_background_processes(session_id=session_id)
    return {
        "success": True,
        "processes": processes,
    }


class RevertFileItem(BaseModel):
    path: str
    original_content: Optional[str] = ""


class RevertFilesRequest(BaseModel):
    files: list[RevertFileItem]
    session_id: Optional[str] = None


@router.post(
    "/revert",
    summary="撤销代码变更并恢复原内容",
)
async def revert_files_endpoint(req: RevertFilesRequest):
    import logging
    from services.workspace_tool_executor import WorkspaceToolExecutor
    from services.terminal_manager import get_default_workspace
    from services.chat_service import chat_service

    logger = logging.getLogger("genesis.revert")

    # 多级解析工作区：优先对齐 chat_service 所使用的真实项目目录，回退至 Genesis 根目录
    primary_root = await chat_service.resolve_workspace_root(
        user_id="default_user",
        session_id=req.session_id,
    )
    fallback_root = get_default_workspace()
    roots = [primary_root]
    if fallback_root and fallback_root not in roots:
        roots.append(fallback_root)

    reverted = []
    for item in req.files:
        path = item.path.strip()
        if not path:
            continue
        reverted_this = False
        for ws_root in roots:
            try:
                full_path = WorkspaceToolExecutor.resolve_safe_path(ws_root, path)
                if item.original_content is None or item.original_content == "":
                    # 之前是新建文件，撤销时将其删除
                    if full_path.exists():
                        full_path.unlink()
                        reverted_this = True
                        break
                else:
                    # 还原已有文件为修改前的内容
                    full_path.parent.mkdir(parents=True, exist_ok=True)
                    full_path.write_text(item.original_content, encoding="utf-8")
                    reverted_this = True
                    break
            except Exception as exc:
                logger.debug("尝试在工作区 %s 下撤销 %s 异常: %s", ws_root, path, exc)

        if reverted_this:
            reverted.append(path)

    return {
        "success": True,
        "reverted": reverted,
    }



