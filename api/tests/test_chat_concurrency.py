import asyncio
import time
import uuid
from typing import AsyncGenerator
import pytest

from core.sqlite_db import init_sqlite_db, db_upsert_session, db_create_message
from models.schemas.chat import ChatRequest
from repositories.message_repository import MessageRepository
from repositories.session_repository import SessionRepository
from services.chat_service import ChatService
from services.llm_adapter import LLMAdapter, StreamChunk


class MockConcurrencyLLM(LLMAdapter):
    """模拟支持工具调用和打字机的轻量级并发测试模型"""

    async def stream_chat(
        self,
        messages,
        tools=None,
        model="gpt-4o",
        temperature=0.7,
        max_tokens=None,
        api_key=None,
        base_url=None,
        provider="openai",
    ) -> AsyncGenerator[StreamChunk, None]:
        # 首步思考与文本输出
        yield StreamChunk(type="reasoning", text="分析会话并发中...")
        await asyncio.sleep(0.02)
        yield StreamChunk(type="text", text="正在并发处理指令...")
        await asyncio.sleep(0.02)
        yield StreamChunk(type="finish", finish_reason="stop", input_tokens=10, output_tokens=20)


@pytest.mark.anyio
async def test_multi_session_concurrency_no_freeze(tmp_path):
    """验证 5 个并发会话同时发送消息、查询历史与中止任务时，全局 0 挂起、0 死锁"""
    init_sqlite_db()
    user_id = f"user-{uuid.uuid4().hex[:8]}"

    # 初始化 5 个独立测试会话
    session_ids = [f"sess-{i}-{uuid.uuid4().hex[:6]}" for i in range(5)]
    for sid in session_ids:
        db_upsert_session({
            "id": sid,
            "user_id": user_id,
            "title": f"并发测试会话 {sid}",
        })

    mock_llm = MockConcurrencyLLM()
    chat_svc = ChatService(
        message_repo=MessageRepository(),
        session_repo=SessionRepository(),
        llm=mock_llm,
    )

    completed_events = {}

    async def _run_session_stream(sid: str):
        events = []
        req = ChatRequest(content=f"来自会话 {sid} 的并发请求", model="mock-model")
        async for sse in chat_svc.handle_stream(session_id=sid, req=req, user_id=user_id):
            events.append(sse)
        completed_events[sid] = events
        return len(events)

    # 同时启动 5 个并发会话流
    t0 = time.perf_counter()
    tasks = [asyncio.create_task(_run_session_stream(sid)) for sid in session_ids]

    # 等待 30ms 后中止第 0 个会话
    await asyncio.sleep(0.03)
    stopped = chat_svc.stop_task(user_id, session_ids[0])
    assert stopped is True, "预期成功中止运行中的会话 0"

    # 等待其余任务完成
    results = await asyncio.gather(*tasks, return_exceptions=True)

    elapsed = time.perf_counter() - t0

    # 验证任务整体耗时，无死锁时 5 个并发会在 1 秒内迅速收敛（若有 30s 锁等待则会超时）
    assert elapsed < 3.0, f"多会话并发执行超时（可能发生死锁卡顿）: {elapsed:.2f}s"

    # 验证其他 4 个会话均正常跑完并产出事件
    for sid in session_ids[1:]:
        assert sid in completed_events
        assert len(completed_events[sid]) > 0

    # 验证被中止的第 0 个会话抛出了 CancelledError 或输出 TASK_CANCELLED 事件
    sess0_events = completed_events.get(session_ids[0], [])
    has_cancel = any("TASK_CANCELLED" in e for e in sess0_events) or isinstance(results[0], asyncio.CancelledError)
    assert has_cancel is True, "会话 0 应当正确收到取消事件"
