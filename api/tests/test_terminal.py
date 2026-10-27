import asyncio
import json
import os
import signal
import time
import pytest
from starlette.testclient import TestClient

from main import app
from services.terminal_manager import TerminalManager, TerminalSession


@pytest.fixture(autouse=True)
def cleanup_terminals():
    yield
    TerminalManager.get_instance().cleanup_all()


@pytest.mark.anyio
async def test_terminal_session_process_group_and_pty():
    """验证 TerminalSession 是否具备独立的进程组 (pgid == pid) 以及正常 PTY 收发与历史记录"""
    manager = TerminalManager.get_instance()
    session = manager.create_session(session_id="test-session-1", rows=24, cols=80)

    try:
        assert session.pid is not None
        assert session.is_alive() is True
        # 给子进程执行 os.setsid() 留出短暂调度时间
        await asyncio.sleep(0.1)
        # 验证 process group 隔离：子进程的 pgid 必须等于其 pid (os.setsid 产生新会话首进程)
        pgid = os.getpgid(session.pid)
        assert pgid == session.pid, f"PGID {pgid} should equal PID {session.pid}"

        # 验证终端 resize 无异常
        session.resize(rows=30, cols=100)

        # 写入一条测试指令
        session.write("echo GENESIS_TERMINAL_ONLINE\n")
        await asyncio.sleep(0.4)

        # 验证历史缓存记录了命令输出
        history = session.get_history_text()
        assert "GENESIS_TERMINAL_ONLINE" in history

    finally:
        session.terminate()
        assert session.is_alive() is False
        assert session.master_fd is None


@pytest.mark.anyio
async def test_terminal_session_eof_reader_cleanup():
    """验证子进程退出时 PTY reader 立即被移除，杜绝 100% CPU 忙循环"""
    manager = TerminalManager.get_instance()
    session = manager.create_session(session_id="test-session-eof", rows=24, cols=80)

    try:
        assert session.is_alive() is True
        assert session._reader_added is True

        # 向会话发送 exit 指令使子 Shell 自行退出
        session.write("exit\n")
        await asyncio.sleep(0.5)

        # 验证 reader 已被移除，防止 event loop 持续触发
        assert session._reader_added is False
        assert session.is_alive() is False

    finally:
        session.terminate()


def test_terminal_rest_apis():
    """测试终端 REST CRUD 管理接口"""
    client = TestClient(app)

    # 1. 创建终端会话
    create_res = client.post(
        "/api/terminal/sessions",
        json={"title": "Dev Server Terminal", "rows": 30, "cols": 100},
    )
    assert create_res.status_code == 201
    created_data = create_res.json()
    sid = created_data["id"]
    assert sid is not None
    assert created_data["title"] == "Dev Server Terminal"
    assert created_data["is_alive"] is True

    # 2. 列出终端列表
    list_res = client.get("/api/terminal/sessions")
    assert list_res.status_code == 200
    sessions = list_res.json()
    assert any(s["id"] == sid for s in sessions)

    # 3. 重启终端
    restart_res = client.post(f"/api/terminal/sessions/{sid}/restart")
    assert restart_res.status_code == 200
    restarted_data = restart_res.json()
    assert restarted_data["id"] == sid
    assert restarted_data["is_alive"] is True

    # 4. 删除终端
    del_res = client.delete(f"/api/terminal/sessions/{sid}")
    assert del_res.status_code == 200

    # 5. 再次列出，已不存在
    list_res_after = client.get("/api/terminal/sessions")
    assert not any(s["id"] == sid for s in list_res_after.json())


def test_terminal_websocket_bidirectional_and_persistence():
    """测试终端 WebSocket 双向数据流交互、历史回放持久化与重连"""
    client = TestClient(app)
    ws_sid = "test-ws-stream"

    # 1. 建立首次 WebSocket 连接
    with client.websocket_connect(f"/api/terminal/ws/{ws_sid}?rows=24&cols=80") as ws:
        # 发送 ping 探针
        ws.send_text(json.dumps({"type": "ping"}))
        pong_received = False
        start_t = time.time()
        while time.time() - start_t < 2.0:
            msg = json.loads(ws.receive_text())
            if msg.get("type") == "pong":
                pong_received = True
                break
        assert pong_received, "Should receive pong"

        # 发送输入执行命令
        ws.send_text(json.dumps({"type": "input", "data": "echo TEST_WS_STREAMING\n"}))
        found_output = False
        start_t = time.time()
        while time.time() - start_t < 3.0:
            msg = json.loads(ws.receive_text())
            if msg.get("type") == "output" and "TEST_WS_STREAMING" in msg.get("data", ""):
                found_output = True
                break
        assert found_output, "Should receive output containing command result"

        # 发送 resize
        ws.send_text(json.dumps({"type": "resize", "rows": 35, "cols": 120}))

    # 2. 模拟前端关闭抽屉或刷新页面（WebSocket 连接关闭）
    # 验证此时后端后台会话依然健在 (Session Persistence)
    manager = TerminalManager.get_instance()
    session = manager.get_session(ws_sid)
    assert session is not None
    assert session.is_alive() is True

    # 3. 再次重新连接同一个 session_id，验证历史回放立即触发
    with client.websocket_connect(f"/api/terminal/ws/{ws_sid}") as ws_reconnected:
        first_msg = json.loads(ws_reconnected.receive_text())
        assert first_msg.get("type") == "output"
        assert "TEST_WS_STREAMING" in first_msg.get("data", "")


