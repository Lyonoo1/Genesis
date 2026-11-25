import asyncio
import os
import sys
import tempfile
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from core.security import AuthenticatedUser, get_current_user
from core.sqlite_db import (
    db_get_agent_goal,
    db_get_file_snapshot,
    init_sqlite_db,
)
from main import app
from services.agent_state_machine import AgentLifecycleState, AgentRunMode, AgentStateMachine
from services.context_compiler import workspace_dirty_tracker
from services.pty_tool_bridge import exec_command, write_stdin
from services.terminal_manager import TerminalManager
from services.workspace_tool_executor import WorkspaceToolExecutor


def dummy_auth_user():
    return AuthenticatedUser(
        user_id="00000000-0000-0000-0000-000000000001",
        email="developer@genesis.local",
    )


@pytest.fixture(autouse=True)
def setup_test_env():
    init_sqlite_db()
    yield
    TerminalManager.get_instance().cleanup_all()


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = dummy_auth_user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def temp_ws(tmp_path):
    ws = tmp_path / "ws_batch3"
    ws.mkdir(parents=True, exist_ok=True)
    return str(ws)


# ==============================================================================
# 1. read_file 行号探针与 offset/limit 分页及向后兼容测试
# ==============================================================================
def test_read_file_offset_limit_and_numbering(temp_ws):
    """测试 read_file 带 offset/limit 分页、严格行号格式及向下兼容字段"""
    lines = [f"line {i}: def func_{i}(): pass" for i in range(1, 101)]
    file_path = Path(temp_ws) / "demo.py"
    file_path.write_text("\n".join(lines), encoding="utf-8")

    # 1. 分页读取 lines 1-50
    res1 = WorkspaceToolExecutor.read_file(temp_ws, "demo.py", offset=1, limit=50)
    assert res1["success"] is True
    assert res1["start_line"] == 1
    assert res1["end_line"] == 50
    assert res1["total_lines"] == 100
    assert res1["has_more"] is True
    assert "sha256" in res1

    # 严格校验行号格式: `  42 | line 42: def func_42(): pass`
    numbered = res1["numbered_content"].splitlines()
    assert len(numbered) == 50
    assert numbered[0] == "   1 | line 1: def func_1(): pass"
    assert numbered[41] == "  42 | line 42: def func_42(): pass"
    assert "[Showing lines 1-50 of 100. Call read_file with offset=51 to read more]" in res1["pagination_hint"]

    # 2. 读取下一页 lines 51-100
    res2 = WorkspaceToolExecutor.read_file(temp_ws, "demo.py", offset=51, limit=50)
    assert res2["success"] is True
    assert res2["start_line"] == 51
    assert res2["end_line"] == 100
    assert res2["has_more"] is False
    assert "[Showing lines 51-100 of 100. End of file]" in res2["pagination_hint"]

    # 3. 越界 offset 测试
    res_oob = WorkspaceToolExecutor.read_file(temp_ws, "demo.py", offset=200, limit=50)
    assert res_oob["success"] is True
    assert res_oob["start_line"] == 200
    assert res_oob["has_more"] is False
    assert res_oob["content"] == ""

    # 4. 小文件默认全量读取与向后兼容 (assert res["content"] 100% 原始文本)
    small_file = Path(temp_ws) / "small.txt"
    small_text = "line one\nline two\nline three"
    small_file.write_text(small_text, encoding="utf-8")
    res_small = WorkspaceToolExecutor.read_file(temp_ws, "small.txt")
    assert res_small["success"] is True
    assert res_small["content"] == small_text
    assert res_small["total_lines"] == 3
    assert res_small["has_more"] is False

    # 5. 空文件防御
    empty_file = Path(temp_ws) / "empty.txt"
    empty_file.write_text("", encoding="utf-8")
    res_empty = WorkspaceToolExecutor.read_file(temp_ws, "empty.txt")
    assert res_empty["success"] is True
    assert res_empty["total_lines"] == 0
    assert res_empty["has_more"] is False


# ==============================================================================
# 2. pty_tool_bridge 普通命令、交互挂起与 write_stdin 输入闭环
# ==============================================================================
@pytest.mark.anyio
async def test_pty_bridge_exec_command_completed(temp_ws):
    """测试 exec_command 执行非交互式常规命令正常返回 COMPLETED 与真实退出码"""
    res = await exec_command(
        workspace_root=temp_ws,
        cmd="echo 'genesis_pty_online_ok'",
        session_id="test_sess_normal",
        yield_time_ms=3000,
    )
    assert res["success"] is True
    assert res["status"] == "COMPLETED"
    assert res["exit_code"] == 0
    assert res["returncode"] == 0
    assert "genesis_pty_online_ok" in res["stdout"]


@pytest.mark.anyio
async def test_pty_bridge_interactive_yield_and_write_stdin(temp_ws):
    """测试 exec_command 遇到交互式输入在 yield_time_ms 后挂起返回 RUNNING_INTERACTIVE，并通过 write_stdin 注入响应完成交互"""
    py_script = (
        "import sys\n"
        "print('STEP1_WAITING_INPUT', flush=True)\n"
        "ans = input('Enter code: ')\n"
        "print('STEP2_CONFIRMED:' + ans, flush=True)\n"
    )

    # 启动交互式 Python 提示
    cmd = f"{sys.executable} -c \"{py_script}\""
    sid = "test_sess_interactive"

    res_step1 = await exec_command(
        workspace_root=temp_ws,
        cmd=cmd,
        session_id=sid,
        yield_time_ms=1000,
    )

    # 1. 验证智能挂起（绝不抛出 Timeout 错误，而是返回 RUNNING_INTERACTIVE）
    assert res_step1["success"] is True
    assert res_step1["status"] == "RUNNING_INTERACTIVE"
    assert "STEP1_WAITING_INPUT" in res_step1["stdout"]
    assert "hint" in res_step1

    # 2. 注入按键流完成交互
    res_step2 = await write_stdin(
        session_id=res_step1["session_id"],
        input_chars="TOKEN_VERIFIED_777\n",
        yield_time_ms=2000,
    )

    # 3. 验证交互后捕获输出并最终达成 COMPLETED
    assert res_step2["success"] is True
    assert res_step2["status"] == "COMPLETED"
    assert res_step2["exit_code"] == 0
    assert "STEP2_CONFIRMED:TOKEN_VERIFIED_777" in res_step2["stdout"]


