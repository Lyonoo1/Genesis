import os
import shutil
import tempfile
import pytest
import asyncio
from pathlib import Path

from services.workspace_tool_executor import WorkspaceToolExecutor
from services.permission_manager import permission_manager, PermissionDecision
from services.chat_service import GREETING_PATTERN


@pytest.fixture
def temp_workspace():
    tmp_dir = tempfile.mkdtemp(prefix="genesis_harness_test_")
    yield tmp_dir
    if os.path.exists(tmp_dir):
        shutil.rmtree(tmp_dir)


def test_edit_file_success(temp_workspace):
    # 初始化一个包含多个函数的文件
    initial_code = (
        "def foo():\n"
        "    return 1\n\n"
        "def bar():\n"
        "    return 2\n\n"
        "def baz():\n"
        "    return 3\n"
    )
    WorkspaceToolExecutor.write_file(temp_workspace, "math_utils.py", initial_code)

    # 局部替换 bar 函数
    old_str = "def bar():\n    return 2"
    new_str = "def bar():\n    return 42"
    res = WorkspaceToolExecutor.edit_file(temp_workspace, "math_utils.py", old_str, new_str)

    assert res["success"] is True
    assert "成功局部替换" in res["message"]

    content = Path(temp_workspace, "math_utils.py").read_text(encoding="utf-8")
    assert "return 42" in content
    assert "return 1" in content
    assert "return 3" in content


def test_edit_file_not_found(temp_workspace):
    WorkspaceToolExecutor.write_file(temp_workspace, "app.py", "print('hello world')")

    res = WorkspaceToolExecutor.edit_file(
        temp_workspace,
        "app.py",
        "print('non_existent')",
        "print('replacement')"
    )
    assert res["success"] is False
    assert "未在文件" in res["error"]


def test_edit_file_ambiguous_matches(temp_workspace):
    # 重复出现的字符串
    duplicate_code = "val = 10\nprint(val)\nval = 10\n"
    WorkspaceToolExecutor.write_file(temp_workspace, "dup.py", duplicate_code)

    res = WorkspaceToolExecutor.edit_file(
        temp_workspace,
        "dup.py",
        "val = 10",
        "val = 20"
    )
    assert res["success"] is False
    assert "不具备唯一性" in res["error"]
    assert "2 处" in res["error"]


def test_compact_output(temp_workspace):
    # 1. 短输出不压缩
    short_text = "Success: 4 files processed."
    res_short = WorkspaceToolExecutor.compact_output(temp_workspace, short_text, max_chars=100)
    assert res_short == short_text

    # 2. 超长输出写入工作区存盘，并保留首尾切片
    long_lines = [f"Line {i:04d}: data payload sample test row {i}" for i in range(100)]
    long_text = "\n".join(long_lines)
    assert len(long_text) > 1000

    res_compact = WorkspaceToolExecutor.compact_output(temp_workspace, long_text, max_chars=500)
    assert "完整日志已持久化至:" in res_compact
    assert ".genesis_outputs/tool-results" in res_compact
    assert "Line 0000" in res_compact
    assert "Line 0099" in res_compact

    # 验证磁盘文件确实落地
    spool_dir = Path(temp_workspace) / ".genesis_outputs" / "tool-results"
    assert spool_dir.exists()
    saved_files = list(spool_dir.glob("result_*.txt"))
    assert len(saved_files) == 1
    assert saved_files[0].read_text(encoding="utf-8") == long_text


def test_permission_manager_rules():
    # 1. 硬黑名单 (DENY)
    dec, reason = permission_manager.evaluate("workspace__execute_command", {"command": "rm -rf /"})
    assert dec == PermissionDecision.DENY
    assert "安全策略物理拦截" in reason

    dec, _ = permission_manager.evaluate("workspace__execute_command", {"command": "mkfs.ext4 /dev/sda"})
    assert dec == PermissionDecision.DENY

    dec, _ = permission_manager.evaluate("workspace__execute_command", {"command": ":(){ :|:& };:"})
    assert dec == PermissionDecision.DENY

    # 2. 高危操作需要审批 (ASK)
    dec, _ = permission_manager.evaluate("workspace__delete_file", {"path": "main.py"})
    assert dec == PermissionDecision.ASK

    dec, _ = permission_manager.evaluate("workspace__execute_command", {"command": "rm -f temp.log"})
    assert dec == PermissionDecision.ASK

    dec, _ = permission_manager.evaluate("workspace__execute_command", {"command": "chmod 777 run.sh"})
    assert dec == PermissionDecision.ASK

    # 3. 安全只读操作 (ALLOW)
    dec, _ = permission_manager.evaluate("workspace__read_file", {"path": "README.md"})
    assert dec == PermissionDecision.ALLOW

    dec, _ = permission_manager.evaluate("workspace__list_dir", {})
    assert dec == PermissionDecision.ALLOW

    dec, _ = permission_manager.evaluate("workspace__execute_command", {"command": "ls -la"})
    assert dec == PermissionDecision.ALLOW


def test_permission_manager_async_flow():
    async def run_async_test():
        # 1. 测试批准流程
        session_id = "test_sess_approve"
        tool_call_id = "tc_1"
        fut = permission_manager.register_approval(session_id, tool_call_id)
        assert f"{session_id}:{tool_call_id}" in permission_manager._pending_approvals

        # 模拟外部异步批准
        permission_manager.resolve_approval(session_id, tool_call_id, True)
        assert await fut is True
        assert f"{session_id}:{tool_call_id}" not in permission_manager._pending_approvals

        # 2. 测试拒绝流程
        sess_deny = "test_sess_deny"
        tc_deny = "tc_2"
        fut_deny = permission_manager.register_approval(sess_deny, tc_deny)
        permission_manager.resolve_approval(sess_deny, tc_deny, False)
        assert await fut_deny is False
        assert f"{sess_deny}:{tc_deny}" not in permission_manager._pending_approvals

    asyncio.run(run_async_test())


def test_codex_greeting_pattern():
    # 问候语精准命中（屏蔽 tools，防止过度调用）
    greetings = [
        "你好",
        "你好啊",
        "在吗",
        "在么？",
        "hi",
        "Hello",
        "hey",
        "早上好",
        "晚上好！",
    ]
    for g in greetings:
        assert bool(GREETING_PATTERN.match(g.strip())) is True, f"Failed on: {g}"

    # 正常工作指令绝对不应命中问候语门控
    work_prompts = [
        "帮我看看当前目录有什么文件",
        "列出所有 .ts 文件",
        "你好，帮我重构一下这个函数",
        "阅读 README.md",
        "请删除旧的缓存",
        "你能写 Python 代码吗？",
    ]
    for w in work_prompts:
        assert bool(GREETING_PATTERN.match(w.strip())) is False, f"Unexpected match on: {w}"
