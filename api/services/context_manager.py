import json
import logging
from typing import Any, Optional
from uuid import UUID

from repositories.message_repository import MessageRepository

logger = logging.getLogger("genesis.context_manager")

# 单条工具输出最大字符数，超出则截断首尾保护模型上下文
MAX_TOOL_OUTPUT_CHARS = 4000
# 最大消息轮次保留上限
MAX_MESSAGES_WINDOW = 40


class ContextManager:
    """会话上下文与历史窗口管理器：负责分支修剪、长上下文窗口截断与标准消息转换"""

    def __init__(self, message_repo: Optional[MessageRepository] = None):
        self.message_repo = message_repo or MessageRepository()

    @staticmethod
    def estimate_tokens(text: str) -> int:
        if not text:
            return 0
        # 混合代码、中文与英文平均约 1.8~2 字符 / token
        return max(1, len(text) // 2)

    async def build_context(
        self,
        user_id: str,
        session_id: UUID,
        new_prompt: str,
        parent_id: Optional[UUID] = None,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
        has_tools: bool = False,
        context_window: int = 1048576,
    ) -> list[dict[str, Any]]:
        """从数据库读取并组装待喂给 LLM 的标准上下文消息数组 (基于 80% Token 动态预算滑动窗口)"""
        # 1. 如果指定了 parent_id，先执行分支修剪（Prune Branch）
        if parent_id:
            await self.message_repo.prune_branch(
                user_id=user_id,
                session_id=session_id,
                parent_id=parent_id,
            )

        # 2. 动态 Token 预算管理：80% 留给历史上下文与当前输入，20% 留给模型生成
        max_context_budget = int(context_window * 0.8)
        current_budget = max_context_budget - self.estimate_tokens(new_prompt) - (self.estimate_tokens(system_prompt) if system_prompt else 200)

        # 查询数据库历史记录（放开硬编码 limit，最高读取 1000 条进行 Token 预算过滤）
        db_res = await self.message_repo.list_by_session(
            user_id=user_id,
            session_id=session_id,
            limit=1000,
        )
        db_messages = db_res[0] if isinstance(db_res, tuple) else db_res

        # 逆序倒推：从最新历史往最旧历史计算，累加消耗，保留在预算内的完整历史
        selected_history: list[dict[str, Any]] = []
        accumulated_tokens = 0
        for msg in reversed(db_messages):
            msg_content = msg.get("content") or ""
            msg_tokens = self.estimate_tokens(msg_content)
            if accumulated_tokens + msg_tokens > current_budget and selected_history:
                # 超过 80% 预算，停止纳入更早的历史
                break
            selected_history.insert(0, msg)
            accumulated_tokens += msg_tokens

        formatted_messages: list[dict[str, Any]] = []

        # 3. 注入系统 Prompt
        # DeepSeek-R1 / 推理模型官方规范：避免注入冗余的 Agentic/软件工程系统指令，
        # 否则会误导模型将普通创作任务（如“写个鹈鹕骑车”）强行推导为逆向运动学、物理引擎与几何坐标求解，耗尽 Token。
        is_reasoner = model and any(k in model.lower() for k in ["reasoner", "r1", "o1", "o3"])

        if system_prompt:
            formatted_messages.append({"role": "system", "content": system_prompt})
        elif not is_reasoner and has_tools:
            formatted_messages.append(
                {
                    "role": "system",
                    "content": (
                        "You are Genesis, a high-performance, expert AI software engineer.\n"
                        "You have access to tools via MCP and local Skills. Use them proactively to inspect, test, and build solutions."
                    ),
                }
            )

        # 4. 转换历史消息
        for msg in selected_history:
            role = msg.get("role")
            content = msg.get("content") or ""
            raw_tools = msg.get("raw_tool_calls")
            tool_call_id = msg.get("tool_call_id")

            if role == "user":
                formatted_messages.append({"role": "user", "content": content})
            elif role == "assistant":
                item: dict[str, Any] = {"role": "assistant"}
                if content:
                    item["content"] = content
                if raw_tools and isinstance(raw_tools, list):
                    standard_tool_calls = []
                    for t in raw_tools:
                        standard_tool_calls.append(
                            {
                                "id": t.get("id"),
                                "type": "function",
                                "function": {
                                    "name": t.get("name"),
                                    "arguments": json.dumps(t.get("args") or {}),
                                },
                            }
                        )
                    item["tool_calls"] = standard_tool_calls
                if not content and not item.get("tool_calls"):
                    continue
                formatted_messages.append(item)
            elif role == "tool":
                # 滑动窗口截断超长输出
                truncated_content = self.truncate_tool_output(content)
                formatted_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id or "unknown_call",
                        "content": truncated_content,
                    }
                )

        # 5. 追加当前轮次用户新提问 (如果历史库中尚未包含)
        if not formatted_messages or formatted_messages[-1] != {"role": "user", "content": new_prompt}:
            formatted_messages.append({"role": "user", "content": new_prompt})

        return formatted_messages

    @staticmethod
    def truncate_tool_output(content: str, max_chars: int = MAX_TOOL_OUTPUT_CHARS) -> str:
        """保护性截断超长输出，保留前部与尾部关键信息"""
        if not content or len(content) <= max_chars:
            return content

        half = max_chars // 2
        omitted_chars = len(content) - max_chars
        return (
            f"{content[:half]}\n\n"
            f"... [Genesis 上下文截断: 已省略中间 {omitted_chars} 字符以防超长溢出] ...\n\n"
            f"{content[-half:]}"
        )


# 单例
context_manager = ContextManager()
