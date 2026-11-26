import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from core.security import AuthenticatedUser, get_current_user
from core.workspace_guard import get_api_source_root, is_forbidden_workspace_path
from main import app
from services.chat_service import ChatService, chat_service
from services.terminal_manager import get_default_workspace


def dummy_auth_user():
    return AuthenticatedUser(
        user_id="prod-user-001",
        email="prod@genesis.local",
    )


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = dummy_auth_user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _mock_docker_prod_env(monkeypatch, tmp_path: Path, workspace_root: str | None = None):
    """模拟生产 Docker 容器环境（ENVIRONMENT=production 且存在 /.dockerenv）"""
    sandbox_dir = tmp_path / "sandboxes"
    sandbox_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("SANDBOX_TMP_DIR", str(sandbox_dir))
    if workspace_root is None:
        monkeypatch.delenv("WORKSPACE_ROOT", raising=False)
    else:
        monkeypatch.setenv("WORKSPACE_ROOT", workspace_root)

    orig_exists = os.path.exists

    def fake_exists(p):
        if str(p) in {"/.dockerenv", "/.containerenv"}:
            return True
        return orig_exists(p)

    monkeypatch.setattr(os.path, "exists", fake_exists)
    return sandbox_dir


@pytest.mark.anyio
async def test_prod_container_unbound_workspace_never_falls_back_to_app_or_source(
    monkeypatch, tmp_path
):
    """生产容器未绑项目、未连 Bridge、未设 WORKSPACE_ROOT 时绝不回退到 /app 或源码目录"""
    sandbox_dir = _mock_docker_prod_env(monkeypatch, tmp_path, workspace_root=None)
    api_root = get_api_source_root()

    svc = ChatService()
    svc.session_repo = MagicMock()
    svc.session_repo.get_by_id = AsyncMock(return_value=None)
    svc.project_repo = MagicMock()
    svc.project_repo.get_by_id = AsyncMock(return_value=None)

    info = await svc.resolve_workspace_info(user_id="user_alpha")
    resolved = Path(info["workspace_root"]).resolve()

    assert info["bound"] is False
    assert info["workspace_mode"] == "unbound"
    assert info["is_sandbox"] is True
    assert resolved != Path("/app")
    assert resolved != Path("/")
    assert resolved != api_root
    assert not resolved.is_relative_to(api_root)
    assert resolved.is_relative_to(sandbox_dir.resolve() / "workspaces")
    assert resolved.name == "user_alpha"
    assert resolved.is_dir()

    # 不同用户隔离到独立沙箱目录
    info_b = await svc.resolve_workspace_info(user_id="user_beta")
    assert Path(info_b["workspace_root"]).resolve() != resolved
    assert Path(info_b["workspace_root"]).resolve().name == "user_beta"


def test_prod_workspace_tree_and_file_block_source_code_leak(
    client, monkeypatch, tmp_path
):
    """生产未绑定工作区时 /api/workspace/tree 与 /file 均绝不暴露后端源码"""
    _mock_docker_prod_env(monkeypatch, tmp_path, workspace_root=None)
    monkeypatch.setattr(chat_service.session_repo, "get_by_id", AsyncMock(return_value=None))
    monkeypatch.setattr(chat_service.project_repo, "get_by_id", AsyncMock(return_value=None))

    tree_res = client.get("/api/workspace/tree")
    assert tree_res.status_code == 200
    data = tree_res.json()
    assert data["success"] is True
    assert data["bound"] is False
    assert data["workspace_mode"] == "unbound"
    assert data["workspace_root"] == ""
    assert data["name"] == ""
    assert data["tree"] == []

    # 尝试直接或穿越读取后端源码文件，必须被拒绝或找不到
    for rel_path in ["main.py", "core/config.py", "routers/workspace.py"]:
        res_missing = client.get(f"/api/workspace/file?path={rel_path}")
        assert res_missing.status_code == 404

    api_root = get_api_source_root()
    for escape_path in [
        "../../../../app/main.py",
        "../../../core/config.py",
        "/app/main.py",
        str(api_root / "main.py"),
        str(api_root / "core" / "config.py"),
    ]:
        res_escape = client.get(f"/api/workspace/file?path={escape_path}")
        assert res_escape.status_code == 403


