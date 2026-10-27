import asyncio
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Optional
import pytest
from fastapi.testclient import TestClient

from main import app
from models.schemas.chat import ChatRequest, SSEEventName
from models.schemas.message import MessageCreate, MessageRole, MessageStatus
from repositories.message_repository import MessageRepository
from services.chat_service import ChatService, chat_service, format_sse
from services.context_manager import ContextManager, AtomicTurn, context_manager
from services.llm_adapter import LLMAdapter, StreamChunk
from services.preview_service import inject_preview_bridge, PREVIEW_BRIDGE_SCRIPT
from services.subagent_runner import SubagentRunner, subagent_runner
from services.todo_manager import TodoManager, todo_manager
from services.tool_adapter import ToolAdapter
from services.workspace_tool_executor import WorkspaceToolExecutor


@pytest.fixture
def temp_ws():
    tmp = tempfile.mkdtemp(prefix="genesis_p4_ws_")
    yield tmp
    if os.path.exists(tmp):
        shutil.rmtree(tmp)


class MockLLMAdapter(LLMAdapter):
    """测试用 Mock LLM 适配器"""

    def __init__(self, responses: Optional[list[list[StreamChunk]]] = None):
        super().__init__()
        self.responses = list(responses or [])
        self.call_count = 0
        self.last_messages = []

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        model: str = "gpt-4o",
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        self.call_count += 1
        self.last_messages = list(messages)
        if self.responses:
            chunk_list = self.responses.pop(0)
            for c in chunk_list:
                yield c
        else:
            yield StreamChunk(type="text", text="Mock LLM final answer")
            yield StreamChunk(type="finish", finish_reason="stop", input_tokens=10, output_tokens=10)


# ============================================================================
# 任务 1: Subagent 子代理隔离委派机制
# ============================================================================

def test_tool_adapter_subagent_schema():
    """验证 ToolAdapter 注册了 workspace__dispatch_subagent 工具定义与契约"""
    tools = ToolAdapter.BUILTIN_WORKSPACE_TOOLS
    tool = next((t for t in tools if t["function"]["name"] == "workspace__dispatch_subagent"), None)
    assert tool is not None
    params = tool["function"]["parameters"]
    assert "agent_type" in params["properties"]
    assert "task_prompt" in params["properties"]
    assert params["properties"]["agent_type"]["enum"] == ["explore", "verify"]
    assert set(params["required"]) == {"agent_type", "task_prompt"}


def test_subagent_runner_tool_filtering():
    """验证 explore 纯只读，verify 仅增加 execute_command，二者均严禁写文件与递归派发"""
    runner = SubagentRunner()
    explore_tools = runner._filter_allowed_tools("explore")
    explore_names = {t["function"]["name"] for t in explore_tools}

    assert explore_names == {
        "workspace__read_file",
        "workspace__grep_search",
        "workspace__find_by_name",
        "workspace__list_dir",
    }
    assert "workspace__write_file" not in explore_names
    assert "workspace__edit_file" not in explore_names
    assert "workspace__delete_file" not in explore_names
    assert "workspace__dispatch_subagent" not in explore_names
    assert "workspace__execute_command" not in explore_names

    verify_tools = runner._filter_allowed_tools("verify")
    verify_names = {t["function"]["name"] for t in verify_tools}
    assert "workspace__execute_command" in verify_names
    assert "workspace__write_file" not in verify_names
    assert "workspace__dispatch_subagent" not in verify_names


