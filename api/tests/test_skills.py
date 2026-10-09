import os
import sys
import tempfile
import uuid
import zipfile
import json
from datetime import datetime, timezone
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from main import app
from core.security import get_current_user, AuthenticatedUser
from core.exceptions import AppException, ErrorCode
from models.schemas.skill import SkillInstallRequest, SkillManifest
from plugins.sandbox.executor import SandboxExecutor
from repositories.skill_repository import SkillRepository
from routers.skills import get_skill_repository, get_skill_engine
from services.skill_engine import SkillEngine


TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


# ----------------------------------------------------------------------
# 1. 核心沙箱单测：环境变量脱敏白名单
# ----------------------------------------------------------------------


@pytest.mark.anyio
async def test_sandbox_env_isolation():
    """验证宿主进程中敏感环境变量绝对不会被泄露进沙箱子进程"""
    # 模拟宿主敏感环境变量
    os.environ["SUPABASE_KEY"] = "super-secret-supabase-token-12345"
    os.environ["JWT_SECRET"] = "super-secret-jwt-key-67890"

    with tempfile.TemporaryDirectory() as tmpdir:
        script_path = os.path.join(tmpdir, "main.py")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(
                """import os, json
supabase_key = os.environ.get("SUPABASE_KEY")
jwt_secret = os.environ.get("JWT_SECRET")
print(json.dumps({
    "supabase_key_leaked": supabase_key is not None,
    "jwt_secret_leaked": jwt_secret is not None,
    "has_path": "PATH" in os.environ
}))
"""
            )

        result = await SandboxExecutor.run_skill(
            entry_path=script_path,
            working_dir=tmpdir,
            input_args={},
            timeout=5,
        )

        assert result["supabase_key_leaked"] is False
        assert result["jwt_secret_leaked"] is False
        assert result["has_path"] is True


# ----------------------------------------------------------------------
# 2. 核心沙箱单测：超时进程树强杀与防僵尸孤儿进程
# ----------------------------------------------------------------------


@pytest.mark.anyio
async def test_sandbox_timeout_and_process_kill():
    """验证沙箱超时熔断机制，向进程组广播 SIGKILL 彻底消灭超时进程"""
    with tempfile.TemporaryDirectory() as tmpdir:
        script_path = os.path.join(tmpdir, "main.py")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(
                """import time, sys
# 故意沉睡 10 秒
time.sleep(10)
print('{"status": "done"}')
"""
            )

        with pytest.raises(AppException) as exc_info:
            await SandboxExecutor.run_skill(
                entry_path=script_path,
                working_dir=tmpdir,
                input_args={},
                timeout=1,
            )

        assert exc_info.value.code == ErrorCode.SKILL_TIMEOUT
        assert "超时" in exc_info.value.message


# ----------------------------------------------------------------------
# 3. 核心沙箱单测：标准输入 stdin 与标准输出 stdout 交互
# ----------------------------------------------------------------------


@pytest.mark.anyio
async def test_sandbox_stdin_stdout_execution():
    """测试通过 stdin 喂入参数并正确解析 stdout JSON 结果"""
    with tempfile.TemporaryDirectory() as tmpdir:
        script_path = os.path.join(tmpdir, "main.py")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(
                """import sys, json
data = json.loads(sys.stdin.read() or "{}")
x = data.get("x", 0)
y = data.get("y", 0)
print(json.dumps({"sum": x + y, "product": x * y}))
"""
            )

        result = await SandboxExecutor.run_skill(
            entry_path=script_path,
            working_dir=tmpdir,
            input_args={"x": 7, "y": 6},
            timeout=5,
        )

        assert result["sum"] == 13
        assert result["product"] == 42


# ----------------------------------------------------------------------
# 4. 核心沙箱单测：无状态容器缓存丢失后的自动解压自愈 (Self-Healing)
# ----------------------------------------------------------------------


@pytest.mark.anyio
async def test_skill_engine_self_healing():
    """验证当 /tmp 容器目录被清空时，SkillEngine 能够基于 storage_path 自动重新解压自愈"""
    with tempfile.TemporaryDirectory() as base_tmp:
        engine = SkillEngine(base_dir=base_tmp)

        # 1. 准备一个合法的 Skill 归档 zip 文件
        zip_storage_path = os.path.join(base_tmp, "test_skill.zip")
        with zipfile.ZipFile(zip_storage_path, "w") as zf:
            zf.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "name": "auto-healer",
                        "version": "1.0.0",
                        "entrypoint": "main.py",
                    }
                ),
            )
            zf.writestr(
                "main.py",
                """import json
print(json.dumps({"healed": True, "message": "self-healing verified"}))
""",
            )

        skill_id = str(uuid.uuid4())
        skill_data = {
            "id": skill_id,
            "name": "auto-healer",
            "version": "1.0.0",
            "storage_path": zip_storage_path,
            "manifest": {"entrypoint": "main.py"},
        }

        # 确保当前本地缓存目录不存在
        expected_dir = engine.get_skill_dir(skill_id)
        assert not os.path.exists(expected_dir)

        # 执行调用，触发自愈解压
        result = await engine.execute_skill(skill=skill_data, arguments={})
        assert result["healed"] is True
        assert result["message"] == "self-healing verified"

        # 验证本地已解压成功
        assert os.path.exists(os.path.join(expected_dir, "main.py"))

        # 清理沙箱测试
        engine.cleanup_sandbox(skill_id)
        assert not os.path.exists(expected_dir)


# ----------------------------------------------------------------------
# 5. REST 路由端到端单测 (FastAPI TestClient + InMemorySkillRepository)
# ----------------------------------------------------------------------