@pytest.mark.anyio
async def test_prod_sandbox_workspace_root_env_isolates_per_user(monkeypatch, tmp_path):
    """docker-compose.prod.yml 配置 WORKSPACE_ROOT 为沙箱基目录时按用户隔离且标记 unbound"""
    sandbox_dir = _mock_docker_prod_env(
        monkeypatch,
        tmp_path,
        workspace_root=str(tmp_path / "sandboxes" / "workspaces"),
    )
    svc = ChatService()
    svc.session_repo = MagicMock()
    svc.session_repo.get_by_id = AsyncMock(return_value=None)
    svc.project_repo = MagicMock()
    svc.project_repo.get_by_id = AsyncMock(return_value=None)

    info = await svc.resolve_workspace_info(user_id="../evil/user")
    resolved = Path(info["workspace_root"]).resolve()
    assert info["bound"] is False
    assert info["workspace_mode"] == "unbound"
    assert resolved.is_relative_to(sandbox_dir.resolve() / "workspaces")
    assert ".." not in resolved.parts


@pytest.mark.anyio
async def test_forbidden_workspace_root_and_explicit_path_blocked(monkeypatch, tmp_path):
    """即使错误配置 WORKSPACE_ROOT=/app 或传入源码目录作 explicit_path，也必须被拦截"""
    api_root = get_api_source_root()
    sandbox_dir = _mock_docker_prod_env(
        monkeypatch, tmp_path, workspace_root=str(api_root)
    )
    svc = ChatService()
    svc.session_repo = MagicMock()
    svc.session_repo.get_by_id = AsyncMock(return_value=None)
    svc.project_repo = MagicMock()
    svc.project_repo.get_by_id = AsyncMock(return_value=None)

    assert is_forbidden_workspace_path("/app") is True
    assert is_forbidden_workspace_path(str(api_root)) is True
    assert is_forbidden_workspace_path("/") is True

    root_res = await svc.resolve_workspace_root(
        user_id="user_01",
        explicit_path=str(api_root),
    )
    assert Path(root_res).resolve().is_relative_to(sandbox_dir.resolve() / "workspaces")


def test_preview_and_terminal_block_source_fallback_in_prod(client, monkeypatch, tmp_path):
    """验证 /api/preview 与终端默认目录在生产容器环境下绝不暴露后端源码"""
    sandbox_dir = _mock_docker_prod_env(monkeypatch, tmp_path, workspace_root=None)
    api_root = get_api_source_root()

    # 终端默认工作目录应落在沙箱内，绝非 /app 或 api 源码根目录
    term_ws = Path(get_default_workspace(user_id="term-user")).resolve()
    assert term_ws != api_root
    assert term_ws != Path("/app")
    assert term_ws.is_relative_to(sandbox_dir.resolve() / "workspaces")

    # 预览接口禁止通过 ?workspace=<api_root> 或默认路径读取后端源码
    res_default = client.get("/api/preview/core/config.py")
    assert res_default.status_code in (403, 404)

    res_override = client.get(f"/api/preview/core/config.py?workspace={api_root}")
    assert res_override.status_code in (403, 404)


@pytest.mark.anyio
async def test_desktop_project_binding_and_bridge_preserved(monkeypatch, tmp_path):
    """验证桌面端有效项目路径绑定与 Local Bridge 隧道模式在生产模式下仍正常工作"""
    _mock_docker_prod_env(monkeypatch, tmp_path, workspace_root=None)
    desktop_project_dir = tmp_path / "my_desktop_project"
    desktop_project_dir.mkdir(parents=True)
    (desktop_project_dir / "README.md").write_text("# Demo", encoding="utf-8")

    svc = ChatService()
    svc.session_repo = MagicMock()
    svc.session_repo.get_by_id = AsyncMock(return_value={"id": "s1", "project_id": "p1"})
    svc.project_repo = MagicMock()
    svc.project_repo.get_by_id = AsyncMock(
        return_value={"id": "p1", "name": "demo", "folder_path": str(desktop_project_dir)}
    )

    info = await svc.resolve_workspace_info(user_id="desktop-user", session_id="s1")
    assert info["bound"] is True
    assert info["workspace_mode"] == "project"
    assert Path(info["workspace_root"]).resolve() == desktop_project_dir.resolve()

    # 验证 Bridge 连接优先级
    from services.bridge_manager import BridgeManager

    bridge = BridgeManager.get_instance()
    monkeypatch.setattr(bridge, "is_connected", lambda uid: uid == "bridge-user")
    monkeypatch.setattr(bridge, "get_metadata", lambda uid: {"cwd": "/Users/dev/app"})
    bridge_info = await svc.resolve_workspace_info(user_id="bridge-user")
    assert bridge_info["bound"] is True
    assert bridge_info["workspace_mode"] == "bridge"
    assert bridge_info["workspace_root"] == "bridge://bridge-user::/Users/dev/app"