@pytest.mark.anyio
async def test_subagent_explore_execution_and_summary_truncation(temp_ws):
    """验证子代理沙箱独立执行、调用只读工具并在 2000 字符内收敛返回"""
    # 准备工作区文件
    WorkspaceToolExecutor.write_file(temp_ws, "config.json", '{"version": "1.0", "name": "Genesis"}')

    # 模拟两轮交互：第 1 轮 LLM 请求 read_file，第 2 轮 LLM 输出超长总结
    super_long_summary = "Analysis report:\n" + ("X" * 3000)
    mock_llm = MockLLMAdapter(
        responses=[
            [
                StreamChunk(
                    type="tool_finish",
                    tool_call_id="call_sub_1",
                    tool_name="workspace__read_file",
                    arguments={"path": "config.json"},
                ),
                StreamChunk(type="finish", finish_reason="tool_calls"),
            ],
            [
                StreamChunk(type="text", text=super_long_summary),
                StreamChunk(type="finish", finish_reason="stop"),
            ],
        ]
    )

    runner = SubagentRunner(llm=mock_llm)
    progress_events = []
    final_result = None

    async for chunk in runner.run(
        workspace_root=temp_ws,
        agent_type="explore",
        task_prompt="查阅 config.json 并总结",
        model="gpt-4o",
        max_steps=8,
        max_summary_length=2000,
    ):
        if chunk["type"] == "progress":
            progress_events.append(chunk["data"])
        elif chunk["type"] == "result":
            final_result = chunk["data"]

    # 1. 验证有进度事件产出
    assert len(progress_events) >= 2
    assert any(e.get("status") == "executing_tools" for e in progress_events)
    thinking_event = next((e for e in progress_events if e.get("status") == "thinking"), None)
    assert thinking_event is not None
    assert thinking_event.get("task_prompt") == "查阅 config.json 并总结"

    # 2. 验证最终收缩截断在 2000 字符以内
    assert final_result is not None
    assert final_result["success"] is True
    assert final_result["agent_type"] == "explore"
    assert len(final_result["summary"]) <= 2000
    assert "超出了 2,000 字符" in final_result["summary"] or "已自动截断" in final_result["summary"]


@pytest.mark.anyio
async def test_subagent_forbidden_tool_interception(temp_ws):
    """验证子代理企图调用破坏性/越权工具（如 write_file）时被沙箱硬拦截"""
    mock_llm = MockLLMAdapter(
        responses=[
            [
                StreamChunk(
                    type="tool_finish",
                    tool_call_id="call_hack",
                    tool_name="workspace__write_file",
                    arguments={"path": "hack.txt", "content": "bad"},
                ),
                StreamChunk(type="finish", finish_reason="tool_calls"),
            ],
            [
                StreamChunk(type="text", text="已收到拦截报错，终止越权。"),
                StreamChunk(type="finish", finish_reason="stop"),
            ],
        ]
    )
    runner = SubagentRunner(llm=mock_llm)
    async for _ in runner.run(temp_ws, "explore", "测试越权", "gpt-4o", max_steps=4):
        pass

    # 验证文件绝对没有被创建
    assert not (Path(temp_ws) / "hack.txt").exists()


# ============================================================================
# 任务 2: workspace__todo_write 状态机与置顶保护
# ============================================================================

def test_todo_manager_lifecycle():
    """验证 TodoManager 会话级待办列表维护与格式化快照"""
    sid = "session-todo-test-1"
    todos = [
        {"id": "t1", "content": "实现数据库迁移", "status": "completed"},
        {"id": "t2", "content": "编写集成测试", "status": "in_progress"},
        {"id": "t3", "content": "发布部署", "status": "pending"},
    ]
    TodoManager.set_todos(sid, todos)
    assert TodoManager.has_unfinished_todos(sid) is True

    snapshot = TodoManager.format_todo_snapshot(sid)
    assert snapshot is not None
    assert "[x] (已完成) [t1]: 实现数据库迁移" in snapshot
    assert "[▶] (进行中) [t2]: 编写集成测试" in snapshot
    assert "[ ] (待开始) [t3]: 发布部署" in snapshot

    # 当全部完成时，不再附带快照置顶
    all_done = [
        {"id": "t1", "content": "实现数据库迁移", "status": "completed"},
        {"id": "t2", "content": "编写集成测试", "status": "completed"},
    ]
    TodoManager.set_todos(sid, all_done)
    assert TodoManager.has_unfinished_todos(sid) is False
    assert TodoManager.format_todo_snapshot(sid) is None

    TodoManager.clear_todos(sid)


@pytest.mark.anyio
async def test_context_manager_todo_snapshot_injection():
    """验证当会话存在未完成 todos 时，build_context 自动在末尾消息附带 Todo 状态快照"""
    sid = str(uuid.uuid4())
    TodoManager.set_todos(
        sid,
        [
            {"id": "step-1", "content": "修复Bug", "status": "in_progress"},
            {"id": "step-2", "content": "更新文档", "status": "pending"},
        ],
    )

    ctx_mgr = ContextManager()
    messages = await ctx_mgr.build_context(
        user_id="test_user",
        session_id=sid,
        new_prompt="请继续下一步",
    )

    last_msg = messages[-1]
    assert last_msg["role"] == "user"
    assert "请继续下一步" in last_msg["content"]
    assert "【待办任务状态机快照 (Todo State)】" in last_msg["content"]
    assert "[▶] (进行中) [step-1]: 修复Bug" in last_msg["content"]
    assert "[ ] (待开始) [step-2]: 更新文档" in last_msg["content"]

    TodoManager.clear_todos(sid)


