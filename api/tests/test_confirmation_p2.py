import asyncio
import os
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from core.sqlite_db import init_sqlite_db
from repositories.permission_rule_repository import (
    compute_workspace_key,
    permission_rule_repository,
)
from services.chat_service import ChatService
from services.permission_manager import (
    PermissionDecision,
    PermissionManager,
    PermissionMode,
    build_scope_signature,
    permission_manager,
)
from services.session_event_bus import SessionEventBus, session_event_bus
from models.schemas.chat import ChatRequest


def test_session_event_bus_subscribe_publish_full_and_unsubscribe():
    bus = SessionEventBus()
    q = bus.subscribe("s1")
    assert bus.subscriber_count("s1") == 1

    bus.publish("s1", "confirmation_required", {"request_id": "r1"})
    ev, data = q.get_nowait()
    assert ev == "confirmation_required"
    assert data["request_id"] == "r1"

    # 填满队列后再发布，不应抛异常
    for i in range(300):
        bus.publish("s1", "ping", {"i": i})
    assert q.full()

    bus.unsubscribe("s1", q)
    assert bus.subscriber_count("s1") == 0


@pytest.mark.anyio
async def test_permission_manager_snapshot_and_bus_events():
    sid = "sess_p2_snap"
    q = session_event_bus.subscribe(sid)
    try:
        env = {
            "request_id": "cf_snap_1",
            "session_id": sid,
            "kind": "tool_approval",
            "items": [{"item_id": "tc1", "title": "Run test", "selection_mode": "approval"}],
        }
        fut = permission_manager.register(
            sid,
            "cf_snap_1",
            expected_scope_signature="bash:npm test",
            envelope=env,
        )
        assert len(permission_manager.snapshot(sid)) == 1
        assert permission_manager.snapshot(sid)[0]["request_id"] == "cf_snap_1"

        ev1, data1 = q.get_nowait()
        assert ev1 == "confirmation_required"
        assert data1["request_id"] == "cf_snap_1"

        ok = permission_manager.resolve(
            sid,
            "cf_snap_1",
            {
                "request_id": "cf_snap_1",
                "kind": "tool_approval",
                "decision": "approved",
                "permission_scope": "session",
                "scope_signature": "bash:npm test",
            },
        )
        assert ok is True
        assert (await fut)["decision"] == "approved"
        assert permission_manager.snapshot(sid) == []

        events = []
        while not q.empty():
            events.append(q.get_nowait())
        event_names = [e[0] for e in events]
        assert "confirmation_resolved" in event_names
        assert "grants_changed" in event_names
    finally:
        session_event_bus.unsubscribe(sid, q)
        permission_manager.cleanup_session(sid)


@pytest.mark.anyio
async def test_workspace_permission_rules_persistence_and_priority(monkeypatch, tmp_path):
    db_file = tmp_path / "p2_rules.db"
    monkeypatch.setenv("SQLITE_DB_PATH", str(db_file))
    init_sqlite_db()

    ws_a = str(tmp_path / "ws_a")
    ws_b = str(tmp_path / "ws_b")
    os.makedirs(ws_a, exist_ok=True)
    os.makedirs(ws_b, exist_ok=True)

    user_id = "user_p2_rules"
    pm = PermissionManager()

    # 1. 通过 resolve 授予 workspace_rule（medium 风险，签名一致）
    fut = pm.register(
        "sess_1",
        "cf_ws_1",
        expected_scope_signature="bash:npm test",
        user_id=user_id,
        workspace_root=ws_a,
        risk_level="medium",
    )
    pm.resolve(
        "sess_1",
        "cf_ws_1",
        {
            "request_id": "cf_ws_1",
            "kind": "tool_approval",
            "decision": "approved",
            "permission_scope": "workspace_rule",
            "scope_signature": "bash:npm test",
        },
    )
    res = await fut
    assert res["permission_scope"] == "workspace_rule"

    # 2. 新会话在同工作区命中工作区规则；换工作区不命中
    assert pm.is_allowed(user_id, "sess_new", ws_a, "bash:npm test") is True
    assert pm.is_allowed(user_id, "sess_new", ws_b, "bash:npm test") is False

    # 3. 模拟重启：全新 PermissionManager 实例仍能从 DB 命中
    pm2 = PermissionManager()
    assert pm2.is_allowed(user_id, "sess_after_restart", ws_a, "bash:npm test") is True

    # 4. DENY_LIST / 删除 / .env 始终不受工作区规则影响（sig 为 None 或 DENY）
    d_deny, _ = pm2.evaluate("workspace__execute_command", {"command": "rm -rf /"}, workspace_root=ws_a)
    assert d_deny == PermissionDecision.DENY
    assert build_scope_signature("workspace__delete_file", {"path": "a.txt"}, workspace_root=ws_a) is None
    assert build_scope_signature("workspace__write_file", {"path": ".env", "content": "x"}, workspace_root=ws_a) is None

    # 5. high 风险禁止写入 workspace_rule，自动降级为 once
    fut_high = pm2.register(
        "sess_2",
        "cf_ws_high",
        expected_scope_signature="bash:git push",
        user_id=user_id,
        workspace_root=ws_a,
        risk_level="high",
    )
    pm2.resolve(
        "sess_2",
        "cf_ws_high",
        {
            "request_id": "cf_ws_high",
            "kind": "tool_approval",
            "decision": "approved",
            "permission_scope": "workspace_rule",
            "scope_signature": "bash:git push",
        },
    )
    res_high = await fut_high
    assert res_high["permission_scope"] == "once"
    assert pm2.is_allowed(user_id, "sess_3", ws_a, "bash:git push") is False

    # 6. 删除规则并失效缓存后，重新不再放行
    ws_key_a, _ = compute_workspace_key(ws_a)
    rules = await permission_rule_repository.list(user_id, ws_key_a)
    assert len(rules) == 1
    await permission_rule_repository.delete(user_id, rules[0]["id"])
    pm2.invalidate_workspace_cache(user_id, ws_key_a)
    assert pm2.is_allowed(user_id, "sess_4", ws_a, "bash:npm test") is False


