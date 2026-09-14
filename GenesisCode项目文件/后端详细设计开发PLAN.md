# Genesis AI 智能体工作台 - 后端详细设计与开发施工图 (BACKEND_PLAN)

> **项目名称**: Genesis (GenesisCode)  
> **代码仓库体系**: Monorepo 单一代码仓库体系，划分为两大核心工程：
> * `apps/web`: Genesis Web 前端工程（Next.js 14 + Tailwind CSS + Zustand）
> * `apps/api`: Genesis Core 后端工程（Python 3.11+ + FastAPI + Supabase + MCP Client + Skill Sandbox）
> 
> **文档性质**: 后端唯一完整施工图（供 AI 辅助开发工具与工程师直接读取并按部就班施工）。  
> **设计原则**: 拒绝无休止的功能蔓延，紧扣现有能力闭环；补齐真实部署与并发场景下的高风险硬漏洞，提供开箱即用的 DDL、数据模型与异步状态机。

---

## ⚠️ 0. AI 自动执行铁律 (Execution Protocol & Checkpoints)

**所有阅读或执行本文档的 AI 编程助手（Cursor / Claude Code 等）必须无条件遵循以下规则：**

1. **严格按任务顺序单向推进 (Strict Sequential Execution)**:
   - 本文档被严格拆分为 **BE-Step 1 至 BE-Step 6** 共 6 个阶段任务。
   - 必须先完全实现当前 Step 所包含的所有数据模型、仓库层、服务层、路由层及自动化验证，自测通过后，方可进入下一个 Step。**绝对禁止跳步或并行跨步骤开发**。
2. **强制暂停与确认机制 (Mandatory Check-in Checkpoint)**:
   - **每完成一个 Step，AI 必须立刻停下！禁止自动向下写下一个 Step 的代码！**
   - AI 必须向用户输出汇报：
     - 已完成的模块名称与具体文件清单；
     - 当前模块的核心实现要点与自测验证方法（curl 命令或单测试验）；
     - 下一个 Step 的开发预告；
     - **最后必须显式向用户提出询问：“当前 [BE-Step X] 已全部完成并验证通过，请问是否继续进行下一个任务？”**
   - **必须等待用户给出明确的肯定指令（如“继续”、“进行下一步”）后，AI 才能开始编写下一个 Step 的任何代码。**
3. **任务完成即时回写状态与断点续做 (State Persistence & Resume Protocol)**:
   - **完成即回写**: 每一个 Step 完成且经用户确认后，AI **必须主动调用文件编辑工具更新本文档下方的【后端任务开发进度看板】**，将当前 Step 的状态从 `[ ] 待开始` 变更为 `[x] 已完成 ✅`。
   - **新会话断点续做**: 当用户把本文档投喂给一个新的 AI 对话窗口时，AI **必须首先阅读【开发进度看板】，自动跳过所有已标记为 `[x] 已完成` 的步骤**，直接定位到第一个处于 `[ ] 待开始` 的步骤向用户汇报并请示开发，严禁从头重复编写已完成的内容！
4. **架构分层严格隔离 (Layering Architecture Constraints)**:
   - `routers/`: 只做参数校验、依赖注入与调用 service，**严禁直连数据库**，严禁编写业务规则；
   - `services/`: 业务逻辑编排中心（Agent Loop、沙箱调度、MCP 通信），**严禁直接处理原生 HTTP 响应细节**；
   - `repositories/`: 纯粹的数据访问层，封装 Supabase / Postgres 操作，**严禁夹带业务决策**；
   - `models/`: 明确区分 Pydantic Schema（用于 API 请求响应契约）与 DB ORM 模型。

### 📋 后端任务开发进度看板 (Progress Dashboard)
> **AI 必读执行入口**: 启动开发或开启新会话时，直接跳过已勾选 `[x]` 的任务，自动定位到第一个未勾选 `[ ]` 的任务向用户请示。每完成一个任务并获确认，立即将对应项勾选为 `[x]` 并注明完成状态！