# ============================================================================
# 任务 3: L3 结构化摘要 (Auto-Compact)
# ============================================================================

def test_l3_fallback_summary_format():
    """验证当旧 Turn 淘汰时，结构化摘要严格包含三大必选字段且 Token 严格 <= 800"""
    ctx_mgr = ContextManager()

    pruned = [
        AtomicTurn(
            role="assistant",
            messages=[
                {
                    "role": "assistant",
                    "content": "修改代码并运行测试",
                    "tool_calls": [
                        {"id": "tc1", "function": {"name": "workspace__write_file", "arguments": '{"path": "src/app.py"}'}},
                        {"id": "tc2", "function": {"name": "workspace__edit_file", "arguments": '{"path": "src/utils.py"}'}},
                    ],
                },
                {"role": "tool", "tool_call_id": "tc1", "content": '{"success": true}'},
                {"role": "tool", "tool_call_id": "tc2", "content": '{"success": false, "error": "IndexError: list index out of range"}', "is_error": True},
            ],
        ),
        AtomicTurn(
            role="user",
            messages=[{"role": "user", "content": "请务必保证对 Python 3.12 兼容"}],
        ),
    ]

    summary = ctx_mgr._extract_fallback_summary(pruned)
    assert "<compact_summary>" in summary
    assert "</compact_summary>" in summary
    assert "[已修改文件与变更摘要]" in summary
    assert "[已解决与未解决的报错]" in summary
    assert "[核心上下文约束与待办进度]" in summary
    assert "src/app.py" in summary
    assert "IndexError" in summary
    assert "Python 3.12 兼容" in summary
    assert ctx_mgr.estimate_tokens(summary) <= 800


@pytest.mark.anyio
async def test_auto_compact_inserted_after_first_user_turn():
    """验证 Auto-Compact 将摘要封装为紧随第 1 条 User 消息之后的记忆块"""
    ctx_mgr = ContextManager()

    # 构造历史轮次
    turns = [
        AtomicTurn(role="user", messages=[{"role": "user", "content": "初始项目任务目标"}]),  # Turn 0
        AtomicTurn(role="assistant", messages=[{"role": "assistant", "content": "A" * 600}]),  # Turn 1
        AtomicTurn(role="assistant", messages=[{"role": "assistant", "content": "B" * 600}]),  # Turn 2
        AtomicTurn(role="assistant", messages=[{"role": "assistant", "content": "C" * 600}]),  # Turn 3 (最新)
    ]

    # 总预算 500 tokens -> 只能容纳 Turn 0 和 Turn 3，Turn 1 & 2 将被淘汰并触发 Auto-Compact
    selected, pruned = ctx_mgr.apply_budget_pruning(turns, budget=500, return_pruned=True)
    assert len(pruned) == 2
    assert pruned[0] is turns[1]
    assert pruned[1] is turns[2]

    compact_text = await ctx_mgr.generate_compact_summary(pruned)
    assert "<compact_summary>" in compact_text

    compact_turn = AtomicTurn(
        role="assistant",
        messages=[{"role": "assistant", "content": f"[历史执行过程无损结构化归档记忆库]\n{compact_text}"}],
    )
    selected.insert(1, compact_turn)

    # 验证紧随首条 User 消息
    assert selected[0] is turns[0]
    assert selected[1] is compact_turn
    assert "[历史执行过程无损结构化归档记忆库]" in selected[1].messages[0]["content"]


# ============================================================================
# 任务 4: 主循环支持运行中实时插话 (Mid-task Steering)
# ============================================================================