@pytest.mark.anyio
async def test_terminal_process_group_kill_orphans():
    """验证杀死终端会话时能够联动终止其子进程树，杜绝孤儿进程占用端口"""
    manager = TerminalManager.get_instance()
    session = manager.create_session(session_id="test-orphan-kill", rows=24, cols=80)

    try:
        assert session.pid is not None
        child_pid = session.pid
        # 在该终端中启动一个后台进程
        session.write("sleep 50 &\n")
        await asyncio.sleep(0.3)

        # 终止整个会话
        session.terminate()
        await asyncio.sleep(0.2)

        # 验证子进程已被杀死且不可查
        assert session.is_alive() is False
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    finally:
        session.terminate()


def test_terminal_websocket_hot_restart():
    """验证热重启核心能力：已建立的 WebSocket 在热重启后连接不断开，且能无缝交互新 Shell"""
    client = TestClient(app)
    ws_sid = "test-hot-restart"

    with client.websocket_connect(f"/api/terminal/ws/{ws_sid}") as ws:
        # 1. 重启前执行命令
        ws.send_text(json.dumps({"type": "input", "data": "echo BEFORE_HOT_RESTART\n"}))
        found_before = False
        start_t = time.time()
        while time.time() - start_t < 3.0:
            msg = json.loads(ws.receive_text())
            if msg.get("type") == "output" and "BEFORE_HOT_RESTART" in msg.get("data", ""):
                found_before = True
                break
        assert found_before, "Should receive output before restart"

        # 2. 热重启会话 (通过 TerminalManager 驱动热重启，避免 Starlette 同线程 TestClient 嵌套死锁)
        manager = TerminalManager.get_instance()
        session = manager.restart_session(ws_sid)
        assert session.is_alive() is True

        # 3. 验证原 WebSocket 依然存活，并收到了重启提示
        found_restart_msg = False
        start_t = time.time()
        while time.time() - start_t < 3.0:
            msg = json.loads(ws.receive_text())
            if msg.get("type") == "output" and "终端会话已重新启动" in msg.get("data", ""):
                found_restart_msg = True
                break
        assert found_restart_msg, "Should receive restart notice over existing WebSocket"

        # 4. 在原连接上继续向新 Shell 发送命令，验证新 Shell 正常接收并执行
        ws.send_text(json.dumps({"type": "input", "data": "echo AFTER_HOT_RESTART\n"}))
        found_after = False
        start_t = time.time()
        while time.time() - start_t < 3.0:
            msg = json.loads(ws.receive_text())
            if msg.get("type") == "output" and "AFTER_HOT_RESTART" in msg.get("data", ""):
                found_after = True
                break
        assert found_after, "Existing WebSocket must seamlessly communicate with restarted shell!"


@pytest.mark.anyio
async def test_terminal_utf8_chinese_and_history_alignment():
    """验证终端多字节中文字符流式广播与环形缓存裁剪不会产生乱码 (\\ufffd)"""
    manager = TerminalManager.get_instance()
    session = manager.create_session(session_id="test-utf8-cn")

    try:
        chinese_phrase = "顶级架构师架构验证_中文编码测试"
        session.write(f"echo {chinese_phrase}\n")
        await asyncio.sleep(0.5)

        history = session.get_history_text()
        assert chinese_phrase in history
        assert "\ufffd" not in history

        # 边界防守：验证 resize 面对非法负数、超大整数和字符串时不崩溃
        session.resize(rows=-5, cols=999999)
        assert session.rows == 1
        assert session.cols == 1000

        session.resize(rows="30", cols="90")  # type: ignore
        assert session.rows == 30
        assert session.cols == 90
    finally:
        session.terminate()