- [x] **BE-Step 1**: Genesis 基础骨架、配置校验与完整 Supabase DDL `(状态: 已完成 ✅)`
- [ ] **BE-Step 2**: 会话管理与多态消息分支持久化 (Sessions & Messages) `(状态: 进行中 🚀)`
- [ ] **BE-Step 3**: MCP Client 引擎 (Tool Discovery 与统一适配器) `(状态: 待开始)`
- [ ] **BE-Step 4**: Skill 引擎与沙箱安全执行器 (Storage 解压与隔离) `(状态: 待开始)`
- [ ] **BE-Step 5**: Agent ReAct Loop 核心编排与 SSE 全双工流式推送 `(状态: 待开始)`
- [ ] **BE-Step 6**: 应用市场、自研插件与精细化用量成本审计 `(状态: 待开始)`

---

## 1. 核心架构与高风险漏洞防范设计 (Hardening & Pitfalls)

在具体编码前，必须在架构层抹平以下 4 个云端部署与 Agent 开发的最高危硬伤：

1. **反向代理流式缓冲穿透 (SSE Buffering Trap)**:
   - Railway/Render/Vercel 的边缘反向代理默认会开启响应缓冲（Buffer），导致 SSE 的 `text_delta` 被积压在代理缓冲区，打字机失效变成卡顿后全量弹出。
   - **强制规范**: 所有 SSE 响应 Header 必须显式携带：
     ```http
     Content-Type: text/event-stream
     Cache-Control: no-cache
     Connection: keep-alive
     X-Accel-Buffering: no
     ```
2. **异步非阻塞沙箱通信 (Event Loop Protection)**:
   - 严禁在异步路由或服务中直接调用同步的 `subprocess.run()` 或阻塞式的 `communicate()`，否则子进程执行 30 秒期间，整个 FastAPI 的 asyncio 事件循环会被彻底卡死，导致前端点击“停止生成”时无法接收到请求。
   - **强制规范**: 必须使用 `asyncio.create_subprocess_exec` 配合异步管道 `stdout.read()`，保证子进程运行期间其他 HTTP 请求（尤其是停止生成请求）能被并发秒级响应。
3. **子进程孤儿进程与进程树强杀 (`os.killpg`)**:
   - 严禁仅使用 `process.kill()`。如果用户的 Python 脚本内部启动了多线程或子进程，普通的 kill 只能杀掉父进程，残留的孤儿进程会吃光 Railway 容器的 CPU。
   - **强制规范**: 启动子进程时必须开启进程组 `preexec_fn=os.setsid`，超时或中断时向进程组广播强杀：`os.killpg(os.getpgid(process.pid), signal.SIGKILL)`。
4. **无状态容器文件自愈机制 (Ephemeral Filesystem Self-Healing)**:
   - Railway / Render 容器在部署、崩溃或空闲休眠唤醒时，本地 `/tmp` 目录会被全部清空。
   - **强制规范**: `skill_engine.py` 执行沙箱前，若发现本地 `/tmp/genesis/sandboxes/{skill_id}` 丢失，必须自动触发自愈逻辑：静默从 Supabase Storage 重新下载 zip 并解压，杜绝 `FileNotFoundError`。

---

## 2. 模块化开发施工图 (BE-Step 1 至 BE-Step 6)

---

### 任务 BE-Step 1: Genesis 基础骨架、配置校验与完整 Supabase DDL

#### 1. 任务目标与交付边界
* 搭建 FastAPI 异步工程骨架，建立配置管理与依赖注入基础设施。
* 提供并执行**开箱即用、完整的 PostgreSQL / Supabase Migration DDL 脚本**，包含所有业务表、外键级联、高频复合索引与严格的 RLS 行级安全策略。
* 实现基于 Supabase JWT 的鉴权依赖注入 `get_current_user`。
* 配置全局 CORS 中间件与全局统一业务异常拦截器。

