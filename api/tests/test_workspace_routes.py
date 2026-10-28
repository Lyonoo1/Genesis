import pytest
from fastapi.testclient import TestClient
from main import app
from core.security import get_current_user, AuthenticatedUser
from services.workspace_tool_executor import WorkspaceToolExecutor
from pathlib import Path


def dummy_auth_user():
    return AuthenticatedUser(
        user_id="00000000-0000-0000-0000-000000000001",
        email="developer@genesis.local",
    )


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = dummy_auth_user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_resolve_safe_path_root_and_slashes(tmp_path):
    root = tmp_path
    child = root / "app" / "main.py"
    child.parent.mkdir(parents=True, exist_ok=True)
    child.write_text("print('hello')", encoding="utf-8")

    # 1. 相对路径
    p = WorkspaceToolExecutor.resolve_safe_path(str(root), "app/main.py")
    assert p == child

    # 2. 相对路径带前导 ./
    p2 = WorkspaceToolExecutor.resolve_safe_path(str(root), "./app/main.py")
    assert p2 == child

    # 3. 根目录自身
    p3 = WorkspaceToolExecutor.resolve_safe_path(str(root), ".")
    assert p3 == root

    # 4. 越权路径应被拦截
    with pytest.raises(PermissionError):
        WorkspaceToolExecutor.resolve_safe_path(str(root), "../outside.py")


def test_workspace_tree_and_file_endpoints(client, tmp_path, monkeypatch):
    test_dir = tmp_path / "test_workspace"
    test_dir.mkdir(parents=True, exist_ok=True)
    f1 = test_dir / "index.ts"
    f1.write_text("console.log('test');", encoding="utf-8")
    d1 = test_dir / "src"
    d1.mkdir()
    f2 = d1 / "util.py"
    f2.write_text("# python file", encoding="utf-8")

    monkeypatch.setenv("WORKSPACE_ROOT", str(test_dir))

    # 1. 获取目录树
    res = client.get("/api/workspace/tree")
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert len(data["tree"]) >= 2
    names = {n["name"] for n in data["tree"]}
    assert "index.ts" in names
    assert "src" in names

    # 2. 读取文件内容
    res_file = client.get("/api/workspace/file?path=index.ts")
    assert res_file.status_code == 200
    file_data = res_file.json()
    assert file_data["success"] is True
    assert file_data["content"] == "console.log('test');"

    # 3. 读取不存在的文件
    res_404 = client.get("/api/workspace/file?path=non_existent.ts")
    assert res_404.status_code == 404
