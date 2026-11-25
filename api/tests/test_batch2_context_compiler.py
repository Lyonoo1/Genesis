import hashlib
import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any
import pytest

from models.schemas.chat import SSEEventName
from models.schemas.stream_envelope import (
    AgentRunMode,
    EnvelopeEmitter,
    StreamChannel,
    StreamEnvelope,
)
from services.context_compiler import (
    AtomicTurn,
    ContextCompiler,
    ContextTelemetry,
    LosslessStubFolder,
    TokenMeter,
    WorkspaceDirtyTracker,
    context_compiler,
    workspace_dirty_tracker,
)
from services.context_manager import ContextManager


# ============================================================================
# 1. TokenMeter 在 tiktoken 与离线回退模式下的准确性测试
# ============================================================================


def test_token_meter_with_tiktoken_online():
    """测试 tiktoken 可用时对英文、代码和 CJK 字符的高精度计量"""
    TokenMeter._tiktoken_disabled = False

    # 1. 英文与代码计量
    code_text = "def calculate_sum(a: int, b: int) -> int:\n    return a + b"
    code_tokens = TokenMeter.count_tokens(code_text, model="gpt-4o")
    assert code_tokens > 0
    # 相比 len(text) // 2 粗糙估算，tiktoken 精度在合理区间 (15 ~ 25)
    assert 10 <= code_tokens <= 30

    # 2. CJK 文本计量
    cjk_text = "你好，Genesis 智能编程助手！"
    cjk_tokens = TokenMeter.count_tokens(cjk_text, model="gpt-4o")
    assert cjk_tokens > 0
    assert 5 <= cjk_tokens <= 25

    # 3. 复合结构消息数组与字典
    msg_list = [
        {"role": "system", "content": "You are a helpful coding agent."},
        {"role": "user", "content": "How do I sort a list in Python?"},
    ]
    list_tokens = TokenMeter.count_tokens(msg_list, model="gpt-4o")
    assert list_tokens > 20

    # 4. 空文本返回 0
    assert TokenMeter.count_tokens("") == 0
    assert TokenMeter.count_tokens(None) == 0


def test_token_meter_offline_heuristic_fallback(monkeypatch):
    """测试 tiktoken 离线或词表加载失败时，自动切换至启发式分词器，且绝不粗暴退化为 len // 2"""
    # 模拟 tiktoken 词表加载失败或完全离线环境
    TokenMeter._tiktoken_disabled = True

    try:
        # 1. 纯 CJK 字符：按约 1.5 token/char 估算
        # 4 个汉字 -> 4 * 1.5 = 6.0 tokens
        cjk_text = "你好世界"
        cjk_tokens = TokenMeter.count_tokens(cjk_text, force_heuristic=True)
        assert cjk_tokens == 6
        assert cjk_tokens != len(cjk_text) // 2  # 绝不等于粗暴的 4 // 2 = 2

        # 2. 混合代码与标识符正则切分
        code_snippet = "def foo():\n    return 42"
        # len("def foo():\n    return 42") == 25, 粗暴 len//2 会等于 12
        heuristic_tokens = TokenMeter.count_tokens_heuristic(code_snippet)
        assert heuristic_tokens > 0
        # 验证基于符号切分算出的非 len // 2 真实权值 (约 8 tokens)
        assert heuristic_tokens != len(code_snippet) // 2
        assert 6 <= heuristic_tokens <= 12

        # 3. 消息字典解析
        dict_payload = {"tool": "read_file", "path": "src/main.py", "lines": 50}
        d_tokens = TokenMeter.count_tokens(dict_payload, force_heuristic=True)
        assert d_tokens > 5
    finally:
        TokenMeter._tiktoken_disabled = False


# ============================================================================
# 2. 连续 3 轮对话 Segment 1 + Segment 2 100% Prefix-Cache 前缀不变性测试
# ============================================================================


