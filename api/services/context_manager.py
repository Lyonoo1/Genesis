import json
import logging
from typing import Any, Optional, Union
from uuid import UUID

from models.schemas.stream_envelope import AgentRunMode, EnvelopeEmitter
from repositories.message_repository import MessageRepository
from services.context_compiler import (
    AtomicTurn,
    ContextCompiler,
    LosslessStubFolder,
    TokenMeter,
    WorkspaceDirtyTracker,
    context_compiler,
    workspace_dirty_tracker,
)

logger = logging.getLogger("genesis.context_manager")

# 单条工具输出最大字符数，超出则截断首尾保护模型上下文
MAX_TOOL_OUTPUT_CHARS = 4000
# 最大消息轮次保留上限
MAX_MESSAGES_WINDOW = 40


class ContextManager:
    """会话上下文管理器门面适配器：内部全面委托给三段式 Prefix-Cache ContextCompiler"""

    def __init__(
        self,
        message_repo: Optional[MessageRepository] = None,
        compiler: Optional[ContextCompiler] = None,
    ):
        self.message_repo = message_repo or MessageRepository()
        self.compiler = compiler or context_compiler

    @staticmethod
    def estimate_tokens(text: Any, model: str = "gpt-4o") -> int:
        return TokenMeter.count_tokens(text, model=model)

    @staticmethod
    def gate_tool_output(content: Any) -> str:
        return ContextCompiler.gate_tool_output(content)

    @classmethod
    def truncate_tool_output(cls, content: str, max_chars: int = MAX_TOOL_OUTPUT_CHARS) -> str:
        return cls.gate_tool_output(content)

    @classmethod
    def _convert_db_message(cls, msg: dict[str, Any]) -> dict[str, Any]:
        return ContextCompiler.convert_db_message(msg)

    def build_atomic_turns(self, db_messages: list[dict[str, Any]]) -> list[AtomicTurn]:
        return self.compiler.build_atomic_turns(db_messages)

    @classmethod
    def apply_micro_compact(cls, turns: list[AtomicTurn]) -> list[AtomicTurn]:
        """L2 微压缩向下兼容接口（新编译主链路默认使用 LosslessStubFolder.fold_turns）"""
        n = len(turns)
        for idx, turn in enumerate(turns):
            distance = (n - 1) - idx
            if distance > 5:
                for msg in turn.messages:
                    if msg.get("role") == "tool":
                        content = msg.get("content") or ""
                        content_len = (
                            len(content)
                            if isinstance(content, str)
                            else len(json.dumps(content, ensure_ascii=False))
                        )
                        if content_len > 2000:
                            msg["content"] = (
                                "[Historical tool output cleared to save context. Re-read if needed.]"
                            )
        return turns

    def _estimate_turn_tokens(self, turn: AtomicTurn) -> int:
        return self.compiler.estimate_turn_tokens(turn)

    def apply_budget_pruning(
        self,
        turns: list[AtomicTurn],
        budget: int,
        return_pruned: bool = False,
    ) -> Union[list[AtomicTurn], tuple[list[AtomicTurn], list[AtomicTurn]]]:
        return self.compiler.apply_budget_pruning(
            turns=turns,
            budget=budget,
            return_pruned=return_pruned,
        )

    def _extract_fallback_summary(
        self,
        pruned_turns: list[AtomicTurn],
        session_id: Optional[str] = None,
    ) -> str:
        return self.compiler.extract_fallback_summary(
            pruned_turns=pruned_turns,
            session_id=session_id,
        )

    async def generate_compact_summary(
        self,
        pruned_turns: list[AtomicTurn],
        model: Optional[str] = None,
        session_id: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> str:
        return await self.compiler.generate_compact_summary(
            pruned_turns=pruned_turns,
            model=model,
            session_id=session_id,
            api_key=api_key,
            base_url=base_url,
            provider=provider,
        )

    async def build_context(
        self,
        user_id: str,
        session_id: Union[UUID, str, Any],
        new_prompt: str,
        parent_id: Optional[Any] = None,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
        has_tools: bool = False,
        context_window: int = 1048576,
        workspace_root: Optional[str] = None,
        mode: Union[AgentRunMode, str] = AgentRunMode.ACT,
        emitter: Optional[EnvelopeEmitter] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """委托给 ContextCompiler.compile 执行三段式上下文编译"""
        return await self.compiler.compile(
            user_id=user_id,
            session_id=session_id,
            new_prompt=new_prompt,
            message_repo=self.message_repo,
            parent_id=parent_id,
            system_prompt=system_prompt,
            model=model,
            has_tools=has_tools,
            context_window=context_window,
            workspace_root=workspace_root,
            mode=mode,
            emitter=emitter,
            api_key=api_key,
            base_url=base_url,
            provider=provider,
        )


# 单例
context_manager = ContextManager()
