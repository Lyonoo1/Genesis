import json
import time
import uuid
from enum import Enum
from typing import Any, Optional
from pydantic import BaseModel, ConfigDict, Field


class StreamChannel(str, Enum):
    """全局流式逻辑通道枚举"""

    CHAT = "chat"
    WORKBENCH_DIFF = "workbench_diff"
    WORKBENCH_PTY = "workbench_pty"
    PLAN_STATE = "plan_state"
    CONTEXT_TELEMETRY = "context_telemetry"

    @classmethod
    def _missing_(cls, value: object) -> Optional["StreamChannel"]:
        if isinstance(value, str):
            lowered = value.strip().lower()
            for member in cls:
                if member.value == lowered:
                    return member
        return None


class AgentRunMode(str, Enum):
    """Agent 双模态运行模式枚举"""

    PLAN = "plan"
    ACT = "act"

    @classmethod
    def _missing_(cls, value: object) -> Optional["AgentRunMode"]:
        if isinstance(value, str):
            lowered = value.strip().lower()
            for member in cls:
                if member.value == lowered:
                    return member
        return None


class AgentLifecycleState(str, Enum):
    """Agent 有限状态机生命周期状态枚举"""

    IDLE = "IDLE"
    PLANNING = "PLANNING"
    AWAITING_PLAN_APPROVAL = "AWAITING_PLAN_APPROVAL"
    COMPILING_CONTEXT = "COMPILING_CONTEXT"
    STREAMING_LLM = "STREAMING_LLM"
    EXECUTING_TOOLS = "EXECUTING_TOOLS"
    EVALUATING = "EVALUATING"
    INTERRUPTED = "INTERRUPTED"
    COMPLETED = "COMPLETED"

    @classmethod
    def _missing_(cls, value: object) -> Optional["AgentLifecycleState"]:
        if isinstance(value, str):
            upper = value.strip().upper()
            for member in cls:
                if member.value == upper:
                    return member
        return None


class StreamEnvelope(BaseModel):
    """全局 SSE 流式信封契约（支持顶层展开向下兼容）"""

    model_config = ConfigDict(extra="allow")

    seq: int = Field(..., ge=1, description="会话内单轮严格递增序列号")
    turn_id: str = Field(..., description="当前推理轮次唯一标识")
    agent_id: str = Field(default="root", description="主 Agent 为 root，子代理为 subagent_xxx")
    parent_call_id: Optional[str] = Field(default=None, description="父级工具调用 ID")
    channel: StreamChannel = Field(default=StreamChannel.CHAT, description="消息所属通道")
    event: str = Field(..., description="对齐 SSEEventName 的事件名")
    payload: dict[str, Any] = Field(default_factory=dict, description="事件原始负载字典")
    timestamp: int = Field(
        default_factory=lambda: int(time.time() * 1000),
        description="毫秒级时间戳",
    )

    def to_compat_dict(self) -> dict[str, Any]:
        """输出包含完整 StreamEnvelope 字段且将 payload 键值展开到顶层的兼容字典"""
        channel_val = (
            self.channel.value
            if isinstance(self.channel, StreamChannel)
            else str(self.channel)
        )
        envelope_fields: dict[str, Any] = {
            "seq": self.seq,
            "turn_id": self.turn_id,
            "agent_id": self.agent_id,
            "parent_call_id": self.parent_call_id,
            "channel": channel_val,
            "event": self.event,
            "payload": dict(self.payload),
            "timestamp": self.timestamp,
        }
        merged: dict[str, Any] = {**self.payload, **envelope_fields}
        if "agent_id" in self.payload and self.payload["agent_id"]:
            merged["agent_id"] = str(self.payload["agent_id"])
        return merged

    def to_sse(self) -> str:
        """序列化为标准 W3C SSE 帧"""
        data_dict = self.to_compat_dict()
        return f"event: {self.event}\ndata: {json.dumps(data_dict, ensure_ascii=False)}\n\n"


