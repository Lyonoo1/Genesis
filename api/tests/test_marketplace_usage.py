import uuid
from datetime import datetime, timezone
from typing import Any, Optional
import pytest
from fastapi.testclient import TestClient

from main import app
from core.security import get_current_user, AuthenticatedUser
from services.usage_service import calculate_cost, UsageService
from repositories.usage_repository import UsageRepository
from repositories.plugin_repository import PluginRepository
from repositories.skill_repository import SkillRepository
from repositories.mcp_repository import McpRepository
from routers.marketplace import get_skill_repo, get_mcp_repo, get_plugin_repo
from routers.usage import get_usage_service
from models.schemas.usage import UsageLogCreate
from models.schemas.skill import SkillInstallRequest, SkillManifest
from models.schemas.mcp import McpServerCreate
from models.schemas.marketplace import PluginUploadDraft


TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


# ----------------------------------------------------------------------
# 1. 成本核算纯函数单测
# ----------------------------------------------------------------------


def test_calculate_cost_precision():
    """测试多模型 Token 定价核算精度"""
    # 1. GPT-4o: 1M in ($2.50) + 1M out ($10.00) = $12.50
    cost_gpt4o = calculate_cost("gpt-4o", 1_000_000, 1_000_000)
    assert cost_gpt4o == 12.50

    # 2. Claude 3.5 Sonnet: 500k in ($1.50) + 100k out ($1.50) = $3.00
    cost_claude = calculate_cost("claude-3-5-sonnet-20241022", 500_000, 100_000)
    assert cost_claude == 3.00

    # 3. DeepSeek-chat: 1M in ($0.14) + 1M out ($0.28) = $0.42
    cost_deepseek = calculate_cost("deepseek-chat", 1_000_000, 1_000_000)
    assert cost_deepseek == 0.42


# ----------------------------------------------------------------------
# 2. 内存 Mock 仓储定义
# ----------------------------------------------------------------------


class InMemorySkillRepo(SkillRepository):
    def __init__(self):
        super().__init__(client=None)
        self.skills: dict[str, dict] = {}

    async def list_by_user(self, user_id: str):
        return [s for s in self.skills.values() if s["user_id"] == str(user_id)]

    async def get_by_name(self, user_id: str, name: str):
        for s in self.skills.values():
            if s["user_id"] == str(user_id) and s["name"] == name:
                return s
        return None

    async def install(self, user_id: str, skill_in: SkillInstallRequest):
        s_id = str(uuid.uuid4())
        record = {
            "id": s_id,
            "user_id": str(user_id),
            "name": skill_in.name,
            "version": skill_in.version,
            "storage_path": skill_in.storage_path,
            "manifest": skill_in.manifest.model_dump(),
            "auto_trigger": skill_in.auto_trigger,
            "installed_at": datetime.now(timezone.utc).isoformat(),
        }
        self.skills[s_id] = record
        return record

    async def delete(self, user_id: str, skill_id: uuid.UUID):
        s = self.skills.pop(str(skill_id), None)
        return s is not None


class InMemoryMcpRepo(McpRepository):
    def __init__(self):
        super().__init__(client=None)
        self.mcps: dict[str, dict] = {}

    async def list_by_user(self, user_id: str):
        return [m for m in self.mcps.values() if m["user_id"] == str(user_id)]

    async def get_by_name(self, user_id: str, name: str):
        for m in self.mcps.values():
            if m["user_id"] == str(user_id) and m["name"] == name:
                return m
        return None

    async def create(self, user_id: str, server_in: McpServerCreate, tools=None):
        m_id = str(uuid.uuid4())
        record = {
            "id": m_id,
            "user_id": str(user_id),
            "name": server_in.name,
            "connection_type": server_in.connection_type,
            "connection_config": {"endpoint": server_in.endpoint},
            "tools": tools or [],
            "enabled": server_in.enabled,
        }
        self.mcps[m_id] = record
        return record

    async def delete(self, user_id: str, server_id: uuid.UUID):
        m = self.mcps.pop(str(server_id), None)
        return m is not None