@pytest.mark.anyio
async def test_mid_task_steering_queue():
    """验证会话运行态管理器在任务执行期间支持实时插话并注入队列"""
    service = ChatService()
    user_id = "test_user_steer"
    session_id = str(uuid.uuid4())

    # 1. 未运行前，插话失败返回 False
    assert service.is_task_running(user_id, session_id) is False
    assert service.add_steering_message(user_id, session_id, "优先处理前端") is False

    # 2. 模拟任务运行中
    mock_task = asyncio.create_task(asyncio.sleep(0.5))
    service.register_task(user_id, session_id, mock_task)
    q: asyncio.Queue[str] = asyncio.Queue()
    service._steering_queues[service._task_key(user_id, session_id)] = q

    assert service.is_task_running(user_id, session_id) is True
    # 3. 投递实时插话
    assert service.add_steering_message(user_id, session_id, "优先处理前端UI") is True
    assert service.add_steering_message(user_id, session_id, "跳过后台脚本") is True

    # 4. 队列取出
    msg1 = q.get_nowait()
    msg2 = q.get_nowait()
    assert msg1 == "优先处理前端UI"
    assert msg2 == "跳过后台脚本"

    service.unregister_task(user_id, session_id)
    service._steering_queues.pop(service._task_key(user_id, session_id), None)
    await mock_task


# ============================================================================
# 任务 5: 前端预览错误探针注入 (genesis-preview-bridge)
# ============================================================================

def test_inject_preview_bridge_into_head():
    """验证向标准 HTML <head> 注入拦截脚本"""
    html = "<!DOCTYPE html><html><head><title>Test</title></head><body>Hello</body></html>"
    injected = inject_preview_bridge(html)

    assert '__genesis_preview_bridge__' in injected
    assert 'window.addEventListener(\'error\'' in injected
    assert 'unhandledrejection' in injected
    assert 'console.error' in injected
    assert 'source: \'genesis-preview-bridge\'' in injected

    # 验证不重复注入
    double_injected = inject_preview_bridge(injected)
    assert double_injected.count("__genesis_preview_bridge__") == 1


def test_inject_preview_bridge_fallback_no_head():
    """验证无 head 标签时的自适应包裹注入"""
    html = "<html><body><h1>Direct Content</h1></body></html>"
    injected = inject_preview_bridge(html)
    assert "__genesis_preview_bridge__" in injected
    assert "Direct Content" in injected


def test_workspace_executor_auto_injects_index_html(temp_ws):
    """验证 WorkspaceToolExecutor 写入 index.html 时自动注入探针脚本"""
    raw_html = "<!DOCTYPE html><html><head></head><body><h1>My Page</h1></body></html>"
    res = WorkspaceToolExecutor.write_file(temp_ws, "index.html", raw_html)
    assert res["success"] is True

    saved = Path(temp_ws, "index.html").read_text(encoding="utf-8")
    assert "__genesis_preview_bridge__" in saved
    assert "genesis-preview-bridge" in saved


def test_preview_api_endpoint(temp_ws):
    """验证后端预览路由对静态 HTML 文件响应时探针注入"""
    WorkspaceToolExecutor.write_file(temp_ws, "index.html", "<html><head></head><body>App</body></html>")
    os.environ["WORKSPACE_ROOT"] = temp_ws

    client = TestClient(app)
    resp = client.get("/api/preview/index.html")
    assert resp.status_code == 200
    assert "__genesis_preview_bridge__" in resp.text
    assert "genesis-preview-bridge" in resp.text


# ============================================================================
# 第四阶段高阶边界与深度防御测试
# ============================================================================

@pytest.mark.anyio
async def test_subagent_unprefixed_tool_name_supported(temp_ws):
    """验证 Subagent 接收到不带 workspace__ 前缀的标准工具名时可正常执行且不误报权限拒绝"""
    WorkspaceToolExecutor.write_file(temp_ws, "readme.md", "# Genesis Project Documentation")
    mock_llm = MockLLMAdapter(
        responses=[
            [
                StreamChunk(
                    type="tool_finish",
                    tool_call_id="call_unprefixed",
                    tool_name="read_file",
                    arguments={"path": "readme.md"},
                ),
                StreamChunk(type="finish", finish_reason="tool_calls"),
            ],
            [
                StreamChunk(type="text", text="文档查阅完毕，项目名称为 Genesis。"),
                StreamChunk(type="finish", finish_reason="stop"),
            ],
        ]
    )
    runner = SubagentRunner(llm=mock_llm)
    final_res = None
    async for c in runner.run(temp_ws, "explore", "阅读 readme.md", "gpt-4o"):
        if c["type"] == "result":
            final_res = c["data"]

    assert final_res is not None
    assert final_res["success"] is True
    assert "文档查阅完毕" in final_res["summary"]