#### 2. 涉及创建/修改文件
* `apps/api/core/config.py` (环境变量强校验)
* `apps/api/core/security.py` (JWT 提取与校验)
* `apps/api/core/database.py` (Supabase Client 工厂单例)
* `apps/api/core/exceptions.py` (全局错误码枚举与自定义异常)
* `apps/api/main.py` (FastAPI 实例装配、CORS、异常处理器、健康检查 `/api/health`)
* `apps/api/migrations/001_initial_schema.sql` (完整可执行 DDL 脚本)

#### 3. 开箱即用完整 DDL 脚本 (`apps/api/migrations/001_initial_schema.sql`)

```sql
-- 启用 uuid 扩展
create extension if not exists "uuid-ossp";

-- 1. 会话表 (增加 user_id 与更新时间索引)
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '新对话',
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sessions_user_updated on sessions(user_id, updated_at desc);

-- 2. 消息表 (支持 Tool Calling 结构与 parent_id 分支截断)
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references messages(id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text,
  raw_tool_calls jsonb null,
  tool_call_id text null,
  active_skill_id uuid null,
  status text not null default 'success' check (status in ('sending', 'streaming', 'success', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_session_time on messages(session_id, created_at asc);
create index if not exists idx_messages_parent on messages(parent_id);

-- 3. 已安装 Skill 表
create table if not exists installed_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  version text not null,
  storage_path text not null,
  local_dir text,
  manifest jsonb not null,
  auto_trigger boolean not null default true,
  installed_at timestamptz not null default now(),
  unique(user_id, name)
);

-- 4. 已连接 MCP Server
create table if not exists mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  connection_type text not null default 'remote_url' check (connection_type in ('local_command', 'remote_url')),
  connection_config jsonb not null,
  tools jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- 5. 会话级能力开关
create table if not exists session_capabilities (
  session_id uuid not null references sessions(id) on delete cascade,
  capability_type text not null check (capability_type in ('skill', 'mcp')),
  capability_id uuid not null,
  enabled boolean not null default true,
  primary key (session_id, capability_type, capability_id)
);

-- 6. 用量记录表 (包含 model 字段支持多模型精细核算)
create table if not exists usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  skill_id uuid null references installed_skills(id) on delete set null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_usage_user_created on usage_logs(user_id, created_at desc);

-- 7. 自研插件草稿表
create table if not exists my_plugins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  manifest jsonb not null,
  storage_path text,
  status text not null default 'draft' check (status in ('draft', 'unpublished')),
  created_at timestamptz not null default now()
);

-- 8. 启用 RLS 并建立隔离策略
alter table sessions enable row level security;
alter table messages enable row level security;
alter table installed_skills enable row level security;
alter table mcp_connections enable row level security;
alter table session_capabilities enable row level security;
alter table usage_logs enable row level security;
alter table my_plugins enable row level security;

create policy "Users manage own sessions" on sessions for all using (auth.uid() = user_id);
create policy "Users manage own messages" on messages for all using (auth.uid() = user_id);
create policy "Users manage own skills" on installed_skills for all using (auth.uid() = user_id);
create policy "Users manage own mcps" on mcp_connections for all using (auth.uid() = user_id);
create policy "Users manage own usage" on usage_logs for all using (auth.uid() = user_id);
create policy "Users manage own my_plugins" on my_plugins for all using (auth.uid() = user_id);
```

#### 4. 全局错误响应体契约与异常处理 (`apps/api/core/exceptions.py`)
定义标准化业务错误格式，HTTP 状态码严格与业务错误码对应：
```python
# 业务错误体结构
{
    "error": {
        "code": "SKILL_TIMEOUT",          # 明确业务枚举
        "message": "执行脚本已超过 30s 阈值", # 可读描述
        "details": null
    }
}
```

