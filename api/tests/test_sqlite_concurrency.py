import asyncio
import uuid
import pytest
from core.sqlite_db import (
    init_sqlite_db,
    get_db_connection,
    db_create_message,
    db_list_messages,
    db_upsert_session,
)


@pytest.mark.anyio
async def test_concurrent_sqlite_writes_and_reads():
    """验证多协程并发写入与读取时，无锁死（database is locked）且连接安全闭环"""
    init_sqlite_db()
    session_id = f"test-sess-{uuid.uuid4().hex[:8]}"
    user_id = f"test-user-{uuid.uuid4().hex[:8]}"

    # 初始化会话
    db_upsert_session({
        "id": session_id,
        "user_id": user_id,
        "title": "并发压测会话",
    })

    concurrency_count = 50

    async def _write_message(idx: int):
        await asyncio.sleep(0.001 * (idx % 5))
        # 同步写入在协程中运行
        msg_data = {
            "id": f"msg-{idx}-{uuid.uuid4().hex[:8]}",
            "session_id": session_id,
            "user_id": user_id,
            "role": "user" if idx % 2 == 0 else "assistant",
            "content": f"并发测试内容 {idx}",
        }
        return await asyncio.to_thread(db_create_message, msg_data)

    async def _read_messages(idx: int):
        await asyncio.sleep(0.002 * (idx % 3))
        return await asyncio.to_thread(db_list_messages, session_id, user_id, limit=20)

    # 并发执行 50 个写入和 30 个读取任务
    tasks = [_write_message(i) for i in range(concurrency_count)]
    tasks.extend([_read_messages(i) for i in range(30)])

    results = await asyncio.gather(*tasks, return_exceptions=True)

    # 检查是否有异常（特别是不允许出现 database is locked）
    exceptions = [r for r in results if isinstance(r, Exception)]
    assert len(exceptions) == 0, f"并发读写出现异常: {exceptions}"

    # 验证最终读取的消息数量
    msgs, _, _ = db_list_messages(session_id, user_id, limit=100)
    assert len(msgs) == concurrency_count


def test_connection_context_manager_closes_connection():
    """验证 get_db_connection() 上下文管理器退出时连接已被显式 close()"""
    saved_conn = None
    with get_db_connection() as conn:
        saved_conn = conn
        cursor = conn.cursor()
        cursor.execute("SELECT 1")
        assert cursor.fetchone()[0] == 1

    # 退出上下文管理器后，尝试在原连接执行查询必须抛出异常（证明连接已被关闭）
    with pytest.raises(Exception) as exc_info:
        saved_conn.execute("SELECT 1")
    assert "closed database" in str(exc_info.value).lower() or "cannot operate on a closed database" in str(exc_info.value).lower()