def test_subagent_filter_allowed_tools_defaults_to_explore():
    """验证异常或未知 agent_type 严格兜底为只读探索模式，防止越权执行命令"""
    runner = SubagentRunner()
    tools = runner._filter_allowed_tools("unknown_type")
    names = {t["function"]["name"] for t in tools}
    assert "workspace__execute_command" not in names
    assert names == runner.EXPLORE_ALLOWED_TOOLS


def test_todo_manager_string_json_parsing_and_db_recovery():
    """验证 TodoManager 支持字符串形式的 JSON 解析并可在清空内存后从 SQLite 恢复"""
    sid = f"sess_todo_recover_{uuid.uuid4().hex[:8]}"
    raw_str = json.dumps([
        {"id": "t1", "content": "任务1", "status": "in_progress"},
        {"id": "t2", "content": "任务2", "status": "pending"},
    ])
    TodoManager.set_todos(sid, raw_str)
    assert TodoManager.has_unfinished_todos(sid) is True

    # 模拟写入消息到 SQLite
    from core.sqlite_db import get_db_connection
    from datetime import datetime, timezone
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO messages (id, session_id, user_id, role, raw_tool_calls, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                sid,
                "user_test",
                "assistant",
                json.dumps([{"name": "workspace__todo_write", "arguments": raw_str}]),
                datetime.now(timezone.utc).isoformat(),
            )
        )
        conn.commit()

    # 模拟后端重启：清空内存
    TodoManager.clear_todos(sid)
    assert sid not in TodoManager._session_todos

    # 再次查询自动触发 SQLite 恢复
    recovered = TodoManager.get_todos(sid)
    assert len(recovered) == 2
    assert recovered[0]["id"] == "t1"
    assert recovered[0]["status"] == "in_progress"

    TodoManager.clear_todos(sid)


def test_auto_compact_includes_todo_progress_and_inherits_prior():
    """验证 Auto-Compact 在 fallback 生成摘要时显式包含待办进度并继承前序摘要文件与报错"""
    sid = "sess_compact_todo_test"
    TodoManager.set_todos(sid, [
        {"id": "step-A", "content": "梳理架构", "status": "completed"},
        {"id": "step-B", "content": "编写核心逻辑", "status": "in_progress"},
    ])

    ctx_mgr = ContextManager()
    pruned = [
        # 前序旧 compact 摘要
        AtomicTurn(
            role="assistant",
            messages=[
                {
                    "role": "assistant",
                    "content": (
                        "[历史执行过程无损结构化归档记忆库]\n<compact_summary>\n"
                        "[已修改文件与变更摘要]\n- config.json (write_file)\n\n"
                        "[已解决与未解决的报错]\n- TypeError: NoneType is not callable\n\n"
                        "[核心上下文约束与待办进度]\n- 必须兼容 Python 3.12\n"
                        "</compact_summary>"
                    ),
                }
            ],
        ),
        # 本轮淘汰包含新文件操作
        AtomicTurn(
            role="assistant",
            messages=[
                {
                    "role": "assistant",
                    "content": "修改 app.py",
                    "tool_calls": [
                        {"id": "tc10", "function": {"name": "workspace__edit_file", "arguments": '{"path": "app.py"}'}}
                    ],
                },
                {"role": "tool", "tool_call_id": "tc10", "content": '{"success": true}'},
            ],
        ),
    ]

    summary = ctx_mgr._extract_fallback_summary(pruned, session_id=sid)
    assert "config.json" in summary  # 继承了旧摘要
    assert "app.py" in summary        # 包含本轮新修改
    assert "TypeError" in summary     # 继承了旧报错
    assert "step-B" in summary        # 包含待办进度快照
    assert "[▶]" in summary

    TodoManager.clear_todos(sid)