class EnvelopeEmitter:
    """单轮会话流式信封发射器：维护严格递增 seq 并生成双模兼容 SSE 报文"""

    def __init__(self, turn_id: Optional[str] = None, start_seq: int = 0):
        self.turn_id: str = turn_id or f"turn_{uuid.uuid4().hex[:12]}"
        self._seq: int = start_seq
        self._queue: Optional[Any] = None

    @property
    def current_seq(self) -> int:
        return self._seq

    @property
    def queue(self) -> Optional[Any]:
        return self._queue

    def attach_queue(self, queue: Any) -> None:
        self._queue = queue

    def create_envelope(
        self,
        event: str,
        payload: dict[str, Any],
        channel: StreamChannel = StreamChannel.CHAT,
        agent_id: str = "root",
        parent_call_id: Optional[str] = None,
    ) -> StreamEnvelope:
        self._seq += 1
        event_str = event.value if isinstance(event, Enum) else str(event)
        safe_payload = dict(payload or {})
        effective_agent_id = agent_id
        if effective_agent_id == "root" and safe_payload.get("agent_id"):
            effective_agent_id = str(safe_payload["agent_id"])

        return StreamEnvelope(
            seq=self._seq,
            turn_id=self.turn_id,
            agent_id=effective_agent_id,
            parent_call_id=parent_call_id,
            channel=channel,
            event=event_str,
            payload=safe_payload,
            timestamp=int(time.time() * 1000),
        )

    def emit_sse(
        self,
        event: str,
        payload: dict[str, Any],
        channel: StreamChannel = StreamChannel.CHAT,
        agent_id: str = "root",
        parent_call_id: Optional[str] = None,
    ) -> str:
        """生成既包含 StreamEnvelope 结构又将 payload 展开至顶层的 SSE 字符串"""
        envelope = self.create_envelope(
            event=event,
            payload=payload,
            channel=channel,
            agent_id=agent_id,
            parent_call_id=parent_call_id,
        )
        sse_str = envelope.to_sse()
        if self._queue is not None:
            try:
                self._queue.put_nowait(sse_str)
            except Exception:
                pass
        return sse_str

    def fork_queued(self, queue: Any) -> "QueuedEnvelopeEmitter":
        """创建共享 turn_id 与严格递增 seq 的后台多路复用发射器，仅将后台事件写入指定队列"""
        return QueuedEnvelopeEmitter(parent=self, queue=queue)


class QueuedEnvelopeEmitter:
    """后台协程多路复用信封代理：与主 EnvelopeEmitter 共享 turn_id/seq，并将发射的 SSE 帧推入队列"""

    def __init__(self, parent: EnvelopeEmitter, queue: Any) -> None:
        self._parent = parent
        self._queue = queue

    @property
    def turn_id(self) -> str:
        return self._parent.turn_id

    @property
    def current_seq(self) -> int:
        return self._parent.current_seq

    @property
    def queue(self) -> Any:
        return self._queue

    def create_envelope(
        self,
        event: str,
        payload: dict[str, Any],
        channel: StreamChannel = StreamChannel.CHAT,
        agent_id: str = "root",
        parent_call_id: Optional[str] = None,
    ) -> StreamEnvelope:
        return self._parent.create_envelope(
            event=event,
            payload=payload,
            channel=channel,
            agent_id=agent_id,
            parent_call_id=parent_call_id,
        )

    def emit_sse(
        self,
        event: str,
        payload: dict[str, Any],
        channel: StreamChannel = StreamChannel.CHAT,
        agent_id: str = "root",
        parent_call_id: Optional[str] = None,
    ) -> str:
        sse_str = self._parent.emit_sse(
            event=event,
            payload=payload,
            channel=channel,
            agent_id=agent_id,
            parent_call_id=parent_call_id,
        )
        if self._queue is not None and self._parent.queue is not self._queue:
            try:
                self._queue.put_nowait(sse_str)
            except Exception:
                pass
        return sse_str

