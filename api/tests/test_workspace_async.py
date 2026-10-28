import asyncio
import os
import shutil
import tempfile
import time
from pathlib import Path
import pytest
from services.workspace_tool_executor import WorkspaceToolExecutor


@pytest.fixture
def temp_workspace():
    tmp_dir = tempfile.mkdtemp(prefix="test_genesis_ws_")
    root = Path(tmp_dir)

    # 构造测试目录结构：包含正常代码目录与需排除的黑名单目录
    (root / "src").mkdir()
    (root / "src" / "index.ts").write_text("console.log('hello world');\nconst targetVar = 42;", encoding="utf-8")
    (root / "src" / "deep").mkdir()
    (root / "src" / "deep" / "nested.py").write_text("# targetVar found here\ndef run(): pass", encoding="utf-8")

    # 构造黑名单目录
    (root / "node_modules").mkdir()
    (root / "node_modules" / "pkg.js").write_text("targetVar = 999", encoding="utf-8")
    (root / ".turbo").mkdir()
    (root / ".turbo" / "cache.txt").write_text("targetVar in cache", encoding="utf-8")
    (root / ".cache").mkdir()
    (root / ".cache" / "dummy.txt").write_text("targetVar in dot cache", encoding="utf-8")

    yield tmp_dir
    shutil.rmtree(tmp_dir, ignore_errors=True)


def test_grep_search_excludes_blacklisted_dirs(temp_workspace):
    """验证 grep_search 正确跳过新增的 .turbo, .cache 等黑名单目录"""
    res = WorkspaceToolExecutor.grep_search(
        workspace_root=temp_workspace,
        query="targetVar",
        path=".",
    )
    assert res["success"] is True
    matched_files = [m["file"] for m in res["matches"]]
    # 命中 src 下文件
    assert any("src/index.ts" in f or "src/deep/nested.py" in f for f in matched_files)
    # 严禁命中 node_modules, .turbo, .cache
    for f in matched_files:
        assert "node_modules" not in f
        assert ".turbo" not in f
        assert ".cache" not in f


def test_find_by_name_excludes_blacklisted_dirs(temp_workspace):
    """验证 find_by_name 跳过黑名单目录"""
    res = WorkspaceToolExecutor.find_by_name(
        workspace_root=temp_workspace,
        pattern="*.txt",
        path=".",
    )
    assert res["success"] is True
    matched_files = [m["path"] for m in res["matches"]]
    for f in matched_files:
        assert ".turbo" not in f
        assert ".cache" not in f


@pytest.mark.anyio
async def test_async_thread_offload_keeps_event_loop_fluid(temp_workspace):
    """验证将检索投递至 asyncio.to_thread 时，主事件循环的心跳不会被阻塞挂死"""
    max_heartbeat_gap = 0.0
    stop_heartbeat = False

    async def heartbeat_worker():
        nonlocal max_heartbeat_gap, stop_heartbeat
        last_t = time.perf_counter()
        while not stop_heartbeat:
            await asyncio.sleep(0.01)
            now = time.perf_counter()
            gap = now - last_t
            if gap > max_heartbeat_gap:
                max_heartbeat_gap = gap
            last_t = now

    hb_task = asyncio.create_task(heartbeat_worker())

    # 在后台线程并发运行多组 grep_search
    async def run_grep():
        return await asyncio.wait_for(
            asyncio.to_thread(
                WorkspaceToolExecutor.grep_search,
                workspace_root=temp_workspace,
                query="targetVar",
                path=".",
            ),
            timeout=5.0,
        )

    results = await asyncio.gather(*[run_grep() for _ in range(10)])
    stop_heartbeat = True
    await hb_task

    assert all(r["success"] is True for r in results)
    # 心跳间隔不应超过 150ms（若为主线程同步阻塞会远超 200ms）
    assert max_heartbeat_gap < 0.20, f"事件循环发生严重卡顿，心跳最大间隔: {max_heartbeat_gap:.3f}s"