@pytest.mark.anyio
async def test_mid_task_steering_during_text_streaming():
    """验证当模型处于纯文本流式输出阶段（无工具调用）时，实时插话不会被丢弃，而是自然转向下一步"""
    user_id = f"user_steer_{uuid.uuid4().hex[:6]}"
    session_id = f"sess_steer_{uuid.uuid4().hex[:6]}"

    # 第 1 轮返回纯文本（触发用户插话），第 2 轮针对插话进行回答
    mock_llm = MockLLMAdapter(
        responses=[
            [
                StreamChunk(type="text", text="第一阶段分析完成，准备开始写代码。"),
                StreamChunk(type="finish", finish_reason="stop"),
            ],
            [
                StreamChunk(type="text", text="已收到转向指令，立即转向优先编写前端组件。"),
                StreamChunk(type="finish", finish_reason="stop"),
            ],
        ]
    )
    service = ChatService(llm=mock_llm)
    async def _mock_title(*args, **kwargs):
        return "代码分析"
    service.generate_session_title = _mock_title
    req = ChatRequest(content="请开始分析代码库")

    stream = service.handle_stream(session_id=session_id, req=req, user_id=user_id, max_steps=5)

    events = []
    # 消费第 1 个 chunk
    first_chunk = await anext(stream)
    events.append(first_chunk)

    # 模拟用户在模型生成第 1 轮文本期间实时插话
    enqueued = service.add_steering_message(user_id, session_id, "插话指令：暂停后端，先写前端UI组件！")
    assert enqueued is True

    async for chunk in stream:
        events.append(chunk)

    # 验证 mid_task_steered 事件被发出且进入了第 2 步回复
    steered_event = next((e for e in events if "mid_task_steered" in e), None)
    assert steered_event is not None
    assert "先写前端UI组件" in steered_event

    text_deltas = [e for e in events if "text_delta" in e]
    all_text = "".join(text_deltas)
    assert "已收到转向指令" in all_text


def test_workspace_executor_edit_file_preserves_bridge_on_index_html(temp_ws):
    """验证 WorkspaceToolExecutor 先写入 index.html (带探针)，后续 edit_file 能正常穿透匹配并保留探针"""
    raw_html = "<!DOCTYPE html><html><head><title>Old Title</title></head><body>123</body></html>"
    w_res = WorkspaceToolExecutor.write_file(temp_ws, "index.html", raw_html)
    assert w_res["success"] is True

    # 验证自动注入了探针
    content_after_write = Path(temp_ws, "index.html").read_text(encoding="utf-8")
    assert "__genesis_preview_bridge__" in content_after_write

    # 对包含 <head> 的代码块进行局部替换（此时文件已被探针分割，测试穿透自愈匹配能力）
    e_res = WorkspaceToolExecutor.edit_file(
        temp_ws,
        "index.html",
        old_string="<head><title>Old Title</title></head>",
        new_string="<head><title>New Title</title></head>",
    )
    assert e_res["success"] is True

    content_after_edit = Path(temp_ws, "index.html").read_text(encoding="utf-8")
    assert "New Title" in content_after_edit
    assert "__genesis_preview_bridge__" in content_after_edit


def test_preview_api_session_scoped_and_nested_paths(temp_ws):
    """验证预览代理接口同时支持根目录文件、深层子目录资源及带 session_id 前缀的 URL"""
    WorkspaceToolExecutor.write_file(temp_ws, "index.html", "<html><head></head><body>Home</body></html>")
    WorkspaceToolExecutor.write_file(temp_ws, "css/theme.css", "body { background: #000; }")
    os.environ["WORKSPACE_ROOT"] = temp_ws

    client = TestClient(app)

    # 1. 直接访问根 index.html
    r1 = client.get("/api/preview/index.html")
    assert r1.status_code == 200
    assert "__genesis_preview_bridge__" in r1.text

    # 2. 访问多级子目录资源 css/theme.css
    r2 = client.get("/api/preview/css/theme.css")
    assert r2.status_code == 200
    assert "background: #000" in r2.text

    # 3. 访问带虚拟 session_id 前缀的 index.html
    sid = str(uuid.uuid4())
    r3 = client.get(f"/api/preview/{sid}/index.html")
    assert r3.status_code == 200
    assert "__genesis_preview_bridge__" in r3.text

    # 4. 访问带虚拟 session_id 前缀的子资源
    r4 = client.get(f"/api/preview/{sid}/css/theme.css")
    assert r4.status_code == 200
    assert "background: #000" in r4.text


