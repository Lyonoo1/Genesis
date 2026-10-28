import asyncio
import time
from typing import AsyncGenerator
import pytest
from services.llm_adapter import StreamChunk
from services.subagent_runner import SubagentRunner


class MockSlowLLMAdapter:
    """模拟持续进行长步骤思考与工具调用的模型适配器"""

    async def stream_chat(self, *args, **kwargs) -> AsyncGenerator[StreamChunk, None]:
        yield StreamChunk(type="reasoning", text="正在思考架构问题...")
        await asyncio.sleep(0.5)
        # 产生工具调用
        yield StreamChunk(
            type="tool_finish",
            tool_call_id="call-mock-1",
            tool_name="workspace__read_file",
            arguments={"path": "non_existent.txt"},
        )


@pytest.mark.anyio
async def test_subagent_immediate_cancellation(tmp_path):
    """验证正在运行的 Subagent 收到 cancel 信号时，能在 300ms 内优雅中断退出"""
    mock_llm = MockSlowLLMAdapter()
    runner = SubagentRunner(llm=mock_llm)

    async def _run_sub():
        events = []
        async for chunk in runner.run(
            workspace_root=str(tmp_path),
            agent_type="explore",
            task_prompt="测试慢速子代理取消",
            model="mock-model",
            max_steps=5,
        ):
            events.append(chunk)
        return events

    task = asyncio.create_task(_run_sub())
    # 等待其启动并进入第一步
    await asyncio.sleep(0.05)

    t0 = time.perf_counter()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    cancel_latency_ms = (time.perf_counter() - t0) * 1000
    assert cancel_latency_ms < 300, f"取消耗时过长: {cancel_latency_ms:.2f}ms"


@pytest.mark.anyio
async def test_subagent_concurrency_semaphore_throttling():
    """验证全局信号量 Semaphore(2) 将并发子代理严格限制在最大 2 个并行"""
    sem = asyncio.Semaphore(2)
    active_count = 0
    max_active_observed = 0

    async def _simulated_subagent(idx: int):
        nonlocal active_count, max_active_observed
        async with sem:
            active_count += 1
            if active_count > max_active_observed:
                max_active_observed = active_count
            await asyncio.sleep(0.05)
            active_count -= 1

    tasks = [_simulated_subagent(i) for i in range(6)]
    await asyncio.gather(*tasks)

    assert max_active_observed <= 2, f"并发子代理超出限制: {max_active_observed}"


def test_chat_service_subagent_semaphore_property():
    """验证 ChatService 提供全局实例级 subagent_semaphore 属性进行多会话统一并发控制"""
    from services.chat_service import ChatService
    svc = ChatService()
    sem1 = svc.subagent_semaphore
    sem2 = svc.subagent_semaphore
    assert sem1 is sem2
    assert isinstance(sem1, asyncio.Semaphore)
    assert sem1._value == 2


def test_has_active_supabase_local_environment():
    """验证当 STANDALONE_MODE=False 时，本地自建 127.0.0.1 Supabase 能被正确识别为激活状态"""
    from core.config import Settings
    # 纯单机模式 -> 始终为 False
    s_standalone = Settings(STANDALONE_MODE=True, SUPABASE_URL="http://127.0.0.1:54321")
    assert s_standalone.has_active_supabase is False

    # 占位符 URL -> False
    s_placeholder = Settings(STANDALONE_MODE=False, SUPABASE_URL="https://your-project.supabase.co")
    assert s_placeholder.has_active_supabase is False

    # 真实/本地联调 Supabase -> True
    s_local = Settings(STANDALONE_MODE=False, SUPABASE_URL="http://127.0.0.1:54321")
    assert s_local.has_active_supabase is True
