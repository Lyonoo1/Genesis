import hashlib
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from core.sqlite_db import get_db_connection


def compute_workspace_key(workspace_root: Optional[str]) -> tuple[str, str]:
    """将工作区根目录归一化为 sha256 key 与可读目录名。

    macOS / Windows 文件系统默认大小写不敏感，统一转小写后再哈希。
    """
    raw = str(workspace_root or "").strip()
    if not raw:
        return "", ""
    if raw.startswith("bridge://"):
        normalized = raw
        label = raw.rstrip("/").split("/")[-1] or raw
    else:
        try:
            real = os.path.realpath(raw)
        except Exception:
            real = raw
        label = Path(real).name or real
        normalized = real.lower() if sys.platform in ("darwin", "win32") else real
    ws_key = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return ws_key, label


class PermissionRuleRepository:
    """工作区级权限规则持久化仓储（SQLite/PG 标准 SQL 兼容，先查后插无 PG 专有语法）。"""

    def list_sync(
        self,
        user_id: str,
        workspace_key: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            if workspace_key:
                cursor.execute(
                    """
                    SELECT id, user_id, workspace_key, workspace_label,
                           scope_signature, created_from_session, created_at, last_used_at
                    FROM permission_rules
                    WHERE user_id = ? AND workspace_key = ?
                    ORDER BY created_at DESC
                    """,
                    (str(user_id), str(workspace_key)),
                )
            else:
                cursor.execute(
                    """
                    SELECT id, user_id, workspace_key, workspace_label,
                           scope_signature, created_from_session, created_at, last_used_at
                    FROM permission_rules
                    WHERE user_id = ?
                    ORDER BY workspace_label ASC, created_at DESC
                    """,
                    (str(user_id),),
                )
            return [dict(row) for row in cursor.fetchall()]

    async def list(
        self,
        user_id: str,
        workspace_key: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        return self.list_sync(user_id, workspace_key)

    def add_sync(
        self,
        user_id: str,
        workspace_key: str,
        label: str,
        sig: str,
        session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        with get_db_connection() as conn:
            cursor = conn.cursor()
            # 先查后插（兼容 SQLite 与 PostgreSQL，避免 ON CONFLICT 差异）
            cursor.execute(
                """
                SELECT id, user_id, workspace_key, workspace_label,
                       scope_signature, created_from_session, created_at, last_used_at
                FROM permission_rules
                WHERE user_id = ? AND workspace_key = ? AND scope_signature = ?
                """,
                (str(user_id), str(workspace_key), str(sig)),
            )
            existing = cursor.fetchone()
            if existing:
                cursor.execute(
                    "UPDATE permission_rules SET last_used_at = ?, workspace_label = ? WHERE id = ?",
                    (now, label or existing["workspace_label"], existing["id"]),
                )
                conn.commit()
                res = dict(existing)
                res["last_used_at"] = now
                return res

            rule_id = f"pr_{uuid.uuid4().hex[:16]}"
            try:
                cursor.execute(
                    """
                    INSERT INTO permission_rules (
                        id, user_id, workspace_key, workspace_label,
                        scope_signature, created_from_session, created_at, last_used_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rule_id,
                        str(user_id),
                        str(workspace_key),
                        label or "",
                        str(sig),
                        str(session_id) if session_id else None,
                        now,
                        now,
                    ),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                cursor.execute(
                    """
                    SELECT id, user_id, workspace_key, workspace_label,
                           scope_signature, created_from_session, created_at, last_used_at
                    FROM permission_rules
                    WHERE user_id = ? AND workspace_key = ? AND scope_signature = ?
                    """,
                    (str(user_id), str(workspace_key), str(sig)),
                )
                row = cursor.fetchone()
                if row:
                    return dict(row)
                raise

            return {
                "id": rule_id,
                "user_id": str(user_id),
                "workspace_key": str(workspace_key),
                "workspace_label": label or "",
                "scope_signature": str(sig),
                "created_from_session": str(session_id) if session_id else None,
                "created_at": now,
                "last_used_at": now,
            }

    async def add(
        self,
        user_id: str,
        workspace_key: str,
        label: str,
        sig: str,
        session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        return self.add_sync(user_id, workspace_key, label, sig, session_id)

    def delete_sync(self, user_id: str, rule_id: str) -> Optional[str]:
        """删除单条规则，返回被删规则所属的 workspace_key（用于刷新缓存）。"""
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT workspace_key FROM permission_rules WHERE id = ? AND user_id = ?",
                (str(rule_id), str(user_id)),
            )
            row = cursor.fetchone()
            if not row:
                return None
            ws_key = str(row["workspace_key"])
            cursor.execute(
                "DELETE FROM permission_rules WHERE id = ? AND user_id = ?",
                (str(rule_id), str(user_id)),
            )
            conn.commit()
            return ws_key

    async def delete(self, user_id: str, rule_id: str) -> Optional[str]:
        return self.delete_sync(user_id, rule_id)

    def delete_by_workspace_sync(
        self,
        user_id: str,
        workspace_key: Optional[str] = None,
    ) -> int:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            if workspace_key:
                cursor.execute(
                    "DELETE FROM permission_rules WHERE user_id = ? AND workspace_key = ?",
                    (str(user_id), str(workspace_key)),
                )
            else:
                cursor.execute(
                    "DELETE FROM permission_rules WHERE user_id = ?",
                    (str(user_id),),
                )
            conn.commit()
            return cursor.rowcount

    async def delete_by_workspace(
        self,
        user_id: str,
        workspace_key: Optional[str] = None,
    ) -> int:
        return self.delete_by_workspace_sync(user_id, workspace_key)

    def touch_sync(self, user_id: str, workspace_key: str, sig: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE permission_rules
                SET last_used_at = ?
                WHERE user_id = ? AND workspace_key = ? AND scope_signature = ?
                """,
                (now, str(user_id), str(workspace_key), str(sig)),
            )
            conn.commit()


permission_rule_repository = PermissionRuleRepository()
