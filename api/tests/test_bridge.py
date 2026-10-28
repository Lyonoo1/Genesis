import pytest
from fastapi.testclient import TestClient
from main import app
from services.bridge_manager import BridgeManager

client = TestClient(app)


def test_bridge_status_unauthorized():
    """未登录请求 bridge status 应返回 401"""
    res = client.get("/api/bridge/status")
    assert res.status_code == 401


def test_bridge_manager_registration_and_state():
    """测试 BridgeManager 注册与注销单例逻辑"""
    manager = BridgeManager.get_instance()
    uid = "test-user-001"

    assert not manager.is_connected(uid)
    assert manager.get_metadata(uid) is None

    # 模拟伪连接注册
    mock_ws = object()
    metadata = {
        "hostname": "Test-MacBook",
        "platform": "darwin",
        "cwd": "/Users/test/project",
    }
    manager.register(uid, mock_ws, metadata)

    assert manager.is_connected(uid)
    meta = manager.get_metadata(uid)
    assert meta["hostname"] == "Test-MacBook"
    assert meta["cwd"] == "/Users/test/project"

    # 注销测试
    manager.unregister(uid)
    assert not manager.is_connected(uid)
    assert manager.get_metadata(uid) is None


def test_bridge_status_authenticated():
    from core.security import get_current_user, AuthenticatedUser

    mock_user = AuthenticatedUser(user_id="test-uid-auth", email="test@example.com")
    app.dependency_overrides[get_current_user] = lambda: mock_user

    try:
        manager = BridgeManager.get_instance()
        manager.register(
            "test-uid-auth",
            object(),
            {"hostname": "Auth-Mac", "platform": "darwin", "cwd": "/local/code"},
        )

        res = client.get("/api/bridge/status")
        assert res.status_code == 200
        data = res.json()
        assert data["connected"] is True
        assert data["metadata"]["hostname"] == "Auth-Mac"
        assert data["metadata"]["cwd"] == "/local/code"
    finally:
        manager.unregister("test-uid-auth")
        app.dependency_overrides.pop(get_current_user, None)

