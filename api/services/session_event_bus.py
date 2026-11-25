import asyncio
import logging
from collections import defaultdict
from typing import Any

logger = logging.getLogger("genesis.event_bus")


class SessionEventBus:
    """进程内会话级发布订阅总线（单 worker 前提，零外部依赖）。"""

    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[tuple[str, dict[str, Any]]]]] = defaultdict(set)

    def subscribe(self, session_id: str) -> asyncio.Queue[tuple[str, dict[str, Any]]]:
        q: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=256)
        self._subs[str(session_id)].add(q)
        return q

    def unsubscribe(
        self,
        session_id: str,
        q: asyncio.Queue[tuple[str, dict[str, Any]]],
    ) -> None:
        sid = str(session_id)
        subs = self._subs.get(sid)
        if subs:
            subs.discard(q)
            if not subs:
                self._subs.pop(sid, None)

    def publish(self, session_id: str, event: str, data: dict[str, Any]) -> None:
        sid = str(session_id)
        for q in list(self._subs.get(sid, ())):
            try:
                q.put_nowait((event, data))
            except asyncio.QueueFull:
                logger.warning("会话 [%s] 订阅者队列已满，丢弃事件 %s", sid, event)

    def subscriber_count(self, session_id: str) -> int:
        return len(self._subs.get(str(session_id), ()))


session_event_bus = SessionEventBus()