#### 5. 本任务验收标准 (Checkpoint)
1. 将 `001_initial_schema.sql` 导入 Supabase SQL Editor，执行成功且 7 张表 RLS 均处于开启状态。
2. 启动服务，请求 `GET /api/health` 正常响应；不带 Token 访问受保护测试端点返回 HTTP 401 且包含上述统一结构。
3. **执行强制暂停**: 向用户输出汇报并询问：“当前 [BE-Step 1] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 BE-Step 2: 会话管理与多态消息分支持久化 (Sessions & Messages)

#### 1. 任务目标与交付边界
* 编写 `SessionRepository` 与 `MessageRepository` 数据访问层。
* 编写端到端 Pydantic Schemas，包含强校验字段与 OpenAPI 示例。
* 编写会话管理 HTTP 路由：列表查询、新建空会话、更新属性（重命名/置顶）、级联物理删除。
* 编写消息历史游标分页路由：`GET /api/chat/{session_id}/messages`。
* 编写会话能力开关批量更新路由：`PUT /api/chat/{session_id}/capabilities`。
* 实现**编辑重发分支清理 (Branch Pruning)**：当收到包含 `parent_id` 的新请求时，物理修剪当前会话中晚于该父节点的所有旧消息，保持单线整洁。

#### 2. 涉及创建/修改文件
* `apps/api/models/schemas/session.py` (请求/响应模型)
* `apps/api/models/schemas/message.py` (消息多态数据模型)
* `apps/api/repositories/session_repository.py`
* `apps/api/repositories/message_repository.py`
* `apps/api/routers/sessions.py`

#### 3. 核心 Pydantic 契约定义

```python
# apps/api/models/schemas/session.py
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from uuid import UUID

class SessionCreate(BaseModel):
    title: Optional[str] = Field(default="新对话", max_length=100)

class SessionUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=100)
    pinned: Optional[bool] = None

class SessionResponse(BaseModel):
    id: UUID
    title: str
    pinned: bool
    created_at: datetime
    updated_at: datetime

# apps/api/models/schemas/message.py
class ToolCallItem(BaseModel):
    id: str
    name: str
    args: dict

class MessageResponse(BaseModel):
    id: UUID
    session_id: UUID
    parent_id: Optional[UUID] = None
    role: str
    content: Optional[str] = None
    raw_tool_calls: Optional[list[ToolCallItem]] = None
    tool_call_id: Optional[str] = None
    status: str
    created_at: datetime
```

#### 4. 分支修剪逻辑 (`MessageRepository.prune_branch`)
当用户触发编辑重发时，传入目标节点的 `parent_id`。后端在插入新提问前执行：
```sql
-- 物理修剪晚于父节点时间戳的所有历史分支，杜绝 LLM 上下文出现幽灵轮次
DELETE FROM messages 
WHERE session_id = :session_id 
  AND created_at > (SELECT created_at FROM messages WHERE id = :parent_id);
```

#### 5. 本任务验收标准 (Checkpoint)
1. 使用 Swagger (`/docs`) 跑通创建会话、修改标题、置顶、拉取列表流程，置顶会话始终置于首位。
2. 插入测试数据，分页拉取 `GET /api/chat/{session_id}/messages?limit=2`，能够基于时间游标正确分页翻页。
3. 测试分支修剪：调用修剪逻辑，验证指定消息之后的所有记录被准确清空。
4. **执行强制暂停**: 向用户输出汇报并询问：“当前 [BE-Step 2] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 BE-Step 3: MCP Client 引擎 (Tool Discovery 与统一适配器)

#### 1. 任务目标与交付边界
* 针对云端容器化环境，实现纯异步的 **MCP SSE 客户端传输层**。
* 编写全局 `McpClientManager` 单例：维护所有已配置 Server 的连接字典、心跳检测与优雅断连。
* 实现 **Tool Discovery**: 向远程 Server 发送 `tools/list` 并将工具 schema 缓存至 `mcp_connections.tools`。
* 编写 `ToolAdapter`: 将探测到的工具转换为 OpenAI / Anthropic 统一格式，加盖 `mcp__{server_name}__{tool_name}` 命名空间。

