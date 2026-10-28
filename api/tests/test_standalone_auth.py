import pytest
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_standalone_auth_flow():
    # 1. 登录默认开发账号
    res = client.post(
        "/api/auth/login",
        json={"account": "developer", "password": "developer"},
    )
    assert res.status_code == 200
    data = res.json()
    assert "access_token" in data
    token = data["access_token"]
    assert data["user"]["id"] == "00000000-0000-0000-0000-000000000001"

    # 2. 验证受保护的 /api/auth/me 端点
    me_res = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me_res.status_code == 200
    me_data = me_res.json()
    assert me_data["id"] == "00000000-0000-0000-0000-000000000001"
    assert me_data["standalone"] is True

    # 3. 错误密码拦截
    err_res = client.post(
        "/api/auth/login",
        json={"account": "unknown_user", "password": "wrongpassword123"},
    )
    assert err_res.status_code == 401