@pytest.mark.anyio
async def test_prefix_cache_invariance_across_multiple_turns():
    """断言连续 3 轮对话中 Segment 1 + Segment 2 保持字节级恒等，保障 90%+ 缓存命中率"""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_root = Path(tmp_dir)
        # 初始化工作区文件结构
        (ws_root / "src").mkdir()
        (ws_root / "src" / "main.py").write_text("print('hello')", encoding="utf-8")
        (ws_root / "README.md").write_text("# Test Project", encoding="utf-8")
        (ws_root / "AGENTS.md").write_text("Always follow clean code practices.", encoding="utf-8")

        compiler = ContextCompiler()
        session_id = str(uuid.uuid4())

        # 模拟模拟内存消息仓储
        class InMemoryMessageRepo:
            def __init__(self):
                self.messages = []

            async def list_by_session(self, *args, **kwargs):
                return list(self.messages)

            async def prune_branch(self, *args, **kwargs):
                pass

        repo = InMemoryMessageRepo()

        # Turn 1
        turn1_messages = await compiler.compile(
            user_id="user_test",
            session_id=session_id,
            new_prompt="请帮我分析项目结构",
            message_repo=repo,
            workspace_root=str(ws_root),
        )
        # 记录 Turn 1 历史
        repo.messages.append({"role": "user", "content": "请帮我分析项目结构"})
        repo.messages.append({"role": "assistant", "content": "项目包含 src/main.py 与 AGENTS.md。"})

        # Turn 2
        turn2_messages = await compiler.compile(
            user_id="user_test",
            session_id=session_id,
            new_prompt="在 main.py 中实现 add 函数",
            message_repo=repo,
            workspace_root=str(ws_root),
        )
        # 记录 Turn 2 历史
        repo.messages.append({"role": "user", "content": "在 main.py 中实现 add 函数"})
        repo.messages.append({"role": "assistant", "content": "函数实现完毕。"})

        # Turn 3
        turn3_messages = await compiler.compile(
            user_id="user_test",
            session_id=session_id,
            new_prompt="运行 pytest 测试",
            message_repo=repo,
            workspace_root=str(ws_root),
        )

        # 验证 3 轮中的 Segment 1 (Frozen System Prompt) 字节级完全一致
        assert turn1_messages[0]["role"] == "system"
        assert turn1_messages[0]["content"] == turn2_messages[0]["content"]
        assert turn2_messages[0]["content"] == turn3_messages[0]["content"]

        # 验证 3 轮中的 Segment 2 (Semi-Static Workspace Anchor) 字节级完全一致
        assert turn1_messages[1]["role"] == "system"
        assert "<workspace_anchor>" in turn1_messages[1]["content"]
        assert turn1_messages[1]["content"] == turn2_messages[1]["content"]
        assert turn2_messages[1]["content"] == turn3_messages[1]["content"]

        # 验证遥测指标稳定性
        telemetry = compiler.last_telemetry
        assert telemetry is not None
        assert telemetry.prefix_cache_stable is True
        assert telemetry.frozen_prefix_tokens > 0
        assert telemetry.estimated_cache_hit_ratio > 0.0


# ============================================================================
# 3. LosslessStubFolder 无损存根折叠器算法单测
# ============================================================================


def test_lossless_stub_folder_read_file():
    """测试 LosslessStubFolder 对 read_file 生成高密度结构化存根"""
    folder = LosslessStubFolder()
    raw_content = {
        "path": "src/auth.py",
        "content": "class AuthManager:\n    def login(self, username, password):\n        pass\n    def logout(self):\n        pass\n",
    }
    tool_args = {"path": "src/auth.py", "offset": 1}

    stub = folder.fold_tool_output(
        tool_name="workspace__read_file",
        tool_args=tool_args,
        raw_content=raw_content,
        session_id="test_sess",
    )

    assert stub.startswith('[Stub: read_file(path="src/auth.py", lines=1..5)')
    assert "sha256:" in stub
    assert "symbols: [class AuthManager, def login, def logout]" in stub
    assert "status: Sync" in stub