#### 2. 涉及创建/修改文件
* `apps/api/models/schemas/mcp.py` (连接配置与探测结果模型)
* `apps/api/services/mcp_client.py` (异步 SSE JSON-RPC 2.0 客户端与连接池)
* `apps/api/services/tool_adapter.py` (命名空间 schema 转换器)
* `apps/api/repositories/mcp_repository.py`
* `apps/api/routers/mcp.py`

#### 3. 详细设计与实现要求
* **JSON-RPC 2.0 报文交互契约**:
  * 探测工具请求: `{"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": "probe_1"}`
  * 执行工具请求: `{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "...", "arguments": {...}}, "id": "call_1"}`
* **`ToolAdapter` 核心转换逻辑**:
  ```python
  @staticmethod
  def mcp_to_standard_tool(server_name: str, tool: dict) -> dict:
      namespaced_name = f"mcp__{server_name}__{tool['name']}"
      return {
          "type": "function",
          "function": {
              "name": namespaced_name,
              "description": tool.get("description", ""),
              "parameters": tool.get("inputSchema", {"type": "object", "properties": {}})
          }
      }
  ```

#### 4. 本任务验收标准 (Checkpoint)
1. 配置一个可访问的远程 MCP URL，调用新建连接端点，连接状态成功置为 `enabled`。
2. 调用 `POST /api/mcp/connections/{id}/refresh`，能够成功探测出远端工具并在本地数据库中查到结构化 JSON。
3. 单测验证转换出的标准 Tool Schema 符合官方规范，带有正确命名空间前缀。
4. **执行强制暂停**: 向用户输出汇报并询问：“当前 [BE-Step 3] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 BE-Step 4: Skill 引擎与沙箱安全执行器 (Storage 解压与隔离)

#### 1. 任务目标与交付边界
* 实现 Skill 的生命周期管理：Supabase Storage 下载、解压至本地无状态容器缓存。
* 编写严格的 `manifest.json` 强类型校验引擎。
* 编写工业级安全进程隔离执行器 `SandboxExecutor`:
  * **异步非阻塞**: 使用 `asyncio.create_subprocess_exec`，杜绝阻塞主事件循环；
  * **环境变量脱敏**: 彻底隔离 `SUPABASE_KEY` 等机密，白名单注入运行环境；
  * **管道安全交互**: `stdin` 喂入入参，`stdout` 读取结果，隔离 `stderr`；
  * **进程组强杀 (`os.killpg`)**: 30 秒超时强杀整个子进程树，杜绝僵尸进程。
* 实现 **自愈机制 (Self-Healing)**: 容器重启导致 `/tmp` 丢失时，检测并自动从 Storage 重新拉取解压。

#### 2. 涉及创建/修改文件
* `apps/api/plugins/sandbox/executor.py` (异步安全子进程沙箱)
* `apps/api/services/skill_engine.py` (解压、缓存自愈、manifest 校验)
* `apps/api/repositories/skill_repository.py`
* `apps/api/routers/skills.py`

#### 3. 核心沙箱异步实现细节 (`apps/api/plugins/sandbox/executor.py`)

