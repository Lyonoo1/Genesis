import uuid
from datetime import datetime, timezone, timedelta
import pytest
from fastapi.testclient import TestClient

from main import app
from core.security import get_current_user, AuthenticatedUser
from routers.sessions import get_session_repo, get_message_repo
from repositories.session_repository import SessionRepository
from repositories.message_repository import MessageRepository
from models.schemas.session import SessionCreate, SessionUpdate, CapabilityItem
from models.schemas.message import MessageCreate, MessageRole, MessageStatus


# ----------------------------------------------------------------------
# 内存模拟仓储，完全脱机执行端到端路由与状态机测试
# ----------------------------------------------------------------------


class InMemorySessionRepository(SessionRepository):
    def __init__(self):
        super().__init__(client=None)
        self.sessions: dict[str, dict] = {}
        self.capabilities: dict[str, dict] = {}

    async def list_by_user(self, user_id: str):
        items = [s for s in self.sessions.values() if s["user_id"] == str(user_id)]
        items.sort(key=lambda x: (1 if x["pinned"] else 0, x["updated_at"]), reverse=True)
        return items

    async def get_by_id(self, user_id: str, session_id: uuid.UUID):
        s = self.sessions.get(str(session_id))
        if s and s["user_id"] == str(user_id):
            return s
        return None

    async def create(self, user_id: str, session_in: SessionCreate):
        s_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        session = {
            "id": s_id,
            "user_id": str(user_id),
            "title": session_in.title or "新对话",
            "pinned": False,
            "created_at": now,
            "updated_at": now,
        }
        self.sessions[s_id] = session
        return session

    async def update(self, user_id: str, session_id: uuid.UUID, session_in: SessionUpdate):
        session = await self.get_by_id(user_id, session_id)
        if not session:
            from core.exceptions import AppException, ErrorCode
            raise AppException(code=ErrorCode.SESSION_NOT_FOUND, message="目标会话不存在", status_code=404)
        
        if session_in.title is not None:
            session["title"] = session_in.title
        if session_in.pinned is not None:
            session["pinned"] = session_in.pinned
        session["updated_at"] = datetime.now(timezone.utc).isoformat()
        return session

    async def delete(self, user_id: str, session_id: uuid.UUID):
        session = await self.get_by_id(user_id, session_id)
        if not session:
            from core.exceptions import AppException, ErrorCode
            raise AppException(code=ErrorCode.SESSION_NOT_FOUND, message="目标会话不存在", status_code=404)
        del self.sessions[str(session_id)]
        return True

    async def get_capabilities(self, user_id: str, session_id: uuid.UUID):
        await self.get_by_id(user_id, session_id)
        return [
            cap for (s_id, _, _), cap in self.capabilities.items()
            if s_id == str(session_id)
        ]

    async def update_capabilities(self, user_id: str, session_id: uuid.UUID, capabilities: list[CapabilityItem]):
        await self.get_by_id(user_id, session_id)
        results = []
        for cap in capabilities:
            key = (str(session_id), cap.capability_type, str(cap.capability_id))
            val = {
                "session_id": str(session_id),
                "capability_type": cap.capability_type,
                "capability_id": str(cap.capability_id),
                "enabled": cap.enabled,
            }
            self.capabilities[key] = val
            results.append(val)
        return results