class InMemoryPluginRepo(PluginRepository):
    def __init__(self):
        super().__init__(client=None)
        self.plugins: list[dict] = []

    async def list_by_user(self, user_id: str):
        return [p for p in self.plugins if p["user_id"] == str(user_id)]

    async def create_draft(self, user_id: str, draft_in: PluginUploadDraft):
        p_id = str(uuid.uuid4())
        record = {
            "id": p_id,
            "user_id": str(user_id),
            "name": draft_in.name,
            "manifest": draft_in.manifest,
            "storage_path": draft_in.storage_path,
            "status": "draft",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self.plugins.append(record)
        return record


class InMemoryUsageRepo(UsageRepository):
    def __init__(self):
        super().__init__(client=None)
        self.logs: list[dict] = []

    async def create(self, user_id: str, usage_in: UsageLogCreate, cost_usd: float):
        u_id = str(uuid.uuid4())
        record = {
            "id": u_id,
            "user_id": str(user_id),
            "session_id": str(usage_in.session_id),
            "skill_id": str(usage_in.skill_id) if usage_in.skill_id else None,
            "model": usage_in.model,
            "input_tokens": usage_in.input_tokens,
            "output_tokens": usage_in.output_tokens,
            "cost_usd": cost_usd,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self.logs.append(record)
        return record

    async def list_by_user(self, user_id: str, limit: int = 500):
        return [l for l in self.logs if l["user_id"] == str(user_id)]


# ----------------------------------------------------------------------
# 3. REST 路由端到端单测
# ----------------------------------------------------------------------


@pytest.fixture
def marketplace_client():
    skill_repo = InMemorySkillRepo()
    mcp_repo = InMemoryMcpRepo()
    plugin_repo = InMemoryPluginRepo()
    usage_repo = InMemoryUsageRepo()
    u_service = UsageService(repo=usage_repo)

    async def mock_user():
        return AuthenticatedUser(user_id=TEST_USER_ID, email="test@example.com")

    app.dependency_overrides[get_current_user] = mock_user
    app.dependency_overrides[get_skill_repo] = lambda: skill_repo
    app.dependency_overrides[get_mcp_repo] = lambda: mcp_repo
    app.dependency_overrides[get_plugin_repo] = lambda: plugin_repo
    app.dependency_overrides[get_usage_service] = lambda: u_service

    with TestClient(app) as client:
        yield client, skill_repo, mcp_repo, plugin_repo, usage_repo, u_service

    app.dependency_overrides.clear()


def test_marketplace_plugins_list_and_install(marketplace_client):
    """测试市场浏览、分类检索与一键安装/卸载"""
    client, skill_repo, mcp_repo, plugin_repo, usage_repo, u_service = marketplace_client

    # 1. 列表获取
    res = client.get("/api/marketplace/plugins")
    assert res.status_code == 200
    plugins = res.json()
    assert len(plugins) >= 4
    assert any(p["id"] == "frontend-skill" for p in plugins)
    assert all(p["installed"] is False for p in plugins)

    # 2. 条件过滤: category="代码审查"
    res_filtered = client.get("/api/marketplace/plugins?category=代码审查")
    assert res_filtered.status_code == 200
    assert len(res_filtered.json()) == 1
    assert res_filtered.json()[0]["id"] == "code-review-pro"

    # 3. 安装 frontend-skill
    res_inst = client.post("/api/marketplace/install/frontend-skill")
    assert res_inst.status_code == 200
    assert res_inst.json()["success"] is True

    # 再次查询，frontend-skill 应变为 installed: True
    res_after = client.get("/api/marketplace/plugins")
    f_skill = next(p for p in res_after.json() if p["id"] == "frontend-skill")
    assert f_skill["installed"] is True

    # 4. 卸载 frontend-skill
    res_uninst = client.delete("/api/marketplace/uninstall/frontend-skill")
    assert res_uninst.status_code == 200
    assert res_uninst.json()["success"] is True

    # 卸载后恢复 installed: False
    res_restored = client.get("/api/marketplace/plugins")
    f_restored = next(p for p in res_restored.json() if p["id"] == "frontend-skill")
    assert f_restored["installed"] is False


def test_my_plugin_draft_upload(marketplace_client):
    """测试自研插件草稿保存与查询"""
    client, _, _, _, _, _ = marketplace_client

    payload = {
        "name": "my-custom-linter",
        "manifest": {"entrypoint": "main.py", "version": "0.1.0"},
        "storage_path": "drafts/my-linter.zip",
    }
    res = client.post("/api/marketplace/my-plugins/upload", json=payload)
    assert res.status_code == 201
    data = res.json()
    assert data["name"] == "my-custom-linter"
    assert data["status"] == "draft"

    # 查询列表
    res_list = client.get("/api/marketplace/my-plugins")
    assert res_list.status_code == 200
    assert len(res_list.json()) == 1
    assert res_list.json()[0]["name"] == "my-custom-linter"


@pytest.mark.anyio
async def test_usage_logging_and_summary(marketplace_client):
    """测试用量日志写入与按天聚合统计"""
    client, _, _, _, usage_repo, u_service = marketplace_client

    session_id = uuid.uuid4()
    skill_id = uuid.uuid4()

    # 模拟写入 2 笔对话用量
    await u_service.log_turn_usage(
        user_id=TEST_USER_ID,
        session_id=session_id,
        model="gpt-4o",
        input_tokens=1000,
        output_tokens=500,
        skill_id=skill_id,
    )
    await u_service.log_turn_usage(
        user_id=TEST_USER_ID,
        session_id=session_id,
        model="claude-3-5-sonnet-20241022",
        input_tokens=2000,
        output_tokens=1000,
    )

    # 通过 API 接口查询
    res = client.get("/api/usage/summary?range=month")
    assert res.status_code == 200
    summary = res.json()
    assert summary["total_input_tokens"] == 3000
    assert summary["total_output_tokens"] == 1500
    assert summary["total_cost_usd"] > 0
    assert len(summary["daily_points"]) >= 1
    assert len(summary["top_skills"]) >= 1