# ==============================================================================
# 3. edit_file 自动生成快照 -> revert_patch 回滚磁盘与 DirtyTracker 告警闭环
# ==============================================================================
def test_edit_file_snapshot_revert_patch_and_dirty_tracker(client, temp_ws, monkeypatch):
    """测试 edit_file 自动登记 file_snapshots，调用 /api/workspace/revert_patch 精确回滚并触发 WorkspaceDirtyTracker 告警"""
    monkeypatch.setenv("WORKSPACE_ROOT", temp_ws)

    target_file = Path(temp_ws) / "calc.py"
    original_code = "def calculate(a, b):\n    return a + b\n"
    target_file.write_text(original_code, encoding="utf-8")

    session_id = f"sess_diff_{uuid.uuid4().hex[:8]}"

    # 1. 执行 edit_file 修改代码
    edit_res = WorkspaceToolExecutor.edit_file(
        workspace_root=temp_ws,
        path="calc.py",
        old_string="return a + b",
        new_string="return a * b",
        session_id=session_id,
    )
    assert edit_res["success"] is True
    patch_id = edit_res["patch_id"]
    assert patch_id is not None
    assert (Path(temp_ws) / "calc.py").read_text(encoding="utf-8") == "def calculate(a, b):\n    return a * b\n"

    # 验证数据库记录
    snap = db_get_file_snapshot(patch_id)
    assert snap is not None
    assert snap["status"] == "applied"
    assert snap["file_path"] == "calc.py"
    assert "return a + b" in snap["original_content"]
    assert "return a * b" in snap["modified_content"]

    # 2. 调用 /api/workspace/revert_patch 驳回并还原
    revert_resp = client.post(
        "/api/workspace/revert_patch",
        json={"patch_id": patch_id, "session_id": session_id},
    )
    assert revert_resp.status_code == 200
    rev_data = revert_resp.json()
    assert rev_data["success"] is True
    assert rev_data["status"] == "rejected"

    # 3. 验证磁盘文件瞬间被物理还原
    restored_disk = target_file.read_text(encoding="utf-8")
    assert restored_disk == original_code

    # 4. 验证数据库状态变更为 rejected
    updated_snap = db_get_file_snapshot(patch_id)
    assert updated_snap["status"] == "rejected"

    # 5. 验证 WorkspaceDirtyTracker 捕获并注入 diff_rejected 告警
    alerts = workspace_dirty_tracker.pop_pending_alerts(session_id)
    assert any("User REJECTED Agent patch on calc.py" in a and patch_id in a for a in alerts)


def test_accept_patch_and_plan_decision(client, temp_ws, monkeypatch):
    """测试 /api/workspace/accept_patch 接受补丁与 /api/workspace/plan_decision 规划决策双向驱动"""
    monkeypatch.setenv("WORKSPACE_ROOT", temp_ws)

    # 1. 创建文件与补丁
    target_file = Path(temp_ws) / "config.json"
    target_file.write_text('{"env": "development"}', encoding="utf-8")

    session_id = f"sess_plan_{uuid.uuid4().hex[:8]}"

    edit_res = WorkspaceToolExecutor.edit_file(
        workspace_root=temp_ws,
        path="config.json",
        old_string='"env": "development"',
        new_string='"env": "production"',
        session_id=session_id,
    )
    assert edit_res["success"] is True
    patch_id = edit_res["patch_id"]

    # 2. 接受补丁
    accept_res = client.post(
        "/api/workspace/accept_patch",
        json={"patch_id": patch_id},
    )
    assert accept_res.status_code == 200
    assert accept_res.json()["status"] == "accepted"
    assert db_get_file_snapshot(patch_id)["status"] == "accepted"

    # 3. 测试 plan_decision: 驳回计划 (approved=False)
    dec_rej = client.post(
        "/api/workspace/plan_decision",
        json={
            "session_id": session_id,
            "approved": False,
            "feedback": "请补充生产环境配置校验再执行",
        },
    )
    assert dec_rej.status_code == 200
    data_rej = dec_rej.json()
    assert data_rej["approved"] is False
    assert data_rej["mode"] == "plan"
    assert data_rej["state"] == "PLANNING"

    goal_rej = db_get_agent_goal(session_id)
    assert goal_rej is not None
    assert goal_rej["mode"] == "plan"
    assert goal_rej["lifecycle_state"] == "PLANNING"
    assert goal_rej["proposed_plan"] == "请补充生产环境配置校验再执行"

    # 4. 测试 plan_decision: 批准计划 (approved=True)
    dec_app = client.post(
        "/api/workspace/plan_decision",
        json={
            "session_id": session_id,
            "approved": True,
        },
    )
    assert dec_app.status_code == 200
    data_app = dec_app.json()
    assert data_app["approved"] is True
    assert data_app["mode"] == "act"
    assert data_app["state"] == "COMPILING_CONTEXT"

    goal_app = db_get_agent_goal(session_id)
    assert goal_app is not None
    assert goal_app["mode"] == "act"
    assert goal_app["lifecycle_state"] == "COMPILING_CONTEXT"
