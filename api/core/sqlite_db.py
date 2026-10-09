import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

DB_PATH = Path(__file__).resolve().parent.parent / "genesis.db"


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_sqlite_db() -> None:
    """初始化 Genesis 本地持久化 SQLite 数据库体系"""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        # 1. 项目表 (Projects)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                icon TEXT,
                description TEXT,
                is_expanded INTEGER NOT NULL DEFAULT 1,
                is_archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, created_at DESC);"
        )

        # 2. 会话表 (Sessions)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '新对话',
                pinned INTEGER NOT NULL DEFAULT 0,
                is_archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);"
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);"
        )

        # 3. 消息表 (Messages)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                parent_id TEXT,
                role TEXT NOT NULL,
                content TEXT,
                reasoning_content TEXT,
                raw_tool_calls TEXT,
                tool_call_id TEXT,
                active_skill_id TEXT,
                status TEXT NOT NULL DEFAULT 'success',
                created_at TEXT NOT NULL
            );
            """
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at ASC);"
        )

        # 4. 模型配置表 (Model Configs)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS model_configs (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                model_id TEXT NOT NULL,
                provider TEXT NOT NULL DEFAULT 'openai',
                base_url TEXT,
                api_key TEXT,
                is_default INTEGER NOT NULL DEFAULT 0,
                temperature REAL DEFAULT 0.7,
                max_tokens INTEGER DEFAULT 10000,
                context_window INTEGER DEFAULT 1048576,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        try:
            cursor.execute("ALTER TABLE model_configs ADD COLUMN context_window INTEGER DEFAULT 1048576")
        except Exception:
            pass
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_model_configs_user ON model_configs(user_id, updated_at DESC);"
        )
        conn.commit()


# ==============================================================================
# 1. Projects SQLite CRUD
# ==============================================================================
def db_list_projects(user_id: str) -> list[dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC",
            (str(user_id),),
        )
        rows = cursor.fetchall()
        return [
            {
                "id": r["id"],
                "user_id": r["user_id"],
                "name": r["name"],
                "icon": r["icon"],
                "description": r["description"],
                "is_expanded": bool(r["is_expanded"]),
                "is_archived": bool(r["is_archived"]),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]


def db_get_project(user_id: str, project_id: str) -> Optional[dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM projects WHERE id = ? AND user_id = ?",
            (str(project_id), str(user_id)),
        )
        r = cursor.fetchone()
        if not r:
            return None
        return {
            "id": r["id"],
            "user_id": r["user_id"],
            "name": r["name"],
            "icon": r["icon"],
            "description": r["description"],
            "is_expanded": bool(r["is_expanded"]),
            "is_archived": bool(r["is_archived"]),
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        }


def db_upsert_project(data: dict[str, Any]) -> dict[str, Any]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        now = datetime.now(timezone.utc).isoformat()
        cursor.execute(
            """
            INSERT INTO projects (id, user_id, name, icon, description, is_expanded, is_archived, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = coalesce(excluded.name, projects.name),
                icon = coalesce(excluded.icon, projects.icon),
                description = coalesce(excluded.description, projects.description),
                is_expanded = coalesce(excluded.is_expanded, projects.is_expanded),
                is_archived = coalesce(excluded.is_archived, projects.is_archived),
                updated_at = excluded.updated_at
            """,
            (
                str(data["id"]),
                str(data["user_id"]),
                data["name"],
                data.get("icon"),
                data.get("description"),
                1 if data.get("is_expanded", True) else 0,
                1 if data.get("is_archived", False) else 0,
                data.get("created_at") or now,
                data.get("updated_at") or now,
            ),
        )
        conn.commit()
    return db_get_project(data["user_id"], data["id"]) or data


def db_delete_project(user_id: str, project_id: str) -> bool:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM projects WHERE id = ? AND user_id = ?",
            (str(project_id), str(user_id)),
        )
        # 解绑相关会话的 project_id
        cursor.execute(
            "UPDATE sessions SET project_id = NULL WHERE project_id = ? AND user_id = ?",
            (str(project_id), str(user_id)),
        )
        conn.commit()
        return cursor.rowcount > 0


# ==============================================================================
# 2. Sessions SQLite CRUD
# ==============================================================================
def db_list_sessions(user_id: str) -> list[dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM sessions WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC",
            (str(user_id),),
        )
        rows = cursor.fetchall()
        return [
            {
                "id": r["id"],
                "project_id": r["project_id"],
                "user_id": r["user_id"],
                "title": r["title"],
                "pinned": bool(r["pinned"]),
                "is_archived": bool(r["is_archived"]),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]


def db_get_session(user_id: str, session_id: str) -> Optional[dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM sessions WHERE id = ? AND user_id = ?",
            (str(session_id), str(user_id)),
        )
        r = cursor.fetchone()
        if not r:
            return None
        return {
            "id": r["id"],
            "project_id": r["project_id"],
            "user_id": r["user_id"],
            "title": r["title"],
            "pinned": bool(r["pinned"]),
            "is_archived": bool(r["is_archived"]),
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        }


def db_upsert_session(data: dict[str, Any]) -> dict[str, Any]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        now = datetime.now(timezone.utc).isoformat()
        cursor.execute(
            """
            INSERT INTO sessions (id, project_id, user_id, title, pinned, is_archived, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                project_id = coalesce(excluded.project_id, sessions.project_id),
                title = coalesce(excluded.title, sessions.title),
                pinned = coalesce(excluded.pinned, sessions.pinned),
                is_archived = coalesce(excluded.is_archived, sessions.is_archived),
                updated_at = excluded.updated_at
            """,
            (
                str(data["id"]),
                str(data["project_id"]) if data.get("project_id") else None,
                str(data["user_id"]),
                data.get("title") or "新对话",
                1 if data.get("pinned", False) else 0,
                1 if data.get("is_archived", False) else 0,
                data.get("created_at") or now,
                data.get("updated_at") or now,
            ),
        )
        conn.commit()
    return db_get_session(data["user_id"], data["id"]) or data


def db_delete_session(user_id: str, session_id: str) -> bool:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM sessions WHERE id = ? AND user_id = ?",
            (str(session_id), str(user_id)),
        )
        # 联动删除消息
        cursor.execute(
            "DELETE FROM messages WHERE session_id = ? AND user_id = ?",
            (str(session_id), str(user_id)),
        )
        conn.commit()
        return cursor.rowcount > 0


# ==============================================================================
# 3. Messages SQLite CRUD
# ==============================================================================
def db_list_messages(
    session_id: str, user_id: str, limit: int = 50, cursor_time: Optional[str] = None
) -> tuple[list[dict[str, Any]], Optional[str], bool]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        if cursor_time:
            cursor.execute(
                """
                SELECT * FROM messages
                WHERE session_id = ? AND user_id = ? AND created_at < ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (str(session_id), str(user_id), cursor_time, limit + 1),
            )
        else:
            cursor.execute(
                """
                SELECT * FROM messages
                WHERE session_id = ? AND user_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (str(session_id), str(user_id), limit + 1),
            )
        rows = cursor.fetchall()
        has_more = len(rows) > limit
        items = rows[:limit]
        next_cursor = items[-1]["created_at"] if has_more and items else None

        result = []
        for r in items:
            raw_tools = None
            if r["raw_tool_calls"]:
                try:
                    raw_tools = json.loads(r["raw_tool_calls"])
                except Exception:
                    raw_tools = []
            result.append(
                {
                    "id": r["id"],
                    "session_id": r["session_id"],
                    "user_id": r["user_id"],
                    "parent_id": r["parent_id"],
                    "role": r["role"],
                    "content": r["content"],
                    "reasoning_content": r["reasoning_content"],
                    "raw_tool_calls": raw_tools,
                    "tool_call_id": r["tool_call_id"],
                    "active_skill_id": r["active_skill_id"],
                    "status": r["status"],
                    "created_at": r["created_at"],
                }
            )
        result.reverse()  # 返回正序
        return result, next_cursor, has_more


def db_create_message(data: dict[str, Any]) -> dict[str, Any]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        now = datetime.now(timezone.utc).isoformat()
        raw_tools_str = None
        if data.get("raw_tool_calls") is not None:
            raw_tools_str = json.dumps(data["raw_tool_calls"], ensure_ascii=False)

        cursor.execute(
            """
            INSERT INTO messages (id, session_id, user_id, parent_id, role, content,
                                  reasoning_content, raw_tool_calls, tool_call_id,
                                  active_skill_id, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                content = excluded.content,
                reasoning_content = excluded.reasoning_content,
                raw_tool_calls = excluded.raw_tool_calls,
                status = excluded.status
            """,
            (
                str(data["id"]),
                str(data["session_id"]),
                str(data["user_id"]),
                str(data["parent_id"]) if data.get("parent_id") else None,
                data["role"].value if hasattr(data["role"], "value") else str(data["role"]),
                data.get("content"),
                data.get("reasoning_content"),
                raw_tools_str,
                data.get("tool_call_id"),
                str(data["active_skill_id"]) if data.get("active_skill_id") else None,
                data.get("status").value if hasattr(data.get("status"), "value") else str(data.get("status", "success")),
                data.get("created_at") or now,
            ),
        )
        # 联动刷新所属会话的 updated_at
        cursor.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            (data.get("created_at") or now, str(data["session_id"])),
        )
        conn.commit()
        return data


def db_prune_messages(session_id: str, user_id: str, parent_id: str) -> int:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT created_at FROM messages WHERE id = ? AND session_id = ? AND user_id = ?",
            (str(parent_id), str(session_id), str(user_id)),
        )
        parent = cursor.fetchone()
        if not parent:
            return 0
        parent_time = parent["created_at"]
        cursor.execute(
            "DELETE FROM messages WHERE session_id = ? AND user_id = ? AND created_at > ?",
            (str(session_id), str(user_id), parent_time),
        )
        conn.commit()
        return cursor.rowcount


# ==============================================================================
# 4. Model Configs SQLite CRUD
# ==============================================================================
def db_list_models(user_id: str) -> list[dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM model_configs WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC",
            (str(user_id),),
        )
        rows = cursor.fetchall()
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "modelId": r["model_id"],
                "provider": r["provider"],
                "baseUrl": r["base_url"] or "",
                "apiKey": r["api_key"] or "",
                "isDefault": bool(r["is_default"]),
                "temperature": r["temperature"],
                "maxTokens": r["max_tokens"],
                "contextWindow": r["context_window"] if "context_window" in r.keys() and r["context_window"] else 1048576,
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]


def db_upsert_model(user_id: str, data: dict[str, Any]) -> dict[str, Any]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        now = datetime.now(timezone.utc).isoformat()
        mid = str(data["id"])
        is_def = 1 if data.get("isDefault", False) else 0

        # 如果设为默认，取消其它模型的默认标记
        if is_def:
            cursor.execute(
                "UPDATE model_configs SET is_default = 0 WHERE user_id = ?",
                (str(user_id),),
            )

        cursor.execute(
            """
            INSERT INTO model_configs (id, user_id, name, model_id, provider, base_url, api_key, is_default, temperature, max_tokens, context_window, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                model_id = excluded.model_id,
                provider = excluded.provider,
                base_url = excluded.base_url,
                api_key = excluded.api_key,
                is_default = excluded.is_default,
                temperature = excluded.temperature,
                max_tokens = excluded.max_tokens,
                context_window = excluded.context_window,
                updated_at = excluded.updated_at
            """,
            (
                mid,
                str(user_id),
                data["name"],
                data.get("modelId") or data.get("model_id"),
                data.get("provider", "openai"),
                data.get("baseUrl") or data.get("base_url") or "",
                data.get("apiKey") or data.get("api_key") or "",
                is_def,
                float(data.get("temperature", 0.7)),
                int(data.get("maxTokens") or data.get("max_tokens") or 32768),
                int(data.get("contextWindow") or data.get("context_window") or 1048576),
                data.get("created_at") or now,
                data.get("updated_at") or now,
            ),
        )
        conn.commit()

        cursor.execute("SELECT * FROM model_configs WHERE id = ?", (mid,))
        r = cursor.fetchone()
        return {
            "id": r["id"],
            "name": r["name"],
            "modelId": r["model_id"],
            "provider": r["provider"],
            "baseUrl": r["base_url"] or "",
            "apiKey": r["api_key"] or "",
            "isDefault": bool(r["is_default"]),
            "temperature": r["temperature"],
            "maxTokens": r["max_tokens"],
            "contextWindow": r["context_window"] if "context_window" in r.keys() and r["context_window"] else 1048576,
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        }


def db_delete_model(user_id: str, model_id: str) -> bool:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM model_configs WHERE id = ? AND user_id = ?",
            (str(model_id), str(user_id)),
        )
        conn.commit()
        return cursor.rowcount > 0
