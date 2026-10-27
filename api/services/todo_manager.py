import json
import logging
from typing import Any, Optional

logger = logging.getLogger("genesis.todo_manager")


class TodoManager:
    """会话任务状态机管理器：维护会话级 todos 列表并提供格式化快照"""

    _session_todos: dict[str, list[dict[str, Any]]] = {}

    @classmethod
    def set_todos(cls, session_id: str, todos: Any) -> None:
        """更新并暂存会话最新 Todo 列表"""
        if isinstance(todos, str):
            try:
                todos = json.loads(todos)
            except Exception:
                todos = []
        if not isinstance(todos, list):
            todos = []

        valid_todos: list[dict[str, Any]] = []
        for idx, item in enumerate(todos):
            if isinstance(item, dict):
                content = (
                    item.get("content")
                    or item.get("task")
                    or item.get("title")
                    or item.get("text")
                    or ""
                )
                if not str(content).strip():
                    continue
                todo_id = str(item.get("id") or f"todo-{idx + 1}")
                status = item.get("status", "pending")
                if status not in ("pending", "in_progress", "completed"):
                    status = "pending"
                valid_todos.append(
                    {
                        "id": todo_id,
                        "content": str(content).strip(),
                        "status": status,
                    }
                )
            elif isinstance(item, str) and item.strip():
                valid_todos.append(
                    {
                        "id": f"todo-{idx + 1}",
                        "content": item.strip(),
                        "status": "pending",
                    }
                )
        cls._session_todos[str(session_id)] = valid_todos
        logger.info("会话 [%s] 更新待办任务状态机，共 %d 项", session_id, len(valid_todos))

    @classmethod
    def get_todos(cls, session_id: str) -> list[dict[str, Any]]:
        """获取指定会话当前的 Todo 列表，支持从数据库自动恢复"""
        sid = str(session_id)
        if sid not in cls._session_todos:
            try:
                from core.sqlite_db import get_db_connection
                with get_db_connection() as conn:
                    cursor = conn.cursor()
                    cursor.execute(
                        "SELECT raw_tool_calls FROM messages WHERE session_id = ? AND raw_tool_calls LIKE '%todo_write%' ORDER BY created_at DESC LIMIT 1",
                        (sid,),
                    )
                    row = cursor.fetchone()
                    if row and row[0]:
                        calls = json.loads(row[0]) if isinstance(row[0], str) else row[0]
                        for c in calls:
                            fn_name = c.get("name") or (c.get("function") or {}).get("name")
                            if fn_name in ("workspace__todo_write", "todo_write"):
                                args = c.get("args") or c.get("arguments") or (c.get("function") or {}).get("arguments") or {}
                                if isinstance(args, str):
                                    try:
                                        args = json.loads(args)
                                    except Exception:
                                        pass
                                if isinstance(args, list):
                                    cls.set_todos(sid, args)
                                elif isinstance(args, dict):
                                    cls.set_todos(sid, args.get("todos", []))
                                break
            except Exception as e:
                logger.debug("从 SQLite 恢复会话 [%s] todos 异常: %s", sid, e)
        return list(cls._session_todos.get(sid, []))

    @classmethod
    def clear_todos(cls, session_id: str) -> None:
        cls._session_todos.pop(str(session_id), None)

    @classmethod
    def has_unfinished_todos(cls, session_id: str) -> bool:
        todos = cls.get_todos(session_id)
        return any(t.get("status") in ("pending", "in_progress") for t in todos)

    @classmethod
    def format_todo_snapshot(cls, session_id: str) -> Optional[str]:
        """生成 Markdown 格式的待办状态快照，用于注入模型上下文"""
        todos = cls.get_todos(session_id)
        if not todos:
            return None

        # 仅当存在未完成项时，强制附带快照置顶
        has_pending = any(t.get("status") in ("pending", "in_progress") for t in todos)
        if not has_pending:
            return None

        lines = [
            "【待办任务状态机快照 (Todo State)】",
            "请根据以下任务列表按序推进，及时通过 workspace__todo_write 更新状态：",
        ]
        for t in todos:
            status = t.get("status", "pending")
            if status == "completed":
                icon = "[x] (已完成)"
            elif status == "in_progress":
                icon = "[▶] (进行中)"
            else:
                icon = "[ ] (待开始)"
            lines.append(f"- {icon} [{t.get('id')}]: {t.get('content')}")

        return "\n".join(lines)


# 全局单例
todo_manager = TodoManager()