```python
import asyncio
import os
import signal
import json

class SandboxExecutor:
    @staticmethod
    async def run_skill(entry_path: str, working_dir: str, input_args: dict, timeout: int = 30) -> dict:
        # 1. 严格白名单环境变量
        safe_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "PYTHONUNBUFFERED": "1",
            "LANG": "en_US.UTF-8"
        }
        
        payload = json.dumps(input_args).encode("utf-8")

        # 2. 异步创建子进程，设置独立的进程组组长 (os.setsid)
        process = await asyncio.create_subprocess_exec(
            "python3", entry_path,
            cwd=working_dir,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=safe_env,
            preexec_fn=os.setsid
        )

        try:
            # 3. 异步通信，设置超时熔断
            stdout_data, stderr_data = await asyncio.wait_for(
                process.communicate(input=payload),
                timeout=timeout
            )
        except asyncio.TimeoutError:
            # 4. 超时向整个进程组广播 SIGKILL 彻底消灭孤儿进程
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise TimeoutError(f"Skill execution timed out after {timeout}s")

        if process.returncode != 0:
            err_msg = stderr_data.decode("utf-8").strip()
            raise RuntimeError(f"Skill execution error (code {process.returncode}): {err_msg}")

        try:
            return json.loads(stdout_data.decode("utf-8"))
        except json.JSONDecodeError:
            raise ValueError(f"Invalid JSON returned from skill: {stdout_data.decode('utf-8')[:200]}")
```

#### 4. 本任务验收标准 (Checkpoint)
1. 编写包含子进程派生和沉睡的测试脚本，验证超时触发时，利用 `ps aux` 检查系统内无任何僵尸/孤儿进程残留。
2. 测试白名单环境：脚本尝试访问 `os.environ["SUPABASE_KEY"]` 抛出 `KeyError`，安全隔离生效。
3. 手动清空本地 `/tmp/genesis/sandboxes/{id}` 目录，触发调用，验证自愈机制能成功从 Storage 重新拉取并执行。
4. **执行强制暂停**: 向用户输出汇报并询问：“当前 [BE-Step 4] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 BE-Step 5: Agent ReAct Loop 核心编排与 SSE 全双工流式推送

#### 1. 任务目标与交付边界
* 打造 Genesis 的核心运行时大脑：`chat_service.py`。
* 实现 **ReAct Loop (Agent 循环)**：动态组装工具，处理模型多步 Tool Calling，设置 **`max_steps=5` 熔断上限**。
* 实现**双模型 SDK 原生流式 Chunk 解析适配器**:
  * 完美处理 Anthropic 的 `content_block_start` / `input_json_delta` / `message_delta`；
  * 完美处理 OpenAI 的 `choice.delta.tool_calls[i].function.arguments`。
* 编写标准 SSE 流式推送通道，显式注入 `X-Accel-Buffering: no` 穿透反向代理缓冲。
* 编写停止生成逻辑：内存维护 `RUNNING_TASKS`，收到请求秒级 cancel 异步 Task 并中断沙箱。
* 编写滑动窗口截断机制：超长多轮对话自动修剪旧的 `tool_result`，防止 Context Overflow。

#### 2. 涉及创建/修改文件
* `apps/api/services/chat_service.py` (核心编排引擎)
* `apps/api/services/llm_adapter.py` (Anthropic / OpenAI 流式 Chunk 差异抹平器)
* `apps/api/services/context_manager.py` (滑动窗口截断)
* `apps/api/routers/chat.py` (SSE 消息路由与停止路由)

#### 3. 原生流式 Tool Calling 状态机算法 (`llm_adapter.py`)
由于不同模型厂商流式 Chunk 结构差异巨大，适配器必须在内存中实时聚合完整的 JSON 字符串：
* **Chunk 流转状态机**:
  1. 收到文本增量时：即刻格式化输出 `event: text_delta`；
  2. 收到工具调用开始块时：记录 `tool_call_id` 与 `tool_name`；
  3. 收到 JSON 片段 delta 时：在内存缓冲区拼装 `raw_arguments += delta`；
  4. 收到块结束信号时：解析完整 JSON，触发沙箱或 MCP 调用，格式化输出 `event: tool_result`，并写回上下文参与下一步 ReAct。