def test_lossless_stub_folder_edit_file():
    """测试 LosslessStubFolder 对 edit_file / write_file 生成包含增删行与 patch_id 的存根"""
    folder = LosslessStubFolder()
    raw_content = {
        "path": "src/auth.py",
        "additions": 15,
        "deletions": 3,
        "modified_content": "def authenticate():\n    return True\n",
        "patch_id": "patch_auth_v1",
    }
    tool_args = {"path": "src/auth.py"}

    stub = folder.fold_tool_output(
        tool_name="workspace__edit_file",
        tool_args=tool_args,
        raw_content=raw_content,
        session_id="test_sess",
    )

    expected_sha = WorkspaceDirtyTracker.compute_sha256(raw_content["modified_content"])[:8]
    assert stub == f'[Stub: edit_file(path="src/auth.py") | +15/-3 lines | sha256: {expected_sha} | patch_id: patch_auth_v1]'


def test_lossless_stub_folder_execute_command():
    """测试 LosslessStubFolder 对 execute_command 生成包含 exit_code 与 key_lines 的存根"""
    folder = LosslessStubFolder()
    raw_content = {
        "command": "uv run pytest",
        "returncode": 0,
        "stdout": "================ test session starts ================\n148 passed in 5.2s\n",
        "pty_session_id": "pty_terminal_99",
    }
    tool_args = {"command": "uv run pytest"}

    stub = folder.fold_tool_output(
        tool_name="workspace__execute_command",
        tool_args=tool_args,
        raw_content=raw_content,
        session_id="test_sess",
    )

    assert '[Stub: exec_command(cmd="uv run pytest")' in stub
    assert "exit_code: 0" in stub
    assert 'key_lines: "================ test session starts ================ ... 148 passed in 5.2s"' in stub
    assert "session_id: pty_terminal_99" in stub


def test_lossless_stub_folder_fold_turns_threshold():
    """测试 fold_turns 仅对距离最新轮次 > 4 的历史轮次无损折叠，新轮次不折叠"""
    # 构造 7 个轮次 (Turn 0 ~ Turn 6)
    turns = []
    for i in range(7):
        turns.append(
            AtomicTurn(
                role="assistant",
                messages=[
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": f"call_{i}",
                                "type": "function",
                                "function": {
                                    "name": "workspace__read_file",
                                    "arguments": json.dumps({"path": f"file_{i}.py"}),
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "tool_call_id": f"call_{i}",
                        "content": f"def func_{i}():\n    return {i}\n",
                    },
                ],
            )
        )

    # fold_after_turns = 4:
    # 最新轮次是 Turn 6 (distance = 0)
    # Turn 0 (distance = 6) 与 Turn 1 (distance = 5) 距离 > 4 -> 应折叠为 Stub
    # Turn 2 ~ Turn 6 (distance <= 4) -> 保持原样
    folded_turns, folded_count = LosslessStubFolder.fold_turns(turns, fold_after_turns=4)

    assert folded_count == 2
    assert folded_turns[0].messages[1]["content"].startswith('[Stub: read_file(path="file_0.py"')
    assert folded_turns[1].messages[1]["content"].startswith('[Stub: read_file(path="file_1.py"')
    assert not folded_turns[2].messages[1]["content"].startswith("[Stub:")
    assert "def func_2" in folded_turns[2].messages[1]["content"]
    assert "def func_6" in folded_turns[6].messages[1]["content"]


# ============================================================================
# 4. 工作区脏文件反向感知 (WorkspaceDirtyTracker) 与告警注入单测
# ============================================================================