class InMemoryMessageRepository(MessageRepository):
    def __init__(self, session_repo: InMemorySessionRepository):
        super().__init__(client=None)
        self.session_repo = session_repo
        self.messages: dict[str, dict] = {}

    async def list_by_session(self, session_id: uuid.UUID, user_id: str, limit: int = 20, cursor: str = None):
        items = [
            m for m in self.messages.values()
            if m["session_id"] == str(session_id) and m["user_id"] == str(user_id)
        ]
        if cursor:
            items = [m for m in items if m["created_at"] < cursor]
        
        items.sort(key=lambda x: x["created_at"], reverse=True)
        has_more = len(items) > limit
        sliced = items[:limit]
        next_cursor = sliced[-1]["created_at"] if has_more and sliced else None
        
        sliced.reverse()
        return sliced, next_cursor, has_more

    async def create(self, user_id: str, message_in: MessageCreate):
        m_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        msg = {
            "id": m_id,
            "session_id": str(message_in.session_id),
            "user_id": str(user_id),
            "role": message_in.role.value if hasattr(message_in.role, "value") else str(message_in.role),
            "content": message_in.content,
            "parent_id": str(message_in.parent_id) if message_in.parent_id else None,
            "raw_tool_calls": [t.model_dump() for t in message_in.raw_tool_calls] if message_in.raw_tool_calls else None,
            "tool_call_id": message_in.tool_call_id,
            "active_skill_id": str(message_in.active_skill_id) if message_in.active_skill_id else None,
            "status": message_in.status.value if hasattr(message_in.status, "value") else str(message_in.status),
            "created_at": now,
        }
        self.messages[m_id] = msg
        if str(message_in.session_id) in self.session_repo.sessions:
            self.session_repo.sessions[str(message_in.session_id)]["updated_at"] = now
        return msg

    async def prune_branch(self, session_id: uuid.UUID, user_id: str, parent_id: uuid.UUID):
        parent_msg = self.messages.get(str(parent_id))
        if not parent_msg or parent_msg["session_id"] != str(session_id) or parent_msg["user_id"] != str(user_id):
            from core.exceptions import AppException, ErrorCode
            raise AppException(code=ErrorCode.NOT_FOUND, message="父节点消息不存在", status_code=404)
        
        parent_time = parent_msg["created_at"]
        to_delete = [
            m_id for m_id, m in self.messages.items()
            if m["session_id"] == str(session_id) and m["user_id"] == str(user_id) and m["created_at"] > parent_time
        ]
        for m_id in to_delete:
            del self.messages[m_id]
        return len(to_delete)


# ----------------------------------------------------------------------
# 测试用例
# ----------------------------------------------------------------------

test_user = AuthenticatedUser(user_id="user_test_001", email="test@genesis.ai")
other_user = AuthenticatedUser(user_id="user_test_002", email="other@genesis.ai")

current_mock_user = test_user


def override_get_current_user():
    return current_mock_user


@pytest.fixture(autouse=True)
def setup_test_app():
    mock_session_repo = InMemorySessionRepository()
    mock_message_repo = InMemoryMessageRepository(mock_session_repo)

    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[get_session_repo] = lambda: mock_session_repo
    app.dependency_overrides[get_message_repo] = lambda: mock_message_repo

    yield mock_session_repo, mock_message_repo

    app.dependency_overrides.clear()


def test_session_lifecycle(setup_test_app):
    client = TestClient(app)
    mock_session_repo, _ = setup_test_app

    # 1. 初始列表为空
    res = client.get("/api/sessions")
    assert res.status_code == 200
    assert res.json() == []

    # 2. 创建第一个会话（默认标题）
    res = client.post("/api/sessions", json={})
    assert res.status_code == 201
    s1 = res.json()
    assert s1["title"] == "新对话"
    assert s1["pinned"] is False
    s1_id = s1["id"]

    # 3. 创建第二个会话（自定义标题）
    res = client.post("/api/sessions", json={"title": "架构研讨"})
    assert res.status_code == 201
    s2 = res.json()
    assert s2["title"] == "架构研讨"
    s2_id = s2["id"]

    # 4. 置顶 s1，验证列表排序：s1 必须排在首位
    res = client.patch(f"/api/sessions/{s1_id}", json={"pinned": True, "title": "【置顶】核心设计"})
    assert res.status_code == 200
    assert res.json()["pinned"] is True
    assert res.json()["title"] == "【置顶】核心设计"

    res = client.get("/api/sessions")
    sessions = res.json()
    assert len(sessions) == 2
    assert sessions[0]["id"] == s1_id
    assert sessions[1]["id"] == s2_id

    # 5. 删除会话 s2
    res = client.delete(f"/api/sessions/{s2_id}")
    assert res.status_code == 200
    assert res.json()["success"] is True

    res = client.get("/api/sessions")
    assert len(res.json()) == 1
    assert res.json()[0]["id"] == s1_id