class InMemorySkillRepository(SkillRepository):
    def __init__(self):
        super().__init__(client=None)
        self.skills: dict[str, dict] = {}

    async def list_by_user(self, user_id: str):
        return [s for s in self.skills.values() if s["user_id"] == str(user_id)]

    async def get_by_id(self, user_id: str, skill_id: uuid.UUID):
        s = self.skills.get(str(skill_id))
        if s and s["user_id"] == str(user_id):
            return s
        return None

    async def get_by_name(self, user_id: str, name: str):
        for s in self.skills.values():
            if s["user_id"] == str(user_id) and s["name"] == name:
                return s
        return None

    async def install(self, user_id: str, skill_in: SkillInstallRequest):
        if await self.get_by_name(user_id, skill_in.name):
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"已安装同名技能 [{skill_in.name}]",
            )
        s_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        record = {
            "id": s_id,
            "user_id": str(user_id),
            "name": skill_in.name,
            "version": skill_in.version,
            "storage_path": skill_in.storage_path,
            "local_dir": None,
            "manifest": skill_in.manifest.model_dump(),
            "auto_trigger": skill_in.auto_trigger,
            "installed_at": now,
        }
        self.skills[s_id] = record
        return record

    async def update_auto_trigger(
        self, user_id: str, skill_id: uuid.UUID, auto_trigger: bool
    ):
        s = await self.get_by_id(user_id, skill_id)
        if not s:
            raise AppException(code=ErrorCode.NOT_FOUND, message="技能不存在")
        s["auto_trigger"] = auto_trigger
        return s

    async def delete(self, user_id: str, skill_id: uuid.UUID):
        s = await self.get_by_id(user_id, skill_id)
        if not s:
            raise AppException(code=ErrorCode.NOT_FOUND, message="技能不存在")
        del self.skills[str(skill_id)]
        return True


@pytest.fixture
def test_skill_client():
    in_memory_repo = InMemorySkillRepository()
    engine = SkillEngine()

    async def mock_current_user():
        return AuthenticatedUser(user_id=TEST_USER_ID, email="test@example.com")

    app.dependency_overrides[get_current_user] = mock_current_user
    app.dependency_overrides[get_skill_repository] = lambda: in_memory_repo
    app.dependency_overrides[get_skill_engine] = lambda: engine

    with TestClient(app) as client:
        yield client, in_memory_repo, engine

    app.dependency_overrides.clear()


def test_skills_rest_lifecycle(test_skill_client):
    """端到端测试 Skill 安装、列表查询、触发开关、调试执行与卸载"""
    client, repo, engine = test_skill_client

    # 1. 准备临时 zip 作为 storage_path
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tf:
        zip_path = tf.name

    try:
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "name": "code-formatter",
                        "version": "1.0.0",
                        "entrypoint": "main.py",
                    }
                ),
            )
            zf.writestr(
                "main.py",
                """import sys, json
data = json.loads(sys.stdin.read() or "{}")
print(json.dumps({"formatted": True, "text": data.get("text", "").strip()}))
""",
            )

        # 2. 安装技能 POST /api/skills/install
        install_payload = {
            "name": "code-formatter",
            "version": "1.0.0",
            "storage_path": zip_path,
            "manifest": {
                "name": "code-formatter",
                "version": "1.0.0",
                "entrypoint": "main.py",
                "permissions": ["exec:sandbox"],
                "parameters": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                },
            },
            "auto_trigger": True,
        }
        res = client.post("/api/skills/install", json=install_payload)
        assert res.status_code == 201
        data = res.json()
        skill_id = data["id"]
        assert data["name"] == "code-formatter"
        assert data["auto_trigger"] is True

        # 重复安装应报错
        res_dup = client.post("/api/skills/install", json=install_payload)
        assert res_dup.status_code == 400 or res_dup.status_code == 422
        assert "已安装同名技能" in res_dup.json()["error"]["message"]

        # 3. 列表查询 GET /api/skills
        res_list = client.get("/api/skills")
        assert res_list.status_code == 200
        assert len(res_list.json()) == 1

        # 4. 详情查询 GET /api/skills/{id}
        res_get = client.get(f"/api/skills/{skill_id}")
        assert res_get.status_code == 200
        assert res_get.json()["name"] == "code-formatter"

        # 5. 切换自动感知开关 PUT /api/skills/{id}/auto-trigger
        res_toggle = client.put(
            f"/api/skills/{skill_id}/auto-trigger", json={"auto_trigger": False}
        )
        assert res_toggle.status_code == 200
        assert res_toggle.json()["auto_trigger"] is False

        # 6. 沙箱执行 POST /api/skills/{id}/execute
        res_exec = client.post(
            f"/api/skills/{skill_id}/execute",
            json={"arguments": {"text": "   hello world   "}, "timeout": 10},
        )
        assert res_exec.status_code == 200
        exec_data = res_exec.json()
        assert exec_data["is_error"] is False
        assert exec_data["result"]["formatted"] is True
        assert exec_data["result"]["text"] == "hello world"
        assert exec_data["latency_ms"] is not None

        # 7. 卸载技能 DELETE /api/skills/{id}
        res_del = client.delete(f"/api/skills/{skill_id}")
        assert res_del.status_code == 200
        assert res_del.json()["success"] is True

        # 验证已删除
        res_after = client.get(f"/api/skills/{skill_id}")
        assert res_after.status_code == 404

    finally:
        if os.path.exists(zip_path):
            os.remove(zip_path)
