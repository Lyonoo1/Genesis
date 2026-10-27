import asyncio
import json
import logging
from typing import Optional
from fastapi import (
    APIRouter,
    Depends,
    Query,
    WebSocket,
    WebSocketDisconnect,
    status,
)

from core.security import get_current_user, AuthenticatedUser
from services.bridge_manager import BridgeManager

logger = logging.getLogger("genesis.bridge.router")
router = APIRouter(prefix="/bridge", tags=["Local Bridge Tunnel"])


@router.websocket("/ws")
async def bridge_websocket_tunnel(
    websocket: WebSocket,
    token: Optional[str] = Query(default=None),
):
    """本地 Bridge 反向 WebSocket 隧道入口：
    由访客本地终端执行 npx genesis-bridge 发起出站连接 (WSS/WS)，
    通过 JWT Token 鉴权后绑定当前用户，实现无公网 IP、无 NAT 穿透的本地文件与 Shell 代理。
    """
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        user = await get_current_user(authorization=f"Bearer {token}")
    except Exception as e:
        logger.warning("本地 Bridge 鉴权失败: %s", e)
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    manager = BridgeManager.get_instance()

    try:
        # 等待本地客户端发送握手握包 Hello Handshake
        raw_hello = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        hello_data = json.loads(raw_hello)
        if hello_data.get("type") != "bridge_hello":
            await websocket.close(code=status.WS_1003_UNSUPPORTED_DATA)
            return

        meta = hello_data.get("metadata", {})
        manager.register(user_id=str(user.id), ws=websocket, metadata=meta)

        # 回送握手确认
        await websocket.send_text(
            json.dumps({
                "type": "bridge_ready",
                "user_id": str(user.id),
                "message": "Genesis 云端网关已成功建立本地 Bridge 隧道连接",
            })
        )

        # 持续监听本地客户端传回的 RPC 执行结果
        while True:
            text = await websocket.receive_text()
            manager.handle_incoming_message(str(user.id), text)

    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as e:
        logger.error("本地 Bridge 隧道会话异常中断: %s", e)
    finally:
        manager.unregister(str(user.id))
        try:
            await websocket.close()
        except Exception:
            pass


@router.get(
    "/status",
    summary="查询当前登录用户的本地 Bridge 节点连接状态",
)
async def get_bridge_status(
    user: AuthenticatedUser = Depends(get_current_user),
):
    manager = BridgeManager.get_instance()
    uid = str(user.id)
    connected = manager.is_connected(uid)
    meta = manager.get_metadata(uid) if connected else None

    return {
        "connected": connected,
        "metadata": meta,
    }
