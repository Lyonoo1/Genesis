import json
import logging
from dataclasses import dataclass
from typing import Any, Optional, Union
from uuid import UUID

from repositories.message_repository import MessageRepository
from services.todo_manager import todo_manager

logger = logging.getLogger("genesis.context_manager")

# 单条工具输出最大字符数，超出则截断首尾保护模型上下文
MAX_TOOL_OUTPUT_CHARS = 4000
# 最大消息轮次保留上限
MAX_MESSAGES_WINDOW = 40


@dataclass
class AtomicTurn:
    """不可分割的原子 Turn 单元，绑定单次交互或 assistant 工具调用及其全部 tool 结果"""

    role: str  # "user" | "assistant"
    messages: list[dict[str, Any]]


class ContextManager:
    """会话上下文与历史窗口管理器：负责分支修剪、原子轮次修剪、长上下文窗口截断与三级防爆机制"""

    def __init__(self, message_repo: Optional[MessageRepository] = None):
        self.message_repo = message_repo or MessageRepository()

    @staticmethod
    def estimate_tokens(text: Any) -> int:
        if not text:
            return 0
        if isinstance(text, str):
            return max(1, len(text) // 2)
        if isinstance(text, list):
            total = 0
            for item in text:
                if isinstance(item, dict):
                    t = item.get("text") or item.get("content")
                    if t and isinstance(t, str):
                        total += len(t) // 2
                    else:
                        total += len(str(item)) // 2
                else:
                    total += len(str(item)) // 2
            return max(1, total)
        return max(1, len(str(text)) // 2)

    @staticmethod
    def gate_tool_output(content: Any) -> str:
        """L1 输出守门员：单次工具返回结果超过 15,000 字符或 500 行时进行保护性截断"""
        if content is None:
            return ""
        if not isinstance(content, str):
            content = str(content)
        if not content:
            return ""

        lines = content.split("\n")
        total_lines = len(lines)
        total_chars = len(content)

        if total_chars > 15000 or total_lines > 500:
            # 优先尝试 JSON 安全截断，避免破坏前端或大模型读取时的 JSON 结构完整性
            stripped = content.strip()
            if (stripped.startswith("{") and stripped.endswith("}")) or (
                stripped.startswith("[") and stripped.endswith("]")
            ):
                try:
                    data = json.loads(stripped)
                    if isinstance(data, dict):
                        for k in [
                            "stdout",
                            "diff",
                            "unified_diff",
                            "original_content",
                            "modified_content",
                            "content",
                            "logs",
                            "recent_logs",
                        ]:
                            if k in data and isinstance(data[k], str) and len(data[k]) > 4000:
                                data[k] = (
                                    data[k][:2500]
                                    + f"\n... [字段 {k} 输出过长已保护性截断] ...\n"
                                    + data[k][-1500:]
                                )
                        data["_truncated"] = True
                        return json.dumps(data, ensure_ascii=False)
                except Exception:
                    pass

            if total_lines > 300:
                omitted_lines = total_lines - 300
                placeholder = f'<truncated lines="{omitted_lines}">[输出过长已截断，请使用 grep_search 或指定行号范围读取]</truncated>'
                return "\n".join(lines[:200] + [placeholder] + lines[-100:])
            else:
                # 极端情况：行数 <= 300 但单行或少行字符总数超过 15,000
                half = 7500
                placeholder = '<truncated lines="0">[输出过长已截断，请使用 grep_search 或指定行号范围读取]</truncated>'
                return f"{content[:half]}\n{placeholder}\n{content[-half:]}"

        return content

    @classmethod
    def truncate_tool_output(cls, content: str, max_chars: int = MAX_TOOL_OUTPUT_CHARS) -> str:
        """向后兼容接口：优先应用 L1 守门员截断"""
        return cls.gate_tool_output(content)

    @classmethod
    def _convert_db_message(cls, msg: dict[str, Any]) -> dict[str, Any]:
        """将数据库消息实体解析为标准的 OpenAI 兼容消息对象字典"""
        role = msg.get("role")
        content = msg.get("content") or ""
        raw_tools = msg.get("raw_tool_calls") or msg.get("tool_calls")
        tool_call_id = msg.get("tool_call_id")

        if role == "user":
            return {"role": "user", "content": content}
        elif role == "assistant":
            item: dict[str, Any] = {"role": "assistant"}
            if content:
                item["content"] = content
            if isinstance(raw_tools, str):
                try:
                    raw_tools = json.loads(raw_tools)
                except Exception:
                    raw_tools = []
            if raw_tools and isinstance(raw_tools, list):
                standard_tool_calls = []
                for t in raw_tools:
                    if hasattr(t, "model_dump"):
                        t = t.model_dump()
                    elif hasattr(t, "__dict__"):
                        t = t.__dict__
                    if isinstance(t, dict):
                        tc_id = t.get("id")
                        if "function" in t and isinstance(t["function"], dict):
                            fn_name = t["function"].get("name")
                            fn_args = t["function"].get("arguments")
                        else:
                            fn_name = t.get("name")
                            fn_args = t.get("args")

                        if isinstance(fn_args, dict):
                            fn_args_str = json.dumps(fn_args, ensure_ascii=False)
                        elif isinstance(fn_args, str):
                            fn_args_str = fn_args
                        else:
                            fn_args_str = "{}"

                        standard_tool_calls.append(
                            {
                                "id": tc_id,
                                "type": "function",
                                "function": {
                                    "name": fn_name,
                                    "arguments": fn_args_str,
                                },
                            }
                        )
                if standard_tool_calls:
                    item["tool_calls"] = standard_tool_calls
            return item
        elif role == "tool":
            tool_msg = {
                "role": "tool",
                "tool_call_id": tool_call_id or "unknown_call",
                "content": cls.gate_tool_output(content),
            }
            if msg.get("is_error") or str(msg.get("status", "")).lower() == "failed":
                tool_msg["is_error"] = True
            return tool_msg

        return msg

    def build_atomic_turns(self, db_messages: list[dict[str, Any]]) -> list[AtomicTurn]:
        """原子级 Turn 打包与断链自愈：将 assistant(含 tool_calls) 与全部紧随的 tool 绑定为不可分割单元"""
        turns: list[AtomicTurn] = []
        i = 0
        n = len(db_messages)

        while i < n:
            msg = db_messages[i]
            role = msg.get("role")

            if role == "tool":
                # 孤立的 tool 消息（前面没有对应的 assistant tool_calls），直接过滤丢弃
                logger.warning("发现孤立 tool 消息 (id: %s)，已自动丢弃", msg.get("tool_call_id"))
                i += 1
                continue

            elif role == "user":
                converted = self._convert_db_message(msg)
                turns.append(AtomicTurn(role="user", messages=[converted]))
                i += 1

            elif role == "assistant":
                asst_item = self._convert_db_message(msg)
                tool_calls = asst_item.get("tool_calls")

                if not tool_calls:
                    # 纯文本回复 (或无 tool_calls)
                    if asst_item.get("content"):
                        turns.append(AtomicTurn(role="assistant", messages=[asst_item]))
                    i += 1
                else:
                    # 包含 tool_calls，必须绑定后续全部 tool 消息并执行断链自愈
                    turn_messages = [asst_item]
                    expected_tool_call_ids = [tc.get("id") for tc in tool_calls if tc.get("id")]

                    # 收集紧随其后的所有 role == "tool" 消息
                    found_tool_msgs: dict[str, dict[str, Any]] = {}
                    j = i + 1
                    while j < n and db_messages[j].get("role") == "tool":
                        tool_raw = db_messages[j]
                        tid = tool_raw.get("tool_call_id")
                        if tid and tid in expected_tool_call_ids:
                            found_tool_msgs[tid] = self._convert_db_message(tool_raw)
                        j += 1

                    # 断链自愈（防 400 报错）：补齐因 /stop 或拒绝审批缺失的 tool_call_id 占位消息
                    for tid in expected_tool_call_ids:
                        if tid in found_tool_msgs:
                            turn_messages.append(found_tool_msgs[tid])
                        else:
                            logger.info("自愈断链工具调用 (tool_call_id: %s)", tid)
                            turn_messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": tid,
                                    "content": "[Execution aborted or rejected by user]",
                                    "is_error": True,
                                }
                            )

                    turns.append(AtomicTurn(role="assistant", messages=turn_messages))
                    i = j
            else:
                # 其他角色（如 system），跳过
                i += 1

        return turns

    @classmethod
    def apply_micro_compact(cls, turns: list[AtomicTurn]) -> list[AtomicTurn]:
        """L2 微压缩：对距离当前最新轮次超过 5 个 Turn 的旧 AtomicTurn，超长 tool 内容原地替换为轻量标记"""
        n = len(turns)
        for idx, turn in enumerate(turns):
            distance = (n - 1) - idx
            if distance > 5:
                for msg in turn.messages:
                    if msg.get("role") == "tool":
                        content = msg.get("content") or ""
                        content_len = len(content) if isinstance(content, str) else len(json.dumps(content, ensure_ascii=False))
                        if content_len > 2000:
                            msg["content"] = "[Historical tool output cleared to save context. Re-read if needed.]"
        return turns

    def _estimate_turn_tokens(self, turn: AtomicTurn) -> int:
        """评估单个 AtomicTurn 的 Token 总消耗"""
        total = 0
        for m in turn.messages:
            content = m.get("content") or ""
            total += self.estimate_tokens(content)
            tool_calls = m.get("tool_calls")
            if tool_calls and isinstance(tool_calls, list):
                total += self.estimate_tokens(json.dumps(tool_calls, ensure_ascii=False))
        return total

    def apply_budget_pruning(
        self,
        turns: list[AtomicTurn],
        budget: int,
        return_pruned: bool = False,
    ) -> Union[list[AtomicTurn], tuple[list[AtomicTurn], list[AtomicTurn]]]:
        """L3 预算裁剪：始终保留第 1 条 User 消息（初始任务目标），然后从最新的 AtomicTurn 往前逆序累加，超出预算整组淘汰。
        若 return_pruned=True，同时返回 (selected_turns, pruned_turns)，用于触发 Auto-Compact 结构化摘要。
        """
        if not turns:
            return ([], []) if return_pruned else []

        # 找到第 1 条 User 消息所在的 AtomicTurn
        first_user_turn: Optional[AtomicTurn] = None
        for t in turns:
            if t.role == "user" or any(m.get("role") == "user" for m in t.messages):
                first_user_turn = t
                break

        first_user_tokens = 0
        if first_user_turn:
            first_user_tokens = self._estimate_turn_tokens(first_user_turn)

        # 预留首条 User 消息预算
        budget_for_history = max(0, budget - first_user_tokens) if first_user_turn else budget

        selected_turns: list[AtomicTurn] = []
        accumulated_tokens = 0

        # 从最新往最旧逆序累加
        for t in reversed(turns):
            if first_user_turn and t is first_user_turn:
                continue

            t_tokens = self._estimate_turn_tokens(t)
            if accumulated_tokens + t_tokens > budget_for_history:
                # 超出预算，停止纳入更早轮次
                break

            selected_turns.append(t)
            accumulated_tokens += t_tokens

        # 还原为正序
        selected_turns.reverse()

        # 始终保留第 1 条 User 消息
        if first_user_turn:
            selected_turns.insert(0, first_user_turn)

        if not return_pruned:
            return selected_turns

        # 提取被裁剪淘汰的中间轮次（排除保留的首条 User 消息）
        pruned_turns: list[AtomicTurn] = []
        for t in turns:
            if first_user_turn and t is first_user_turn:
                continue
            if t not in selected_turns:
                pruned_turns.append(t)

        return selected_turns, pruned_turns

    def _extract_fallback_summary(
        self,
        pruned_turns: list[AtomicTurn],
        session_id: Optional[str] = None,
    ) -> str:
        """规则兜底提取器：当大模型不可用或调用超时时，确定性生成符合规范的三段式结构化摘要"""
        import re

        files_modified: set[str] = set()
        unresolved_errors: list[str] = []
        context_constraints: list[str] = []
        todos_extracted: list[str] = []

        for turn in pruned_turns:
            for msg in turn.messages:
                role = msg.get("role")
                content = str(msg.get("content") or "")

                # 0. 如果历史消息中包含前一轮的 compact_summary，无损继承其记录
                if "<compact_summary>" in content and "</compact_summary>" in content:
                    m_files = re.search(r"\[已修改文件与变更摘要\]\s*([\s\S]*?)(?=\n\n\[|$)", content)
                    if m_files:
                        for line in m_files.group(1).splitlines():
                            line_s = line.strip().lstrip("-* ").strip()
                            if line_s and "未直接产生" not in line_s:
                                files_modified.add(line_s)
                    m_errs = re.search(r"\[已解决与未解决的报错\]\s*([\s\S]*?)(?=\n\n\[|$)", content)
                    if m_errs:
                        for line in m_errs.group(1).splitlines():
                            line_s = line.strip().lstrip("-* ").strip()
                            if line_s and "未记录未解决报错" not in line_s:
                                unresolved_errors.append(line_s)
                    m_c = re.search(r"\[核心上下文约束与待办进度\]\s*([\s\S]*?)(?=\n\n\[|</compact_summary>|$)", content)
                    if m_c:
                        for line in m_c.group(1).splitlines():
                            line_s = line.strip().lstrip("-* ").strip()
                            if line_s and "保持既定" not in line_s:
                                context_constraints.append(line_s)

                # 1. 提取已修改/删除的文件与待办状态机
                tool_calls = msg.get("tool_calls") or []
                for tc in tool_calls:
                    fn = tc.get("function", {}) if isinstance(tc, dict) else {}
                    fn_name = fn.get("name") or tc.get("name") or ""
                    raw_args = fn.get("arguments") or tc.get("args") or "{}"
                    try:
                        args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                    except Exception:
                        args = {}
                    if fn_name in ("workspace__write_file", "workspace__edit_file", "write_file", "edit_file"):
                        p = args.get("path")
                        if p:
                            files_modified.add(f"{p} ({fn_name.replace('workspace__', '')})")
                    elif fn_name in ("workspace__delete_file", "delete_file"):
                        p = args.get("path")
                        if p:
                            files_modified.add(f"{p} (deleted)")
                    elif fn_name in ("workspace__todo_write", "todo_write"):
                        t_list = args.get("todos", [])
                        if isinstance(t_list, str):
                            try:
                                t_list = json.loads(t_list)
                            except Exception:
                                t_list = []
                        if isinstance(t_list, list):
                            for td in t_list:
                                if isinstance(td, dict) and "id" in td:
                                    st = td.get("status", "pending")
                                    icon = "[x]" if st == "completed" else ("[▶]" if st == "in_progress" else "[ ]")
                                    todos_extracted.append(f"{icon} [{td.get('id')}]: {td.get('content')}")

                # 2. 提取报错
                if role == "tool":
                    if msg.get("is_error") or "error" in content.lower():
                        clean_err = content[:120].replace("\n", " ").strip()
                        unresolved_errors.append(clean_err)

                # 3. 提取用户关键要求
                if role == "user":
                    clean_u = content[:100].replace("\n", " ").strip()
                    if clean_u and not clean_u.startswith("[") and not clean_u.startswith("【"):
                        context_constraints.append(clean_u)

        files_section = "\n".join(f"- {f}" for f in sorted(files_modified)) if files_modified else "- 历史轮次未直接产生代码文件变更"
        errors_section = "\n".join(f"- {e}" for e in unresolved_errors[-3:]) if unresolved_errors else "- 历史执行未记录未解决报错"

        # 优先使用当前活跃会话的最新待办快照，其次使用 pruned_turns 中提取的待办
        todo_info = []
        if session_id:
            snap = todo_manager.format_todo_snapshot(str(session_id))
            if snap:
                todo_info.append(snap)
        if not todo_info and todos_extracted:
            todo_info.append("【待办进度快照】\n" + "\n".join(f"- {t}" for t in todos_extracted[-5:]))

        combined_constraints = []
        if todo_info:
            combined_constraints.extend(todo_info)
        if context_constraints:
            combined_constraints.extend(f"- 关键约束: {c}" for c in context_constraints[-3:])
        if not combined_constraints:
            combined_constraints.append("- 保持既定系统工程架构与业务规范")

        constraints_section = "\n".join(combined_constraints)

        return (
            "<compact_summary>\n"
            "[已修改文件与变更摘要]\n"
            f"{files_section}\n\n"
            "[已解决与未解决的报错]\n"
            f"{errors_section}\n\n"
            "[核心上下文约束与待办进度]\n"
            f"{constraints_section}\n"
            "</compact_summary>"
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
        """调用大模型为淘汰的旧 Turn 生成高质量 L3 结构化摘要，限制 800 Token 内"""
        if not pruned_turns:
            return ""

        # 先生成材料文本
        raw_turn_snippets = []
        for idx, turn in enumerate(pruned_turns):
            for m in turn.messages:
                r = m.get("role")
                c = str(m.get("content") or "")
                tc = m.get("tool_calls")
                if tc:
                    raw_turn_snippets.append(f"Turn {idx} [{r}]: tools={[t.get('function', {}).get('name') or t.get('name') for t in tc]}")
                elif c:
                    raw_turn_snippets.append(f"Turn {idx} [{r}]: {c[:200]}")

        snippet_text = "\n".join(raw_turn_snippets[:20])

        todo_hint = ""
        if session_id:
            cur_snap = todo_manager.format_todo_snapshot(str(session_id))
            if cur_snap:
                todo_hint = f"\nActive Todo Progress Snapshot:\n{cur_snap}\n"

        prompt_text = (
            "You are an expert conversation compression system for an AI coding assistant.\n"
            "Summarize the following archived conversation turns that are being pruned to conserve context window.\n"
            "Requirements:\n"
            "1. Output MUST be strictly under 800 tokens.\n"
            "2. Output MUST be enclosed in <compact_summary> and </compact_summary> tags.\n"
            "3. Output MUST contain exactly three structured sections:\n"
            "   [已修改文件与变更摘要]\n"
            "   [已解决与未解决的报错]\n"
            "   [核心上下文约束与待办进度]\n"
            f"{todo_hint}\n"
            f"Archived Turn Logs:\n{snippet_text}\n\n"
            "Summary:"
        )

        if model:
            try:
                from services.llm_adapter import llm_adapter

                summary_stream = llm_adapter.stream_chat(
                    messages=[{"role": "user", "content": prompt_text}],
                    tools=None,
                    model=model,
                    temperature=0.2,
                    max_tokens=600,
                    api_key=api_key,
                    base_url=base_url,
                    provider=provider,
                )
                accumulated = ""
                async for chunk in summary_stream:
                    if chunk.type == "text" and chunk.text:
                        accumulated += chunk.text

                accumulated = accumulated.strip()
                if "<compact_summary>" in accumulated and "</compact_summary>" in accumulated:
                    s_idx = accumulated.find("<compact_summary>")
                    e_idx = accumulated.find("</compact_summary>") + len("</compact_summary>")
                    extracted = accumulated[s_idx:e_idx]
                    if self.estimate_tokens(extracted) <= 800:
                        return extracted
                elif "[已修改文件与变更摘要]" in accumulated:
                    cleaned = accumulated
                    if not cleaned.startswith("<compact_summary>"):
                        cleaned = f"<compact_summary>\n{cleaned}"
                    if not cleaned.endswith("</compact_summary>"):
                        cleaned = f"{cleaned}\n</compact_summary>"
                    if self.estimate_tokens(cleaned) <= 800:
                        return cleaned
            except Exception as e:
                logger.warning("LLM 生成 L3 结构化摘要异常，启用规则提取降级: %s", e)

        # 规则兜底
        return self._extract_fallback_summary(pruned_turns, session_id=session_id)

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
        workspace_root: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """从数据库读取并组装待喂给 LLM 的标准上下文消息数组 (基于原子 Turn 与三级防爆机制)"""
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

        # 3. 构建原子级 Turn 并进行断链自愈
        atomic_turns = self.build_atomic_turns(db_messages)

        # 4. L2 微压缩 (Micro-compact)
        atomic_turns = self.apply_micro_compact(atomic_turns)

        # 5. L3 预算裁剪升级为无损结构化自动摘要 (Auto-Compact)
        selected_turns, pruned_turns = self.apply_budget_pruning(
            atomic_turns, budget=current_budget, return_pruned=True
        )

        # 若存在被裁剪的历史轮次，调用结构化自动摘要生成紧凑记忆块，并紧随第 1 条 User 消息保留在会话中
        if pruned_turns:
            compact_summary = await self.generate_compact_summary(
                pruned_turns,
                model=model,
                session_id=str(session_id),
                api_key=api_key,
                base_url=base_url,
                provider=provider,
            )
            if compact_summary:
                compact_turn = AtomicTurn(
                    role="assistant",
                    messages=[
                        {
                            "role": "assistant",
                            "content": f"[历史执行过程无损结构化归档记忆库]\n{compact_summary}",
                        }
                    ],
                )
                if selected_turns:
                    selected_turns.insert(1, compact_turn)
                    # 严格交替保护：若紧随其后的旧轮次也是 assistant 角色，插入过渡 user 消息
                    # 彻底解决部分大模型与网关因连续两条 assistant 消息报 400 校验错误
                    if len(selected_turns) > 2 and selected_turns[2].role == "assistant":
                        bridge_turn = AtomicTurn(
                            role="user",
                            messages=[
                                {
                                    "role": "user",
                                    "content": "[系统提示: 已确认以上历史执行结构化归档记忆，请继续基于上下文推进任务]",
                                }
                            ],
                        )
                        selected_turns.insert(2, bridge_turn)
                else:
                    selected_turns.append(compact_turn)

        formatted_messages: list[dict[str, Any]] = []

        # 6. 注入系统 Prompt
        if system_prompt:
            formatted_messages.append({"role": "system", "content": system_prompt})
        elif has_tools:
            ws_hint = f"当前项目物理工作区绝对路径：'{workspace_root}'。" if workspace_root else ""
            formatted_messages.append(
                {
                    "role": "system",
                    "content": (
                        "你是 Genesis 智能编程助手与 Coding Agent，直接运行于用户本地工作区环境中。\n"
                        f"{ws_hint}\n"
                        "你拥有直接操纵工作区文件的内置工具（workspace__delete_file、workspace__write_file、workspace__edit_file、workspace__read_file、workspace__list_dir、workspace__execute_command、workspace__grep_search、workspace__find_by_name、workspace__dispatch_subagent、workspace__todo_write）以及 MCP 和 Skills。\n\n"
                        "【工具调用行为规范】：\n"
                        "1. 意图定界与防过度行动（严格执行）：\n"
                        "   - 代码示例/概念演示/知识问答（如'做个简单示例'、'写个 demo'、'如何实现'、'示例代码'等）：直接在回复的 Markdown 代码块中输出清晰可用的代码示例，严禁擅自调用 write_file、edit_file 或 execute_command 去修改或执行用户本地项目文件！\n"
                        "   - 明确落盘需求（如明确指示'在项目中创建/修改文件'、'帮我写入项目'、'运行测试/命令'）：才允许调用文件与终端工具。\n"
                        "2. 按需精准触发：仅当用户的指令明确需要查看、读写、删除文件、分析代码或执行命令时，才调用对应工具。\n"
                        "3. 架构探索与长链路任务：遇到代码库大范围调查或排查报错时，优先调用 workspace__dispatch_subagent 隔离探索；面对多步骤任务必须通过 workspace__todo_write 规划和维护任务状态。\n"
                        "4. 严禁无故探测：面对普通问候（如'你好'、'hi'）、闲聊或通用知识咨询，严禁调用任何工具，请直接以自然亲切的文本回复。\n"
                        "5. 拒绝推诿：当用户确实提出项目操作需求时，直接调用工具执行，严禁回答'我无法直接访问你的电脑'等推诿话术。"
                    ),
                }
            )

        # 7. 展平选中的 AtomicTurn 消息
        for turn in selected_turns:
            formatted_messages.extend(turn.messages)

        # 8. 追加当前轮次用户新提问 (如果历史库中尚未包含)
        if not formatted_messages or formatted_messages[-1] != {"role": "user", "content": new_prompt}:
            formatted_messages.append({"role": "user", "content": new_prompt})

        # 9. 待办任务状态机置顶保护：若当前会话存在未完成的 todos，自动在末尾消息附带最新快照
        todo_snapshot = todo_manager.format_todo_snapshot(str(session_id))
        if todo_snapshot and formatted_messages:
            last_msg = formatted_messages[-1]
            last_content = last_msg.get("content")
            if isinstance(last_content, str):
                if "【待办任务状态机快照 (Todo State)】" not in last_content:
                    last_msg["content"] = f"{last_content}\n\n{todo_snapshot}"
            elif isinstance(last_content, list):
                last_content.append({"type": "text", "text": f"\n\n{todo_snapshot}"})

        return formatted_messages


# 单例
context_manager = ContextManager()