@pytest.mark.anyio
async def test_auto_compact_role_alternation_bridge():
    """验证当旧轮次被裁剪且保留的最老轮次为 assistant 时，自动插入 user 桥接轮次避免连续两条 assistant 消息"""
    user_id = f"user_{uuid.uuid4().hex[:6]}"
    session_id = f"sess_{uuid.uuid4().hex[:6]}"

    from models.schemas.message import ToolCallItem
    msg_repo = MessageRepository()

    # 构造历史：第 1 条 user，接着被淘汰的多条，最后保留的是一条 assistant tool_calls 轮次
    first_user = await msg_repo.create(
        user_id, MessageCreate(session_id=session_id, role=MessageRole.USER, content="初始需求：请帮我构建系统架构")
    )
    # 中间可被淘汰的轮次
    for i in range(5):
        await msg_repo.create(
            user_id, MessageCreate(session_id=session_id, role=MessageRole.USER, content=f"过程步骤 {i}")
        )
        await msg_repo.create(
            user_id, MessageCreate(session_id=session_id, role=MessageRole.ASSISTANT, content=f"回答步骤 {i}")
        )

    # 紧随保留的一条 assistant 轮次
    asst_turn_msg = await msg_repo.create(
        user_id,
        MessageCreate(
            session_id=session_id,
            role=MessageRole.ASSISTANT,
            content="我正在继续调用工具...",
            raw_tool_calls=[ToolCallItem(id="tc_bridge", name="workspace__read_file", args={"path": "package.json"})],
        ),
    )
    await msg_repo.create(
        user_id,
        MessageCreate(
            session_id=session_id,
            role=MessageRole.TOOL,
            content='{"name": "test"}',
            tool_call_id="tc_bridge",
        ),
    )

    ctx_mgr = ContextManager()
    # 限制 context_window 迫使触发 Auto-Compact
    messages = await ctx_mgr.build_context(
        user_id=user_id,
        session_id=session_id,
        new_prompt="请汇报下一步",
        context_window=300,
    )

    # 验证 messages 中不存在连续两个 assistant 消息
    for idx in range(len(messages) - 1):
        m1 = messages[idx]
        m2 = messages[idx + 1]
        assert not (m1.get("role") == "assistant" and m2.get("role") == "assistant"), (
            f"发现连续 assistant 角色违规: index {idx} and {idx+1}"
        )


def test_todo_manager_polymorphic_and_auto_ids():
    """验证 TodoManager 面对缺失 id 或使用 task/title 替代 content 的入参能自愈补齐 id 并正确解析"""
    sid = "sess_polymorphic_todos"
    # 输入没有 id，且混用 title / task / string
    dirty_todos = [
        {"title": "第一步：初始化项目结构", "status": "completed"},
        {"task": "第二步：编写数据访问层", "status": "in_progress"},
        "第三步：编写自动化单元测试",
    ]
    TodoManager.set_todos(sid, dirty_todos)
    todos = TodoManager.get_todos(sid)

    assert len(todos) == 3
    assert todos[0]["id"] == "todo-1"
    assert todos[0]["content"] == "第一步：初始化项目结构"
    assert todos[0]["status"] == "completed"

    assert todos[1]["id"] == "todo-2"
    assert todos[1]["content"] == "第二步：编写数据访问层"
    assert todos[1]["status"] == "in_progress"

    assert todos[2]["id"] == "todo-3"
    assert todos[2]["content"] == "第三步：编写自动化单元测试"
    assert todos[2]["status"] == "pending"

    TodoManager.clear_todos(sid)


def test_preview_bridge_circular_json_and_asset_safety():
    """验证 PREVIEW_BRIDGE_SCRIPT 中针对循环引用与静态资源报错的保护逻辑已注入"""
    from services.preview_service import PREVIEW_BRIDGE_SCRIPT

    # 验证包含 try-catch 保护的 JSON.stringify 与资源加载判断
    assert "JSON.stringify" in PREVIEW_BRIDGE_SCRIPT
    assert "资源加载失败" in PREVIEW_BRIDGE_SCRIPT
    assert "catch" in PREVIEW_BRIDGE_SCRIPT


def test_preview_api_root_routes(temp_ws):
    """验证 GET /api/preview 和 GET /api/preview/ 能直接返回 index.html 且带探针"""
    WorkspaceToolExecutor.write_file(temp_ws, "index.html", "<html><head><title>Root</title></head><body>Root Page</body></html>")
    os.environ["WORKSPACE_ROOT"] = temp_ws

    client = TestClient(app)
    r_empty = client.get("/api/preview")
    assert r_empty.status_code == 200
    assert "Root Page" in r_empty.text
    assert "__genesis_preview_bridge__" in r_empty.text

    r_slash = client.get("/api/preview/")
    assert r_slash.status_code == 200
    assert "Root Page" in r_slash.text
    assert "__genesis_preview_bridge__" in r_slash.text