def test_messages_cursor_pagination_and_pruning(setup_test_app):
    client = TestClient(app)
    mock_session_repo, mock_message_repo = setup_test_app

    # 1. 创建会话
    res = client.post("/api/sessions", json={"title": "对话测试"})
    session_id = res.json()["id"]

    # 2. 连续插入 4 条消息 (t0 < t1 < t2 < t3)
    base_time = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)
    m_ids = []
    for i in range(4):
        m_id = str(uuid.uuid4())
        m_ids.append(m_id)
        created_time = (base_time + timedelta(seconds=i * 10)).isoformat()
        mock_message_repo.messages[m_id] = {
            "id": m_id,
            "session_id": session_id,
            "user_id": test_user.id,
            "role": "user" if i % 2 == 0 else "assistant",
            "content": f"Message {i}",
            "parent_id": m_ids[i - 1] if i > 0 else None,
            "raw_tool_calls": None,
            "tool_call_id": None,
            "active_skill_id": None,
            "status": "success",
            "created_at": created_time,
        }

    # 3. 分页拉取：limit=2，拉取最新 2 条 (Message 2, Message 3)
    res = client.get(f"/api/chat/{session_id}/messages?limit=2")
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 2
    assert data["items"][0]["content"] == "Message 2"
    assert data["items"][1]["content"] == "Message 3"
    assert data["has_more"] is True
    assert data["next_cursor"] is not None

    # 4. 利用 next_cursor 翻页拉取早前 2 条 (Message 0, Message 1)
    cursor = data["next_cursor"]
    res2 = client.get(f"/api/chat/{session_id}/messages?limit=2&cursor={cursor}")
    assert res2.status_code == 200
    data2 = res2.json()
    assert len(data2["items"]) == 2
    assert data2["items"][0]["content"] == "Message 0"
    assert data2["items"][1]["content"] == "Message 1"
    assert data2["has_more"] is False

    # 5. 分支修剪 (Branch Pruning): 从 Message 1 (m_ids[1]) 重新编辑分支
    # 修剪晚于 Message 1 的记录，Message 2 和 Message 3 应当被删除
    res_prune = client.post(
        f"/api/chat/{session_id}/messages/prune",
        json={"parent_id": m_ids[1]},
    )
    assert res_prune.status_code == 200
    assert res_prune.json()["pruned_count"] == 2

    # 再次拉取全量消息，仅剩 Message 0 与 Message 1
    res_after = client.get(f"/api/chat/{session_id}/messages?limit=10")
    items_after = res_after.json()["items"]
    assert len(items_after) == 2
    assert items_after[0]["id"] == m_ids[0]
    assert items_after[1]["id"] == m_ids[1]


def test_session_capabilities(setup_test_app):
    client = TestClient(app)

    # 1. 创建会话
    res = client.post("/api/sessions", json={"title": "能力配置测试"})
    session_id = res.json()["id"]

    skill_id = str(uuid.uuid4())
    mcp_id = str(uuid.uuid4())

    # 2. 批量设置能力开关
    res = client.put(
        f"/api/chat/{session_id}/capabilities",
        json={
            "capabilities": [
                {"capability_type": "skill", "capability_id": skill_id, "enabled": True},
                {"capability_type": "mcp", "capability_id": mcp_id, "enabled": False},
            ]
        },
    )
    assert res.status_code == 200
    caps = res.json()["capabilities"]
    assert len(caps) == 2

    # 3. 查询能力开关
    res = client.get(f"/api/chat/{session_id}/capabilities")
    assert res.status_code == 200
    query_caps = res.json()["capabilities"]
    assert len(query_caps) == 2


def test_unauthorized_endpoints():
    """测试不带 Token 访问受保护接口必须返回统一 401 错误结构"""
    # 移除依赖重写以走原生 get_current_user 逻辑
    app.dependency_overrides.pop(get_current_user, None)
    client = TestClient(app)

    res = client.get("/api/sessions")
    assert res.status_code == 401
    err = res.json()["error"]
    assert err["code"] == "UNAUTHORIZED"
    assert "未提供有效的认证凭证" in err["message"]


def test_cross_user_isolation(setup_test_app):
    """测试多用户间数据隔离（用户 B 无法篡改或读取用户 A 的会话）"""
    client = TestClient(app)
    global current_mock_user

    # 用户 A 创建会话
    current_mock_user = test_user
    res = client.post("/api/sessions", json={"title": "用户 A 的机密会话"})
    assert res.status_code == 201
    user_a_session_id = res.json()["id"]

    # 切换为用户 B 访问
    current_mock_user = other_user

    # 用户 B 拉取会话列表，不应看到用户 A 的会话
    res = client.get("/api/sessions")
    assert res.status_code == 200
    assert not any(s["id"] == user_a_session_id for s in res.json())

    # 用户 B 尝试更新用户 A 的会话，应返回 404
    res = client.patch(f"/api/sessions/{user_a_session_id}", json={"title": "恶意篡改"})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "SESSION_NOT_FOUND"

    # 用户 B 尝试删除用户 A 的会话，应返回 404
    res = client.delete(f"/api/sessions/{user_a_session_id}")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "SESSION_NOT_FOUND"

    # 用户 B 尝试拉取用户 A 的消息历史，应返回 404
    res = client.get(f"/api/chat/{user_a_session_id}/messages")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "SESSION_NOT_FOUND"

    # 恢复 mock user
    current_mock_user = test_user