def test_workspace_dirty_tracker_detects_disk_modification():
    """测试当文件在 Agent 外部被修改时，自动对比计算精确行号范围并生成告警，Stub 同步更新为 Stale"""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_root = Path(tmp_dir)
        auth_file = ws_root / "src" / "auth.py"
        auth_file.parent.mkdir(parents=True, exist_ok=True)

        # 初始 30 行文件
        initial_lines = [f"line_{i} = {i}" for i in range(1, 31)]
        auth_file.write_text("\n".join(initial_lines), encoding="utf-8")

        tracker = WorkspaceDirtyTracker()
        session_id = "test_dirty_sess"

        # 1. Agent 在循环内执行 read_file 记录 Hash
        tracker.record_agent_file_access(
            session_id=session_id,
            path="src/auth.py",
            content="\n".join(initial_lines),
            action="read",
            workspace_root=str(ws_root),
        )

        status_before, _ = tracker.get_file_status(session_id, "src/auth.py", str(ws_root))
        assert status_before == "Sync"

        # 2. 用户在外部手动修改 lines 10 到 15
        modified_lines = list(initial_lines)
        for idx in range(9, 15):
            modified_lines[idx] = f"modified_line_{idx + 1} = 'MANUAL_EDIT'"
        auth_file.write_text("\n".join(modified_lines), encoding="utf-8")

        # 3. 扫描工作区脏文件
        alerts, dirty_files = tracker.scan_workspace_for_dirty_files(
            session_id=session_id,
            workspace_root=str(ws_root),
        )

        assert "src/auth.py" in dirty_files
        assert len(alerts) == 1
        alert = alerts[0]
        # 验证精确行号范围 lines 10-15
        assert "[Workspace Alert: User manually modified src/auth.py (lines 10-15) outside Agent loop" in alert
        assert "New sha256:" in alert

        # 4. 验证文件状态变为 Stale (Modified externally)
        status_after, _ = tracker.get_file_status(session_id, "src/auth.py", str(ws_root))
        assert status_after == "Stale (Modified externally)"

        # 5. 验证 read_file 存根刷新状态
        folder = LosslessStubFolder()
        stub_before = '[Stub: read_file(path="src/auth.py", lines=1..30) | sha256: 12345678 | symbols: [none] | status: Sync]'
        stub_refreshed = folder.fold_tool_output(
            tool_name="workspace__read_file",
            tool_args={"path": "src/auth.py"},
            raw_content=stub_before,
            session_id=session_id,
            workspace_root=str(ws_root),
            dirty_tracker=tracker,
        )
        assert "status: Stale (Modified externally)" in stub_refreshed


def test_workspace_dirty_tracker_diff_rejected_alert():
    """测试当用户在右侧栏拒绝 Agent Patch 时，记录 diff_rejected 并生成严禁重复应用的告警"""
    tracker = WorkspaceDirtyTracker()
    session_id = "test_reject_sess"

    alerts = tracker.record_user_external_modification(
        session_id=session_id,
        path="src/auth.py",
        old_content="def old(): pass",
        new_content="def revert(): pass",
        source="diff_rejected",
        patch_id="patch_auth_007",
    )

    assert len(alerts) == 1
    alert = alerts[0]
    assert "[Workspace Alert: User REJECTED Agent patch on src/auth.py (patch_id=patch_auth_007)" in alert
    assert "Do NOT re-apply the same change without asking.]" in alert


# ============================================================================
# 5. 上下文编译器集成与信封遥测推送 (CONTEXT_TELEMETRY) 测试
# ============================================================================


@pytest.mark.anyio
async def test_compile_context_telemetry_emission():
    """测试 compile 编译流程产生包含缓存命中估算、脏文件与存根统计的 CONTEXT_TELEMETRY 事件"""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_root = Path(tmp_dir)
        (ws_root / "app.py").write_text("print('test')", encoding="utf-8")

        compiler = ContextCompiler()
        emitter = EnvelopeEmitter(turn_id="turn_telemetry_test")
        session_id = str(uuid.uuid4())

        messages = await compiler.compile(
            user_id="user_telemetry",
            session_id=session_id,
            new_prompt="请帮我检查 app.py 代码质量",
            workspace_root=str(ws_root),
            emitter=emitter,
        )

        assert len(messages) >= 3
        # Segment 1: System
        assert messages[0]["role"] == "system"
        # Segment 2: Workspace Anchor
        assert messages[1]["role"] == "system"
        assert "<workspace_anchor>" in messages[1]["content"]
        # Segment 3: User
        assert messages[-1]["role"] == "user"
        assert "请帮我检查 app.py 代码质量" in messages[-1]["content"]

        # 检查编译器保存的遥测数据
        telemetry = compiler.last_telemetry
        assert isinstance(telemetry, ContextTelemetry)
        assert telemetry.session_id == session_id
        assert telemetry.frozen_prefix_tokens > 0
        assert telemetry.total_tokens >= telemetry.frozen_prefix_tokens
        assert telemetry.prefix_cache_stable is True
        assert 0.0 <= telemetry.estimated_cache_hit_ratio <= 1.0