#### 4. 穿透缓冲的 SSE 路由响应 (`routers/chat.py`)
```python
@router.post("/api/chat/{session_id}/messages")
async def send_chat_message(
    session_id: UUID,
    request: ChatRequest,
    current_user: User = Depends(get_current_user)
):
    event_generator = chat_service.handle_stream(session_id, request, current_user.id)
    return StreamingResponse(
        event_generator,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"  # 核心防缓冲标记
        }
    )
```

#### 5. 本任务验收标准 (Checkpoint)
1. 发起真实流式请求，逐字打字机效果流畅，无反向代理缓冲卡顿。
2. 触发需要工具调用的提问，后端控制台清晰可见 `Step 1 -> tool_start -> tool_result -> Step 2 -> text_delta` 的完整 ReAct 循环。
3. 测试中途停止：调用 `POST /api/chat/{session_id}/stop`，Task 秒级取消，数据库正确记录已有片段。
4. **执行强制暂停**: 向用户输出汇报并询问：“当前 [BE-Step 5] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 BE-Step 6: 应用市场、自研插件与精细化用量成本审计

#### 1. 任务目标与交付边界
* 编写应用市场检索、详情查询、安装与卸载 API。
* 编写自研插件上传 API：校验 manifest.json 与 zip 代码包合规性，写入 `my_plugins` 草稿表。
* 编写用量审计引擎：在每次对话的 `finally` 块中强制写入 `usage_logs` 表，依据模型单价字典高精度计算 `cost_usd`。
* 编写仪表盘汇总 API：`GET /api/usage/summary`，支持按天维度聚合 Token 与费用趋势。

#### 2. 涉及创建/修改文件
* `apps/api/models/schemas/marketplace.py`
* `apps/api/services/usage_service.py` (模型定价表与聚合统计)
* `apps/api/repositories/usage_repository.py`
* `apps/api/routers/marketplace.py`
* `apps/api/routers/usage.py`

#### 3. 模型单价矩阵与核算逻辑 (`usage_service.py`)
```python
# 官方标准单价表 (单位: 美元 / 每百万 Token)
MODEL_PRICING = {
    "claude-3-5-sonnet-20241022": {"input": 3.00, "output": 15.00},
    "claude-3-haiku-20240307": {"input": 0.25, "output": 1.25},
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60}
}

def calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    pricing = MODEL_PRICING.get(model, {"input": 3.00, "output": 15.00})
    cost = (input_tokens / 1_000_000 * pricing["input"]) + (output_tokens / 1_000_000 * pricing["output"])
    return round(cost, 6)
```

#### 4. 本任务验收标准 (Checkpoint)
1. 调用插件安装接口，能够完成 Storage 到本地解压缓存的同步，卸载接口能够干净清除物理目录。
2. 触发模型调用后，在 Supabase `usage_logs` 表中确认成功记录了 `model`、Token 数与正确的 `cost_usd`。
3. 访问 `/api/usage/summary?range=month`，能查出聚合的每日消耗坐标点与最耗费的 Top Skill 排行榜。
4. **执行强制暂停**: 向用户输出汇报并宣布：“🎉 [BE-Step 6] 已全部完成！Genesis 后端所有 6 个阶段模块均已高质量交付并验证完毕！”

---

## 3. 开发投喂与执行守则 (Prompts & Strict Instructions)

当你在 Cursor / Claude Code 中开始后端开发时，请务必遵守：
1. **第一次只投喂本文档的第 0、1 节以及 [BE-Step 1] 的完整内容**，并附带指令：“请严格遵照 BE-Step 1 进行实现，包含执行完整 DDL、环境变量强校验与 JWT 校验依赖项。完成后立即停下并向我提问确认。”
2. **每次推进严格核对 Checkpoint**：核实数据库表已建立、API 响应符合规范后，再投喂下一个 Step。
3. **坚守分层原则**: 路由层绝对不碰数据库，业务逻辑收敛于 `services/`，保证 Genesis 架构的高健壮性与纯洁度。