@pytest.mark.anyio
async def test_batch_approval_prescan_and_same_file_fallback(monkeypatch, tmp_path):
    """验证 P2-4 后端预扫描合批：
    1. 一步 2 个不同文件写操作（review_all 模式）合并为 1 张 batch_approval，批准第 1 个、拒绝第 2 个；
    2. 一步 2 个修改同一文件的写操作退化为逐个 tool_approval。
    """
    db_file = tmp_path / "p2_batch.db"
    monkeypatch.setenv("SQLITE_DB_PATH", str(db_file))
    init_sqlite_db()

    from services.llm_adapter import StreamChunk
    from tests.test_confirmation_protocol import _make_fake_ctx

    async def run_scenario(session_id: str, step1_tcs: list[dict], resolver):
        class _FakeBatchLLM:
            def __init__(self):
                self.calls = 0

            async def stream_chat(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    for tc in step1_tcs:
                        yield StreamChunk(
                            type="tool_start",
                            tool_call_id=tc["id"],
                            tool_name=tc["name"],
                        )
                        yield StreamChunk(
                            type="tool_finish",
                            tool_call_id=tc["id"],
                            tool_name=tc["name"],
                            arguments=tc["arguments"],
                        )
                    yield StreamChunk(type="finish", finish_reason="tool_calls")
                else:
                    yield StreamChunk(type="text", text="done")
                    yield StreamChunk(type="finish", finish_reason="stop")

        fake_msg_repo = AsyncMock()
        fake_msg_repo.create = AsyncMock(return_value={"id": "m1"})
        fake_msg_repo.update_metrics = AsyncMock()
        fake_session_repo = AsyncMock()
        fake_session_repo.get_by_id = AsyncMock(return_value={"id": session_id, "title": "t"})
        fake_ctx = _make_fake_ctx([{"role": "user", "content": "do batch"}])

        svc = ChatService(
            message_repo=fake_msg_repo,
            session_repo=fake_session_repo,
            skill_repo=AsyncMock(list_by_user=AsyncMock(return_value=[])),
            mcp_repo=AsyncMock(list_by_user=AsyncMock(return_value=[])),
            project_repo=AsyncMock(),
            llm=_FakeBatchLLM(),
            ctx_mgr=fake_ctx,
        )
        svc.resolve_workspace_root = AsyncMock(return_value=str(tmp_path))

        req = ChatRequest(
            content="do batch",
            model="gpt-4o",
            permission_mode=PermissionMode.REVIEW_ALL,
            allow_ask_user=False,
        )
        seen_required = []
        gen = svc.handle_stream(session_id=session_id, req=req, user_id="u_batch")

        async for chunk in gen:
            if "event: confirmation_required" in chunk:
                import json

                for line in chunk.splitlines():
                    if line.startswith("data:"):
                        payload = json.loads(line[5:].strip())
                        seen_required.append(payload)
                        resolver(session_id, payload)
        return seen_required

    # 场景 1：两个不同文件 -> 合并为 1 个 batch_approval
    seen1 = await run_scenario(
        "sess_batch_ok",
        [
            {"id": "tc_a", "name": "workspace__write_file", "arguments": {"path": "a.txt", "content": "AAA"}},
            {"id": "tc_b", "name": "workspace__write_file", "arguments": {"path": "b.txt", "content": "BBB"}},
        ],
        lambda sid, p: permission_manager.resolve(
            sid,
            p["request_id"],
            {
                "request_id": p["request_id"],
                "kind": "batch_approval",
                "decision": "submitted",
                "item_decisions": {
                    p["items"][0]["item_id"]: {"decision": "approved", "permission_scope": "once"},
                    # 第 2 项故意缺失 -> 后端按 rejected 处理
                },
            },
        ),
    )
    assert len(seen1) == 1
    assert seen1[0]["kind"] == "batch_approval"
    assert len(seen1[0]["items"]) == 2
    assert (tmp_path / "a.txt").exists()
    assert not (tmp_path / "b.txt").exists()
    permission_manager.cleanup_session("sess_batch_ok")

    # 场景 2：两个工具改同一文件 -> 退化为 2 个独立 tool_approval
    seen2 = await run_scenario(
        "sess_batch_samefile",
        [
            {"id": "tc_s1", "name": "workspace__write_file", "arguments": {"path": "same.txt", "content": "111"}},
            {"id": "tc_s2", "name": "workspace__write_file", "arguments": {"path": "same.txt", "content": "222"}},
        ],
        lambda sid, p: permission_manager.resolve(
            sid,
            p["request_id"],
            {
                "request_id": p["request_id"],
                "kind": "tool_approval",
                "decision": "approved",
                "permission_scope": "once",
            },
        ),
    )
    assert len(seen2) == 2
    assert all(ev["kind"] == "tool_approval" for ev in seen2)
    assert (tmp_path / "same.txt").read_text(encoding="utf-8") == "222"
    permission_manager.cleanup_session("sess_batch_samefile")