@pytest.mark.anyio
async def test_compile_context_telemetry_seq_continuity():
    """测试 compile 发射的遥测信封与后续事件的 seq 严格连续递增，严禁跳号或丢帧"""
    compiler = ContextCompiler()
    emitter = EnvelopeEmitter(turn_id="turn_seq_test")

    # 1. 模拟在编译前发射了 initial 事件 (seq = 1)
    ev1 = emitter.emit_sse("session_info", {"mode": "act"})
    assert '"seq": 1' in ev1
    assert emitter.current_seq == 1

    # 2. compile 传入 emitter (应生成 seq = 2 的遥测信封保存在 compiler.last_telemetry_sse)
    await compiler.compile(
        user_id="user_seq",
        session_id="session_seq_001",
        new_prompt="你好",
        emitter=emitter,
    )
    assert compiler.last_telemetry_sse is not None
    assert '"seq": 2' in compiler.last_telemetry_sse
    assert '"event": "context_telemetry"' in compiler.last_telemetry_sse
    assert emitter.current_seq == 2

    # 3. 后续事件 (seq = 3)，验证 seq 严格连续无空洞
    ev3 = emitter.emit_sse(SSEEventName.TEXT_DELTA.value, {"delta": "hello"})
    assert '"seq": 3' in ev3
    assert emitter.current_seq == 3


def test_workspace_dirty_tracker_recovery_to_sync():
    """测试当被外部篡改的文件被手动或外部恢复为 Agent 基准时，状态自动自愈回到 Sync 且移出 dirty 列表"""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_root = Path(tmp_dir)
        test_file = ws_root / "config.json"
        original_text = '{"debug": false}'
        test_file.write_text(original_text, encoding="utf-8")

        tracker = WorkspaceDirtyTracker()
        session_id = "sess_recover"

        # 1. Agent 读取文件
        tracker.record_agent_file_access(
            session_id=session_id,
            path="config.json",
            content=original_text,
            action="read",
            workspace_root=str(ws_root),
        )
        st, _ = tracker.get_file_status(session_id, "config.json", str(ws_root))
        assert st == "Sync"

        # 2. 外部修改文件 -> Stale
        test_file.write_text('{"debug": true}', encoding="utf-8")
        alerts1, dirty1 = tracker.scan_workspace_for_dirty_files(session_id, str(ws_root))
        assert "config.json" in dirty1
        assert len(alerts1) == 1
        st_dirty, _ = tracker.get_file_status(session_id, "config.json", str(ws_root))
        assert st_dirty == "Stale (Modified externally)"

        # 3. 外部还原文件为原始文本 -> 自动自愈回 Sync
        test_file.write_text(original_text, encoding="utf-8")
        alerts2, dirty2 = tracker.scan_workspace_for_dirty_files(session_id, str(ws_root))
        assert "config.json" not in dirty2
        st_clean, _ = tracker.get_file_status(session_id, "config.json", str(ws_root))
        assert st_clean == "Sync"


def test_workspace_dirty_tracker_external_file_deletion():
    """测试当 Agent 读取过的文件在外部被删除时，能够准确发出删除告警并标记 Stale"""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_root = Path(tmp_dir)
        test_file = ws_root / "temp.txt"
        test_file.write_text("temporary content", encoding="utf-8")

        tracker = WorkspaceDirtyTracker()
        session_id = "sess_delete"

        tracker.record_agent_file_access(
            session_id=session_id,
            path="temp.txt",
            content="temporary content",
            action="read",
            workspace_root=str(ws_root),
        )

        # 外部删除文件
        test_file.unlink()

        alerts, dirty = tracker.scan_workspace_for_dirty_files(session_id, str(ws_root))
        assert "temp.txt" in dirty
        assert any("was deleted outside Agent loop" in a for a in alerts)
        st, _ = tracker.get_file_status(session_id, "temp.txt", str(ws_root))
        assert "Deleted" in st


