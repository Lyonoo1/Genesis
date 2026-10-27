import asyncio
import json
import logging
from typing import Optional
from fastapi import (
    APIRouter,
    WebSocket,
    WebSocketDisconnect,
    HTTPException,
    status,
    Query,
)

from models.schemas.terminal import (
    TerminalSessionInfo,
    TerminalCreateRequest,
    TerminalResizeRequest,
)
from services.terminal_manager import TerminalManager

logger = logging.getLogger("genesis.terminal.router")
router = APIRouter(prefix="/terminal", tags=["Terminal"])


@router.get(
    "/sessions",
    response_model=list[TerminalSessionInfo],
    summary="获取所有活动终端会话",
)
async def list_terminal_sessions():
    manager = TerminalManager.get_instance()
    return manager.list_sessions()


@router.post(
    "/sessions",
    response_model=TerminalSessionInfo,
    status_code=status.HTTP_201_CREATED,
    summary="创建新终端会话",
)
async def create_terminal_session(body: TerminalCreateRequest):
    manager = TerminalManager.get_instance()
    session = manager.create_session(
        session_id=body.id,
        title=body.title,
        cwd=body.cwd,
        rows=body.rows,
        cols=body.cols,
    )
    return session.to_dict()


@router.delete(
    "/sessions/{session_id}",
    summary="销毁指定终端会话",
)
async def delete_terminal_session(session_id: str):
    manager = TerminalManager.get_instance()
    success = manager.terminate_session(session_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Terminal session {session_id} not found",
        )
    return {"message": "Session terminated successfully", "id": session_id}


@router.post(
    "/sessions/{session_id}/restart",
    response_model=TerminalSessionInfo,
    summary="重启指定终端会话",
)
async def restart_terminal_session(
    session_id: str,
    body: Optional[TerminalCreateRequest] = None,
):
    manager = TerminalManager.get_instance()
    existing = manager.get_session(session_id)
    cwd = body.cwd if (body and body.cwd) else (existing.cwd if existing else None)
    title = body.title if (body and body.title) else (existing.title if existing else None)
    rows = body.rows if (body and body.rows) else (existing.rows if existing else 24)
    cols = body.cols if (body and body.cols) else (existing.cols if existing else 80)

    session = manager.restart_session(
        session_id=session_id,
        title=title,
        cwd=cwd,
        rows=rows,
        cols=cols,
    )
    return session.to_dict()


@router.websocket("/ws")
@router.websocket("/ws/{session_id}")
async def terminal_websocket(
    websocket: WebSocket,
    session_id: Optional[str] = None,
    cwd: Optional[str] = Query(default=None),
    rows: int = Query(default=24, ge=1, le=500),
    cols: int = Query(default=80, ge=1, le=1000),
):
    """
    双向终端流式 WebSocket 通道：
    - 支持会话无缝持久化与分块历史回放 (断线重连/刷新页面历史不丢)
    - 支持动态缩放 (TIOCSWINSZ) 与无感热重启
    - 严防 CPU 忙循环与 ASGI 并发写冲突
    """
    await websocket.accept()
    manager = TerminalManager.get_instance()
    target_sid = session_id or "default"

    # 获取或创建会话
    session = manager.get_or_create_session(
        session_id=target_sid,
        title=f"Terminal {target_sid[:6]}",
        cwd=cwd,
        rows=rows,
        cols=cols,
    )

    # 订阅会话广播流
    queue = session.subscribe()

    send_lock = asyncio.Lock()

    async def safe_send(msg: dict):
        try:
            async with send_lock:
                await websocket.send_text(json.dumps(msg))
        except (asyncio.CancelledError, WebSocketDisconnect):
            raise
        except Exception as e:
            logger.debug(f"[WS-Send] error: {e}")

    # 1. 立即回放历史缓存，还原终端屏幕 (分块发送，防止超大帧阻塞 UI 渲染)
    history_text = session.get_history_text()
    if history_text:
        CHUNK_SIZE = 64 * 1024
        for i in range(0, len(history_text), CHUNK_SIZE):
            await safe_send({"type": "output", "data": history_text[i : i + CHUNK_SIZE]})

    # 2. 启动双向收发协同任务
    async def send_to_client():
        try:
            while True:
                msg = await queue.get()
                await safe_send(msg)
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        except Exception as e:
            logger.debug(f"[WS-Send] queue loop error: {e}")

    async def receive_from_client():
        try:
            while True:
                raw_text = await websocket.receive_text()
                try:
                    payload = json.loads(raw_text)
                    msg_type = payload.get("type")

                    # 动态获取最新 session 引用，即使被热重启也能准确寻址
                    curr_session = manager.get_session(target_sid) or session

                    if msg_type == "input":
                        data = payload.get("data", "")
                        curr_session.write(data)

                    elif msg_type == "resize":
                        r = payload.get("rows", 24)
                        c = payload.get("cols", 80)
                        curr_session.resize(r, c)

                    elif msg_type == "ping":
                        await safe_send({"type": "pong"})

                except json.JSONDecodeError:
                    curr_session = manager.get_session(target_sid) or session
                    curr_session.write(raw_text)
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        except Exception as e:
            logger.debug(f"[WS-Recv] receive loop error: {e}")

    send_task = asyncio.create_task(send_to_client())
    recv_task = asyncio.create_task(receive_from_client())

    try:
        # 任一任务结束即表示连接断开
        done, pending = await asyncio.wait(
            [send_task, recv_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        # 取消订阅，但注意：不销毁 session！后台常驻任务与 node 服务器继续运行！
        curr_session = manager.get_session(target_sid) or session
        curr_session.unsubscribe(queue)
        try:
            await websocket.close()
        except Exception:
            pass
