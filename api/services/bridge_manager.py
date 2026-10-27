import asyncio
import json
import logging
import uuid
from typing import Any, Optional
from fastapi import WebSocket

logger = logging.getLogger("genesis.bridge")


class BridgeManager:
    """本地 Bridge 反向 WebSocket 隧道中枢 (云端 RPC 调度器)

    支持云端 Agent 穿透 NAT 隧道执行访客本地 Mac/PC 的：
    - 物理文件读写、修改、行级差异替换与目录检索
    - 本地 Shell 终端指令执行 (如 npm test, git, cargo 等)
    """

    _instance: Optional["BridgeManager"] = None

    def __init__(self):
        # user_id -> WebSocket
        self._connections: dict[str, WebSocket] = {}
        # user_id -> metadata (hostname, platform, cwd, connected_at)
        self._metadata: dict[str, dict[str, Any]] = {}
        # call_id -> asyncio.Future[dict]
        self._pending_rpc: dict[str, asyncio.Future] = {}
        # user_id -> lock
        self._locks: dict[str, asyncio.Lock] = {}

    @classmethod
    def get_instance(cls) -> "BridgeManager":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def register(self, user_id: str, ws: WebSocket, metadata: dict[str, Any]) -> None:
        """注册本地 Bridge 连接"""
        self._connections[user_id] = ws
        self._metadata[user_id] = metadata
        if user_id not in self._locks:
            self._locks[user_id] = asyncio.Lock()
        logger.info(
            "用户 [%s] 本地 Bridge 建立连接成功 (主机: %s, 目录: %s, 平台: %s)",
            user_id,
            metadata.get("hostname"),
            metadata.get("cwd"),
            metadata.get("platform"),
        )

    def unregister(self, user_id: str) -> None:
        """注销本地 Bridge 连接"""
        if user_id in self._connections:
            del self._connections[user_id]
        if user_id in self._metadata:
            del self._metadata[user_id]
        logger.info("用户 [%s] 本地 Bridge 已断开注销", user_id)

    def is_connected(self, user_id: str) -> bool:
        """检测指定用户当前是否挂载了活跃的本地 Bridge 节点"""
        return user_id in self._connections

    def get_metadata(self, user_id: str) -> Optional[dict[str, Any]]:
        """获取本地 Bridge 节点的系统元数据"""
        return self._metadata.get(user_id)

    def handle_incoming_message(self, user_id: str, payload_text: str) -> None:
        """处理本地 Bridge 客户端推送过来的 RPC 响应结果"""
        try:
            msg = json.loads(payload_text)
            call_id = msg.get("id")
            if call_id and call_id in self._pending_rpc:
                future = self._pending_rpc[call_id]
                if not future.done():
                    future.set_result(msg)
        except Exception as e:
            logger.error("解析本地 Bridge RPC 回传消息异常: %s", e)

    async def call_rpc(
        self,
        user_id: str,
        method: str,
        params: dict[str, Any],
        timeout: int = 60,
    ) -> dict[str, Any]:
        """通过反向隧道向用户本地 Bridge 发起同步等待的 RPC 调用"""
        ws = self._connections.get(user_id)
        if not ws:
            raise ConnectionError(
                f"未检测到用户 [{user_id}] 的本地 Bridge 隧道连接，请在本地终端启动: npx genesis-bridge"
            )

        call_id = f"rpc_{uuid.uuid4().hex[:12]}"
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending_rpc[call_id] = future

        req_payload = {
            "id": call_id,
            "method": method,
            "params": params,
        }

        lock = self._locks.get(user_id)
        if not lock:
            lock = asyncio.Lock()
            self._locks[user_id] = lock

        try:
            async with lock:
                await ws.send_text(json.dumps(req_payload))

            # 等待本地客户端执行完毕回传结果
            response = await asyncio.wait_for(future, timeout=float(timeout))

            if "error" in response and response["error"]:
                return {
                    "success": False,
                    "error": response["error"],
                }
            return response.get("result", {"success": True})
        except asyncio.TimeoutError:
            logger.error("RPC [%s] 调用本地 Bridge 超时 (%ds)", method, timeout)
            return {
                "success": False,
                "error": f"本地 Bridge 执行方法 [{method}] 超时 (超过 {timeout} 秒未响应)",
            }
        except Exception as e:
            logger.error("RPC [%s] 隧道传输异常: %s", method, e)
            return {
                "success": False,
                "error": f"本地 Bridge 隧道通信异常: {str(e)}",
            }
        finally:
            self._pending_rpc.pop(call_id, None)