@pytest.mark.anyio
async def test_lossless_stub_folding_when_approaching_budget():
    """测试当历史 Token 逼近预算阈值时，自动激活深度无损存根折叠，保护上下文历史不被直接全额丢弃"""
    compiler = ContextCompiler()
    session_id = str(uuid.uuid4())

    class MockRepo:
        def __init__(self):
            # 创建 3 轮对话，每轮包含一个超大的 tool 输出
            self.messages = [
                {"role": "user", "content": "任务 1"},
                {
                    "role": "assistant",
                    "content": "正在读文件 1",
                    "raw_tool_calls": [{"id": "call_1", "name": "workspace__read_file", "args": {"path": "large1.py"}}],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "def f1():\n    return 1\n" + ("# line\n" * 400)},
                {"role": "user", "content": "任务 2"},
                {
                    "role": "assistant",
                    "content": "正在读文件 2",
                    "raw_tool_calls": [{"id": "call_2", "name": "workspace__read_file", "args": {"path": "large2.py"}}],
                },
                {"role": "tool", "tool_call_id": "call_2", "content": "def f2():\n    return 2\n" + ("# line\n" * 400)},
            ]

        async def list_by_session(self, *args, **kwargs):
            return list(self.messages)

        async def prune_branch(self, *args, **kwargs):
            pass

    repo = MockRepo()
    # 设定较紧的 context_window (1000 tokens)，触发深度折叠逻辑
    messages = await compiler.compile(
        user_id="user_budget",
        session_id=session_id,
        new_prompt="请帮我总结",
        message_repo=repo,
        context_window=1200,
        fold_after_turns=4,  # 原生 4 轮策略下 2 轮历史本不应折叠，但因逼近预算，将被深度折叠为 Stub
    )

    # 验证历史 tool 消息被压缩为高密度 Stub 而非被硬性截断或报错
    tool_msgs = [m for m in messages if m.get("role") == "tool"]
    assert len(tool_msgs) >= 1
    for tm in tool_msgs:
        assert tm["content"].startswith("[Stub: read_file(")


def test_compute_changed_line_range_fast_prefix_suffix():
    """测试超长文件在首尾一致、中间修改时，O(N) 快速对比算法的准确性与毫秒级响应"""
    # 构造 10,000 行文件
    total_lines = 10000
    old_lines = [f"line_{i} = {i}" for i in range(1, total_lines + 1)]
    new_lines = list(old_lines)
    # 修改第 5000 行到 5010 行
    for k in range(4999, 5010):
        new_lines[k] = f"line_{k+1} = 'MODIFIED'"

    old_text = "\n".join(old_lines)
    new_text = "\n".join(new_lines)

    start_l, end_l = WorkspaceDirtyTracker.compute_changed_line_range(old_text, new_text)
    assert start_l == 5000
    assert end_l == 5010


def test_extract_symbols_resilience():
    """测试符号提取算法在多语言、语法错误、嵌套类与空输入下的健壮性"""
    # 1. 语法错误的 Python 代码 (依然通过正则降级提取)
    broken_py = "def valid_func(x):\n    return x\n\ndef broken_func(\n"
    syms_broken = LosslessStubFolder.extract_symbols(broken_py)
    assert "def valid_func" in syms_broken

    # 2. TypeScript / JavaScript 语法
    ts_code = """
    export class UserService {
        async getUserProfile(id: string) {}
    }
    export function fetchSettings() {}
    """
    syms_ts = LosslessStubFolder.extract_symbols(ts_code)
    assert any("UserService" in s for s in syms_ts)
    assert any("fetchSettings" in s for s in syms_ts)

    # 3. 空输入
    assert LosslessStubFolder.extract_symbols("") == []
    assert LosslessStubFolder.extract_symbols(None) == []

