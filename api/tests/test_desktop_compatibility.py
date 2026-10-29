import os
import sys
from pathlib import Path
from fastapi.testclient import TestClient

from main import app, get_web_dist_path
from core.sqlite_db import _resolve_db_path
from services.terminal_manager import kill_process_group


def test_api_health_endpoint():
    """验证 /api/health 健康探针正常响应"""
    client = TestClient(app)
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "genesis-core-api"
    assert "version" in data


def test_genesis_data_dir_resolution(tmp_path, monkeypatch):
    """验证 GENESIS_DATA_DIR 能够动态重定向数据库路径"""
    custom_dir = str(tmp_path / "custom_data")
    monkeypatch.setenv("GENESIS_DATA_DIR", custom_dir)
    monkeypatch.delenv("SQLITE_DB_PATH", raising=False)

    resolved = _resolve_db_path()
    assert resolved == Path(custom_dir) / "genesis.db"
    assert (Path(custom_dir)).is_dir()


def test_kill_process_group_posix_and_win(monkeypatch):
    """验证 kill_process_group 跨平台执行不会抛出异常"""
    # 模拟 Windows 分支
    monkeypatch.setattr("sys.platform", "win32")
    # 不存在进程时 taskkill 内部捕获异常不会抛崩
    kill_process_group(99999999)

    # 模拟 POSIX 分支
    monkeypatch.setattr("sys.platform", "darwin")
    kill_process_group(99999999)


def test_spa_static_serving(tmp_path, monkeypatch):
    """验证前端静态导出页面及 SPA 兜底逻辑"""
    # 模拟自定义静态目录
    mock_dist = tmp_path / "mock_web_dist"
    mock_dist.mkdir()
    (mock_dist / "index.html").write_text("<!doctype html><html><body>Index</body></html>", encoding="utf-8")
    (mock_dist / "settings.html").write_text("<!doctype html><html><body>Settings</body></html>", encoding="utf-8")
    mock_chat = mock_dist / "chat"
    mock_chat.mkdir()
    (mock_chat / "default.html").write_text("<!doctype html><html><body>Chat Default</body></html>", encoding="utf-8")

    monkeypatch.setenv("WEB_DIST_PATH", str(mock_dist))

    client = TestClient(app)
    # 检查静态资源挂载与请求
    res_root = client.get("/")
    assert res_root.status_code == 200
    assert "Index" in res_root.text

    # 检查 HTML 路由直接匹配
    res_settings = client.get("/settings")
    assert res_settings.status_code == 200
    assert "Settings" in res_settings.text

    # 检查动态聊天路由回退到 chat/default.html
    res_spa = client.get("/chat/test-session-123")
    assert res_spa.status_code == 200
    assert "Chat Default" in res_spa.text

    # 验证未注册的 API 路由严格返回 404，绝不被 SPA 兜底劫持
    res_api_404 = client.get("/api/nonexistent_route_probe")
    assert res_api_404.status_code == 404


def test_silent_login_endpoint():
    """验证桌面端静默免密登录接口正常分发 JWT 令牌"""
    client = TestClient(app)
    res = client.post("/api/auth/silent-login")
    assert res.status_code == 200
    data = res.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert data["user"]["id"] == "00000000-0000-0000-0000-000000000001"
    assert data["user"]["username"] == "developer"


def test_workspace_tree_limit_and_filter(tmp_path):
    """验证工作区树过滤二进制文件与节点深度上限"""
    from routers.workspace import build_file_tree

    ws_dir = tmp_path / "mock_workspace"
    ws_dir.mkdir()
    (ws_dir / "app.py").write_text("print('hello')", encoding="utf-8")
    (ws_dir / "compiled.pyc").write_bytes(b"\x00\x01\x02")
    (ws_dir / "library.dylib").write_bytes(b"\x00\x01\x02")
    sub_dir = ws_dir / "src"
    sub_dir.mkdir()
    (sub_dir / "index.ts").write_text("console.log('hi')", encoding="utf-8")

    tree = build_file_tree(ws_dir, ws_dir, max_depth=3, max_nodes=10)
    names = [node["name"] for node in tree]
    assert "app.py" in names
    assert "src" in names
    assert "compiled.pyc" not in names
    assert "library.dylib" not in names


def test_workspace_file_read_and_write(tmp_path, monkeypatch):
    """验证工作区文件读写 API 完整流程"""
    from routers.workspace import build_file_tree

    ws_dir = tmp_path / "rw_workspace"
    ws_dir.mkdir()
    monkeypatch.setenv("WORKSPACE_ROOT", str(ws_dir))

    client = TestClient(app)
    # 获取静默登录凭证
    login_res = client.post("/api/auth/silent-login")
    token = login_res.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # 1. 写入文件
    write_res = client.post(
        "/api/workspace/file",
        headers=headers,
        json={"path": "notes/todo.txt", "content": "hello desktop & web"},
    )
    assert write_res.status_code == 200
    assert write_res.json()["success"] is True

    # 2. 读取文件
    read_res = client.get(
        "/api/workspace/file?path=notes/todo.txt",
        headers=headers,
    )
    assert read_res.status_code == 200
    read_data = read_res.json()
    assert read_data["success"] is True
    assert read_data["content"] == "hello desktop & web"

