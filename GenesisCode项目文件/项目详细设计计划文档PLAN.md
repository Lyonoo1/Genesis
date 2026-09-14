# Genesis (GenesisCode) 全局技术架构设计与开发总纲 (MASTER_PLAN)

> **项目名称**: Genesis (GenesisCode)  
> **工程全景**: 单一代码仓库 (Monorepo)，包含 `apps/web` (前端) 与 `apps/api` (后端)。  
> **文档定位**: 系统整体架构总览。关于前后端更加深入的页面像素级描述与后端数据流细节，已分别下沉至同目录下的专门文档：
> - 🎨 **前端施工详图**: [前端详细设计开发PLAN.md](file:///Users/lyon/Desktop/agent/GenesisCode%E9%A1%B9%E7%9B%AE%E6%96%87%E4%BB%B6/%E5%89%8D%E7%AB%AF%E8%AF%A6%E7%BB%86%E8%AE%BE%E8%AE%A1%E5%BC%80%E5%8F%91PLAN.md)
> - ⚙️ **后端施工详图**: [后端详细设计开发PLAN.md](file:///Users/lyon/Desktop/agent/GenesisCode%E9%A1%B9%E7%9B%AE%E6%96%87%E4%BB%B6/%E5%90%8E%E7%AB%AF%E8%AF%A6%E7%BB%86%E8%AE%BE%E8%AE%A1%E5%BC%80%E5%8F%91PLAN.md)

---

## 0. 任务模块划分与开发进度总看板 (Master Dashboard)

### ⚠️ AI 执行铁律与断点续做约定
1. **严格单向推进**: 必须完成上一个 Step 并自测通过后，方可进入下一个 Step，严禁跨步并行。
2. **强制暂停汇报**: **每完成一个 Step，AI 必须立即停下**，汇报当前完成成果，并**显式提问：“当前任务已完成，是否继续进行下一个任务？”**，待用户确认后才可动工下一步。
3. **完成即时回写与新会话断点续做 (State Persistence & Resume Protocol)**:
   - **完成即更新**: 某个 Step 完成且经用户确认后，AI **必须主动调用编辑工具将本文档及子文档看板中的对应项由 `[ ] 待开始` 变更为 `[x] 已完成 ✅`**。
   - **新会话自动跳过**: 当用户将本文档投喂给新开启的 AI 对话窗口时，AI **必须首先阅读下方看板，自动跳过所有 `[x] 已完成` 的任务**，直接定位到第一个未完成的 `[ ]` 任务向用户请示，无需用户重复沟通进度！

---

### 📋 全局开发任务进度看板 (Master Progress)

#### 🎨 前端工程模块 (`apps/web`) - 详见《前端详细设计开发PLAN.md》
- [x] **FE-Step 1**: Genesis 基础设施、Design Tokens 与三栏布局画卷 `(状态: 已完成 ✅)`
- [ ] **FE-Step 2**: Genesis 侧边栏与会话状态精细交互 (useSessionStore) `(状态: 待开始)`
- [ ] **FE-Step 3**: Genesis 主对话区与智性阅读渲染器 (Messages & AST) `(状态: 待开始)`
- [ ] **FE-Step 4**: Agent 核心物料 (Tool 折叠舱 + 命令中枢 + 粘滞算法) `(状态: 待开始)`
- [ ] **FE-Step 5**: SSE 全双工流通信、分支截断与会话熔断 (useChatStore) `(状态: 待开始)`
- [ ] **FE-Step 6**: Genesis 应用市场、MCP 抽屉面板与设置中心 `(状态: 待开始)`

#### ⚙️ 后端工程模块 (`apps/api`) - 详见《后端详细设计开发PLAN.md》
- [x] **BE-Step 1**: Genesis 基础骨架、配置校验与完整 Supabase DDL `(状态: 已完成 ✅)`
- [ ] **BE-Step 2**: 会话管理与多态消息分支持久化 (Sessions & Messages) `(状态: 进行中 🚀)`
- [ ] **BE-Step 3**: MCP Client 引擎 (Tool Discovery 与统一适配器) `(状态: 待开始)`
- [ ] **BE-Step 4**: Skill 引擎与沙箱安全执行器 (Storage 解压与隔离) `(状态: 待开始)`
- [ ] **BE-Step 5**: Agent ReAct Loop 核心编排与 SSE 全双工流式推送 `(状态: 待开始)`
- [ ] **BE-Step 6**: 应用市场、自研插件与精细化用量成本审计 `(状态: 待开始)`

---

## 1. 系统架构

### 1.1 分层架构

```
┌─────────────────────────────────────────┐
│  前端 Next.js(静态导出兼容,为未来桌面端预留)  │
│  对话UI / 会话管理 / 应用市场 / 设置        │
└──────────────────┬──────────────────────┘
                    │ REST + SSE(流式)
┌──────────────────▼──────────────────────┐
│  后端 FastAPI                            │
│  ┌─────────────┬─────────────┬─────────┐ │
│  │ Chat Service │ Skill Engine │ MCP Client│ │
│  └─────────────┴─────────────┴─────────┘ │
└──────────────────┬──────────────────────┘
                    │
┌──────────────────▼──────────────────────┐
│  Supabase(Postgres + pgvector + Auth)   │
└───────────────────────────────────────────┘
```

### 1.2 前端目录结构

```
apps/web/
├── app/
│   ├── (auth)/login/page.tsx
│   ├── (main)/
│   │   ├── layout.tsx              # 侧边栏+顶部栏的整体布局壳
│   │   ├── chat/[sessionId]/page.tsx
│   │   ├── chat/page.tsx           # 空状态(未选中任何会话)
│   │   ├── marketplace/page.tsx
│   │   └── settings/page.tsx
├── components/
│   ├── chat/                       # MessageList, MessageBubble, InputBox, SkillPicker
│   ├── sidebar/                    # SessionList, SessionItem, SearchBox
│   ├── marketplace/                # PluginCard, PluginDetailModal, CategoryFilter
│   ├── settings/                   # AppearancePanel, McpManager, UsageDashboard
│   └── ui/                         # shadcn/ui基础组件
├── stores/                         # Zustand:useChatStore, useSessionStore, useSkillStore, useSettingsStore
├── lib/
│   ├── api/                        # 按领域拆分的API client:chat.ts, skill.ts, mcp.ts, marketplace.ts
│   └── streaming.ts                # SSE解析封装
└── types/                          # 前后端共享的TS类型定义(手动同步后端Pydantic模型)
```

### 1.3 后端目录结构

```
apps/api/
├── main.py                          # 入口文件，挂载路由、CORS中间件、异常处理
├── routers/                        # 只做参数校验+调用service,不写业务逻辑
│   ├── chat.py                     # 发送消息(SSE)、停止生成、分页拉取历史
│   ├── sessions.py                 # 会话CRUD、能力开关配置
│   ├── skills.py                   # Skill安装、卸载、自动触发开关
│   ├── mcp.py                      # MCP连接管理、Tool刷新
│   ├── marketplace.py              # 市场插件发现、详情查询
│   └── usage.py                    # 用量统计与成本分析
├── services/                       # 业务逻辑层
│   ├── chat_service.py             # Agent Loop编排、上下文组装、流式推流、Task取消维护
│   ├── tool_adapter.py             # 统一将 Skill 与 MCP 转换为统一 Tool Schema (带命名空间)
│   ├── skill_engine.py             # Skill解压缓存管理、manifest校验、沙箱执行分发
│   ├── mcp_client.py               # MCP SSE/HTTP客户端连接池、Tool Discovery与缓存
│   └── usage_service.py            # Token与成本统计记录
├── repositories/                    # 数据访问层,封装 Supabase / Postgres 读写
├── models/                          # Pydantic请求/响应模型 + 数据库结构映射
├── plugins/sandbox/                 # 隔离子进程沙箱执行器 (stdin/stdout JSON通信)
└── core/config.py                   # 环境变量解析 (pydantic-settings)
```

**分层原则**:`routers` 不直接碰数据库,`services` 不直接处理HTTP请求细节,`repositories` 不包含业务判断——这样AI辅助生成某一层代码时,上下文边界清楚,不容易把逻辑写串。

### 1.4 Git 仓库组织与部署配置

**采用单一仓库(monorepo),不拆分前后端仓库。** 单人项目不需要权限隔离/独立发版,拆分只会增加跨仓库同步接口变更的操作成本。

```
devagent/
├── apps/
│   ├── web/          # Next.js前端(对应1.2目录结构)
│   └── api/          # FastAPI后端(对应1.3目录结构)
├── .gitignore
└── README.md
```

**部署配置**(一个仓库对应两个独立部署目标):

- Vercel:项目设置中 Root Directory 指定为 `apps/web`,只监听该目录变化并构建
- Railway/Render:Root Directory 指定为 `apps/api`,只监听该目录变化并构建

**跨域配置 (CORS)**:
FastAPI 在 `main.py` 中显式挂载 `CORSMiddleware`，允许 Vercel 生产域名与本地开发端口：
```python
origins = [
    "http://localhost:3000",
    os.getenv("FRONTEND_URL", "https://*.vercel.app")
]
```

**本地开发联调**:
- 前端：`cd apps/web && pnpm dev` (监听 3000 端口，配置 `.env.local` 指向 `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`)
- 后端：`cd apps/api && source .venv/bin/activate && uvicorn main.py --reload --port 8000` (配置 `.env` 提供数据库与模型 API Key)

**`.gitignore`**:前端(`node_modules/`, `.next/`)和后端(`__pycache__/`, `.venv/`, `*.pyc`)的忽略规则合并写在仓库根目录一份文件里,不分开管理。

---

## 2. 设计模式规范

### 2.1 前端

- **容器/展示组件分离**:`page.tsx` 只负责取数据+组合展示组件,不写具体UI细节;`components/` 下的组件只接收props渲染,不直接调API
- **状态管理边界**:Zustand只放"跨组件共享且需要持久到组件卸载后还在"的状态(当前会话、已安装Skill列表、当前激活的Skill/MCP);组件内部的UI态(输入框内容、弹窗开关)用`useState`,不进全局store
- **API请求统一走 `lib/api/`**:每个领域一个文件,组件不直接写fetch,方便以后统一加错误处理/重试逻辑

### 2.2 后端

- **依赖注入**:FastAPI的`Depends`用来注入数据库连接、当前登录用户,不在函数内部直接建连接
- **策略模式:Skill执行器**:不同类型的Skill(纯prompt型 / 带脚本执行型)对应不同的Executor实现同一个接口`SkillExecutor.run(input) -> output`,`skill_engine.py`只负责根据manifest里的类型选择对应的Executor,不写if-else堆砌
- **适配器模式:统一 Tool Schema 与命名空间隔离**:
  上层 Agent Loop 不关心工具来源，由 `ToolAdapter` 统一转成 OpenAI/Anthropic 标准 Function 格式并加命名空间，防止命名冲突：
  - Skill 工具：`skill__{manifest.name}`
  - MCP 工具：`mcp__{server_name}__{tool_name}`
  自动触发时挂载所有开启自动触发的 Skill 和激活的 MCP；用户输入 `/` 手动指定时，通过强行指定 `tool_choice={"type": "function", "function": {"name": "skill__..."}}` 强制调用。

### 2.3 插件沙箱执行与安全通信契约

```
用户消息 → Chat Service 判断触发 Skill
        → Skill Engine 读取 manifest 并校验 permissions
        → 检查本地缓存目录 (/tmp/devagent/sandboxes/{skill_id}/)，未命中则从 Supabase Storage 下载解压
        → 交给 SandboxExecutor 执行子进程隔离调用
        → 捕获结果与校验 output_schema 后交回 Chat Service 参与后续对话
```

**通信协议与安全隔离规范**:
1. **进程间通信**: 统一采用 `stdin` 喂入输入参数 JSON，从 `stdout` 获取单次输出 JSON。禁止直接通过命令行拼接传参（防注入），子进程业务代码日志必须走 `stderr`，严禁向 `stdout` 输出任何非 JSON 字符串（避免 JSON parse 损坏）。
2. **环境变量防逃逸**: `subprocess.Popen` 时显式剥离宿主环境变量，使用白名单环境：
   ```python
   safe_env = {
       "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
       "PYTHONUNBUFFERED": "1"
   }
   ```
   **严禁**将 `SUPABASE_KEY`、`OPENAI_API_KEY` 等敏感变量透传进子进程。
3. **资源与超时防护**: 设置 `timeout=30s`；单机阶段利用进程超时监控+kill，跨平台差异提示：`resource` 模块的 `setrlimit` 仅在 Linux 生效，macOS 开发环境下通过 Python 进程级 timeout 保护；后续阶段平滑演进到 Docker 容器隔离。

---

## 3. 数据库设计 (Postgres / Supabase DDL)

```sql
-- 启用 uuid 扩展
create extension if not exists "uuid-ossp";

-- 1. 会话表 (增加 user_id 与时间索引)
create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '新对话',
  pinned boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_sessions_user_updated on sessions(user_id, updated_at desc);

-- 2. 消息表 (支持 Tool Calling 完整结构与编辑重发分支截断)
create table messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references messages(id) on delete set null, -- 支持编辑重发截断分支
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text,                                              -- 对普通消息为正文; 对 tool 为执行结果纯文本
  raw_tool_calls jsonb null,                                 -- assistant 角色发起的工具调用请求列表 [{id, name, args}]
  tool_call_id text null,                                    -- role='tool' 时关联的 tool_call id
  active_skill_id uuid references installed_skills(id) on delete set null,
  status text not null default 'success' check (status in ('sending', 'streaming', 'success', 'failed')),
  created_at timestamptz default now()
);
create index idx_messages_session_time on messages(session_id, created_at asc);

-- 3. 已安装 Skill 表 (补齐代码存储路径与唯一约束)
create table installed_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  version text not null,
  storage_path text not null,                                -- Supabase Storage 上的 zip 路径 (skills/{user_id}/{name}/{version}.zip)
  local_dir text,                                            -- 本地容器解压缓存绝对路径 (/tmp/devagent/sandboxes/{id})
  manifest jsonb not null,                                   -- 完整 manifest 内容
  auto_trigger boolean default true,
  installed_at timestamptz default now(),
  unique(user_id, name)
);

-- 4. 已连接 MCP Server (仅支持 remote_url 模式用于云端部署)
create table mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  connection_type text not null default 'remote_url' check (connection_type in ('local_command', 'remote_url')),
  connection_config jsonb not null,                          -- 包含 url, headers, auth tokens
  tools jsonb default '[]'::jsonb,                           -- 缓存的 tool discovery 结果
  enabled boolean default true,
  created_at timestamptz default now()
);

-- 5. 会话级能力开关 (配置联合主键防重复)
create table session_capabilities (
  session_id uuid not null references sessions(id) on delete cascade,
  capability_type text not null check (capability_type in ('skill', 'mcp')),
  capability_id uuid not null,
  enabled boolean not null default true,
  primary key (session_id, capability_type, capability_id)
);

-- 6. 用量记录 (增加 model 字段支持精细化成本核算)
create table usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  skill_id uuid references installed_skills(id) on delete set null,
  model text not null,                                       -- 调用的模型型号 (如 'claude-3-5-sonnet-20241022')
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz default now()
);
create index idx_usage_user_time on usage_logs(user_id, created_at desc);

-- 7. 我的开发 (自研插件草稿)
create table my_plugins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  manifest jsonb not null,
  storage_path text,
  status text not null default 'draft' check (status in ('draft', 'unpublished')),
  created_at timestamptz default now()
);

-- 8. 行级权限安全策略 (Supabase RLS)
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

---

## 4. 完整 API 接口清单

| Method | Path | 说明 |
|---|---|---|
| **POST** | `/api/chat/{session_id}/messages` | 发送消息，SSE 协议流式推送（包含文本、工具执行状态、结果与用量） |
| **GET** | `/api/chat/{session_id}/messages?cursor=&limit=30` | 分页拉取指定会话历史消息（倒序游标，带 tool_calls 与状态） |
| **POST** | `/api/chat/{session_id}/stop` | 停止当前生成，服务端立即取消后台异步 Task / kill 子进程 |
| **GET** | `/api/sessions` | 获取当前用户的会话列表（按置顶与更新时间排序） |
| **POST** | `/api/sessions` | 创建全新空会话 |
| **PATCH** | `/api/sessions/{id}` | 更新会话属性（重命名标题 `title`、切换置顶 `pinned`） |
| **DELETE** | `/api/sessions/{id}` | 删除会话（级联删除消息与用量） |
| **PUT** | `/api/chat/{session_id}/capabilities` | 批量更新当前会话的 Skill / MCP 开关配置 |
| **GET** | `/api/skills/installed` | 获取当前已安装 Skill 列表及状态 |
| **POST** | `/api/skills/{id}/toggle-auto-trigger` | 切换指定 Skill 的全局自动触发开关 |
| **DELETE** | `/api/marketplace/{id}/uninstall` | 卸载已安装 Skill，清理本地解压磁盘缓存 |
| **GET** | `/api/marketplace/discover?category=&q=` | 市场发现页插件列表检索 |
| **POST** | `/api/marketplace/{id}/install` | 安装 Skill（下载 zip、校验 manifest 并解压缓存） |
| **GET** | `/api/mcp/connections` | 获取所有已配置的 MCP Server 连接列表 |
| **POST** | `/api/mcp/connections` | 新增 MCP Server 连接并立即执行 Tool Discovery |
| **PATCH** | `/api/mcp/connections/{id}` | 编辑 MCP 连接参数或开关 |
| **DELETE** | `/api/mcp/connections/{id}` | 删除 MCP 连接 |
| **POST** | `/api/mcp/connections/{id}/refresh` | 手动触发重新探测 MCP Server 的 Tools 列表 |
| **GET** | `/api/usage/summary?range=month` | 用量仪表盘汇总数据（Token、费用、Top Skill排行） |
| **GET** | `/api/my-plugins` | 获取自研插件列表 |
| **POST** | `/api/my-plugins/upload` | 上传自研插件 manifest.json 与代码 zip 包 |
| **DELETE** | `/api/my-plugins/{id}` | 删除自研插件草稿 |

---

## 5. 页面级详细设计

### 5.1 登录页 `/login`

**布局**:居中卡片,宽度400px,上方Logo+产品名,下方账号密码输入框,登录按钮。

**交互状态机**:
```
初始态 → 输入账号密码 → 点击登录
  → loading态(按钮显示spinner,禁用输入框)
  → 成功:跳转到 /chat
  → 失败:输入框下方红色文案"账号或密码错误",不清空输入框,聚焦回密码框
```

不需要"注册"入口(单账号场景,账号由你自己在Supabase后台建)。

### 5.2 主对话页 `/chat/[sessionId]`

**布局区域**(从上到下):

1. **顶部信息条**(48px高):会话标题(可点击编辑) + 当前激活的Skill/MCP标签(chip形式,点击可移除该能力)
2. **消息区**(flex:1,可滚动):消息列表,新消息自动滚动到底部;用户手动往上滚动时暂停自动滚动,右下角出现"回到底部"悬浮按钮
3. **输入区**(固定底部):附件按钮 + 文本输入框(自适应高度,最多6行后内部滚动)+ Skill选择器 + 发送按钮

**消息气泡交互状态机 (完整支持 Tool Calling 与多态状态)**:
```
用户发送消息
  → 立即在消息区插入用户消息(乐观更新,不等后端确认, status='sending')
  → 插入空的 AI 消息占位,显示"思考中"动效
  → 接收 SSE 消息流:
      - 收到 tool_start: 消息气泡内插入工具调用折叠卡片,显示"正在调用 xx 工具,入参...",展开可查看入参 JSON
      - 收到 tool_result: 折叠卡片状态变为"调用成功",更新耗时与返回数据摘要
      - 收到 text_delta: 占位文本节点逐字追加
      - 收到 usage: 更新本次消耗 token 与预估费用
      - 收到 done: 状态转为 'success',下方浮现操作按钮组(复制/重新生成/编辑重发/点赞)
      - 收到 error 或中断: 状态置为 'failed',显示"生成中断/失败,重试"按钮,保留已输出内容
```

**编辑重发交互 (分支截断机制)**:
```
用户悬停在已发送的消息 → 点击"编辑"图标
  → 该消息变为编辑输入框,原文本回填
  → 用户修改后点击"重新发送"
  → 前端记录当前消息的 parent_id，截断并移除前端列表该消息之后的所有历史轮次
  → 发起发送请求: POST /api/chat/{sessionId}/messages (带 parent_id 参数)
  → 后端基于 parent_id 组装该分支的历史上下文并存入新分支
```

**会话切换保护机制**:
- 若用户在 AI 正在流式生成时点击切换其他会话：
  - 前端立即调用 `POST /api/chat/{currentSessionId}/stop` 释放后台 Task 与 LLM 连接
  - 前端清空 `useChatStore` 当前流状态，切至新会话并重新拉取历史，杜绝后台串流和幽灵生成。

**Markdown 渲染与安全性能规范**:
- 采用 `react-markdown` 搭配 `rehype-sanitize` 进行严格的 HTML 白名单过滤，彻底阻断 Skill 注入恶意 XSS 脚本。
- **流式打字机渲染防卡顿**: 流式接收期间使用 50ms 节流（Throttle）或 `useDeferredValue` 批量提交渲染，避免频繁触发 Prism/Shiki 语法高亮全量重解析导致界面掉帧。

**Skill选择器交互**(输入框内):
```
输入框内键入 "/"
  → 弹出Skill列表(向上悬浮,列表来自已安装且auto_trigger无关,全部可手动选)
  → 方向键↑↓选择,回车或点击确认
  → 选中后 "/" 及后续字符被替换成一个不可编辑的chip,光标定位在chip之后
  → chip右侧有×,点击移除
  → 未选择任何Skill直接发送:走AI自动判断trigger逻辑
```

**MCP能力开关**(顶部信息条的齿轮图标点击展开面板):
```
展开面板 → 列出所有已连接的MCP Server,每个带toggle开关
  → 开关变化立即调用 PUT /api/chat/{session_id}/capabilities 写入 session_capabilities,不需要单独保存按钮
```

**空状态**(`/chat`,未选中任何会话):居中显示"开始一段新对话"+ 输入框(和有会话时的输入框组件复用,发送后才真正创建session并跳转)。

### 5.3 会话管理侧边栏

**布局**:固定宽度240px,不可折叠(桌面场景不需要,如后续做移动端再加折叠)。

结构从上到下:新建对话按钮 → 搜索框 → 会话列表(按时间分组:今天/昨天/7天内/更早)→ 底部固定区(应用市场入口、设置入口)。

**会话列表项交互**:
```
悬停 → 出现"..."更多操作图标
点击"..." → 弹出菜单:重命名 / 置顶 / 删除
点击"重命名" → 标题变为可编辑input,失焦或回车调用 PATCH /api/sessions/{id}
点击"删除" → 二次确认弹窗(因为不可恢复)→ 确认后调用 DELETE /api/sessions/{id} 从列表移除,若当前正查看该会话则跳转到空状态页
搜索框输入 → 实时过滤列表(防抖300ms),无结果时显示"没有找到相关对话"
```

### 5.4 应用市场 `/marketplace`

**布局**:顶部Tab(发现/已安装/我的开发)→ 搜索框 → 分类筛选行(chip形式,单选)→ 卡片网格(3列)。

**发现页交互**:
```
点击分类chip → 立即过滤卡片网格(前端过滤,不重新请求,除非分类数据量大后续改成后端分页)
点击卡片 → 弹出详情Modal(遮罩层,非跳转页面)
详情Modal结构:
  头部:图标+名称+版本号+类型标签
  Tab:说明 / 版本历史 / 权限声明(仅当manifest.permissions非空时显示)
  底部:安装按钮(Skill)或连接按钮(MCP,点击后跳到"填写连接参数"的二级表单)
点击安装 → 按钮变loading → 成功后按钮变"已安装"(灰色不可点)+ toast提示"已安装"
```

**已安装页交互**:列表形式(非卡片,信息密度更高),每行:图标+名称+版本+"自动触发"toggle+卸载按钮。卸载需二次确认，点击后调用 `DELETE /api/marketplace/{id}/uninstall`。

**我的开发页交互**:
```
顶部"上传新Skill"按钮 → 弹出上传表单:manifest.json文件选择 + 代码包(zip)上传
点击上传 → 前端先校验manifest.json格式(必填字段:name/version/entry/input_schema/output_schema)
  → 格式错误:表单内联报错,标注具体缺失字段,不提交
  → 格式通过:上传到后端 (POST /api/my-plugins/upload),状态设为draft,出现在列表中
列表每行:名称+版本+状态标签(仅自己可见)+编辑/删除
```

### 5.5 设置页 `/settings`

**布局**:左侧二级导航(账号/外观/Skill与MCP/用量),右侧对应内容区。

**外观面板交互**:
```
主题切换:点击即时生效(不需要保存按钮),写入localStorage + 用户偏好表,下次登录读取
字体切换(无衬线/衬线)/字号滑块/密度切换:同样即时生效
```

**Skill与MCP管理面板**:复用应用市场"已安装"的列表组件,额外多一个"MCP连接"分区,每个连接展示:名称+连接状态(已连接/连接失败,红点提示)+ tool数量 + 编辑/删除/刷新Tools。

**用量仪表盘**:
```
页面加载 → 请求 GET /api/usage/summary
  → loading态:三个指标卡显示骨架屏
  → 成功:渲染Token消耗/预估费用/最耗费Skill三个指标卡 + 下方一个按天的用量折线图
  → 时间范围切换(本周/本月/全部):重新请求
```

### 5.6 效率功能范围约定
PRD 5.8 中涉及的效率功能（命令面板 Cmd/Ctrl+K、常用快捷指令模板、对话/产出物 Markdown 导出），属于前序核心链路（对话平台 + Skill/MCP 插件引擎 + 市场）跑通后的体验打磨功能，UI 上先行预留快捷键捕获入口，业务逻辑后续平滑挂载。

---

## 6. 状态管理设计(Zustand store划分)

```typescript
// useSessionStore: 会话列表、当前会话id、增删改查
interface SessionStore {
  sessions: Session[];
  currentSessionId: string | null;
  fetchSessions: () => Promise<void>;
  createSession: () => Promise<string>;
  updateSession: (id: string, data: Partial<Session>) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

// useChatStore: 当前打开会话的消息、流状态与控制器
interface ChatStore {
  messages: Message[];
  isStreaming: boolean;
  abortController: AbortController | null;
  loadMessages: (sessionId: string) => Promise<void>;
  sendMessage: (content: string, skillId?: string, parentId?: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
}

// useSkillStore: 已安装列表、会话激活能力
interface SkillStore {
  installedSkills: Skill[];
  activeSkills: string[];
  activeMcps: string[];
  fetchInstalled: () => Promise<void>;
  toggleAutoTrigger: (id: string) => Promise<void>;
}

// useSettingsStore: 外观偏好持久化 (localStorage)
interface SettingsStore {
  theme: 'light' | 'dark' | 'system';
  fontFamily: 'sans' | 'serif';
  fontSize: 'sm' | 'md' | 'lg';
  density: 'compact' | 'comfortable';
  setSetting: <K extends keyof SettingsStore>(key: K, value: SettingsStore[K]) => void;
}
```

**原则**:`useChatStore`只保存"当前打开会话"的消息,切换会话时清空重新拉取,不在前端维护所有会话的消息缓存(避免内存膨胀,消息历史交给后端分页查询)。

---

## 7. 关键流程时序与协议设计

### 7.1 用户发送消息的 Agent Loop 与 SSE 通信协议

#### 7.1.1 前后端 SSE 事件契约 (Event Stream Schema)

FastAPI 在 `POST /api/chat/{session_id}/messages` 返回 `Content-Type: text/event-stream`，协议严格遵循以下 Event 规范：

| Event 类型 | Data 载荷结构 | 说明 |
|---|---|---|
| `session_info` | `{"session_id": "uuid", "model": "..."}` | 推送会话基础信息与所用模型 |
| `tool_start` | `{"tool_call_id": "call_1", "tool_name": "skill__unit_test", "args": {...}}` | 触发工具调用，前端渲染折叠卡片 |
| `tool_result`| `{"tool_call_id": "call_1", "output": {...}, "duration_ms": 320}` | 工具执行完成，返回结构化输出 |
| `text_delta` | `{"text": "文本增量内容..."}` | 模型生成的最终回复正文流 |
| `usage` | `{"input_tokens": 1200, "output_tokens": 300, "cost_usd": 0.0045}` | 本次请求结算 token 与成本 |
| `done` | `{"status": "success"}` | 生成完毕，关闭 SSE 连接 |
| `error` | `{"code": "TIMEOUT", "message": "工具执行超时"}` | 错误中止通知 |

#### 7.1.2 Agent ReAct 循环与死循环熔断控制

```python
# 后端 chat_service.py 执行逻辑伪代码
async def handle_chat_stream(session_id: str, user_message: str, requested_skill_id: str = None):
    # 1. 组装上下文 (System Prompt + 最近历史消息截断，支持 parent_id 分支)
    messages = build_context_window(session_id)
    
    # 2. 挂载可用工具 (通过 ToolAdapter 统一定义命名空间)
    tools = registry.get_available_tools(session_id, requested_skill_id)
    tool_choice = {"type": "function", "function": {"name": f"skill__{skill.name}"}} if requested_skill_id else "auto"

    max_steps = 5  # 熔断上限: 单次交互最多允许 5 轮工具自循环
    current_step = 0

    while current_step < max_steps:
        current_step += 1
        # 调用 LLM API (Anthropic / OpenAI)
        response = await llm_client.chat_completion(messages=messages, tools=tools, tool_choice=tool_choice)
        
        if not response.has_tool_calls:
            # 无工具调用，直接向 SSE 流式推送 text_delta
            async for chunk in response.text_stream:
                yield format_sse("text_delta", {"text": chunk})
            break
        
        # 处理工具调用
        for tool_call in response.tool_calls:
            yield format_sse("tool_start", {"tool_call_id": tool_call.id, "tool_name": tool_call.name, "args": tool_call.args})
            
            # 分发执行 (Skill 沙箱或 MCP Client)
            result = await execute_tool(tool_call.name, tool_call.args)
            
            yield format_sse("tool_result", {"tool_call_id": tool_call.id, "output": result})
            
            # 将 assistant 的 tool_call 和 tool 的结果写回上下文队列，继续下一轮循环
            messages.append({"role": "assistant", "tool_calls": [tool_call]})
            messages.append({"role": "tool", "tool_call_id": tool_call.id, "content": json.dumps(result)})
    
    # 3. 记录数据库消息与用量日志
    await persist_messages_and_usage(session_id, messages, usage)
    yield format_sse("done", {"status": "success"})
```

#### 7.1.3 停止生成机制 (Stop Generation)
- 后端维护全局内存任务注册表 `RUNNING_TASKS: dict[str, asyncio.Task]`。
- 收到 `POST /api/chat/{session_id}/stop` 时：
  1. 查找对应 `session_id` 的异步 Task，调用 `task.cancel()`；
  2. 若沙箱子进程正在运行，向其 `pid` 发送 `SIGKILL`；
  3. 将当前已生成的部分内容持久化为 status='failed'，立即向客户端响应关闭连接。

### 7.2 安装与执行 Skill 的完整链路

```
市场详情 Modal 点击"安装"
  → POST /api/marketplace/{id}/install
  → 后端:
      1. 校验 manifest.json (name, version, entry, input_schema, output_schema)
      2. 将代码包存入 Supabase Storage: skills/{user_id}/{name}/{version}.zip
      3. 解压到本地工作区缓存目录: /tmp/devagent/sandboxes/{skill_id}/
      4. 写入 installed_skills 数据库表
  → 前端: useSkillStore.installedSkills 追加该项并更新 UI
```

### 7.3 MCP Client 连接生命周期 (云端 Web 架构)

- **传输协议收敛**: 因部署在云端容器（Railway/Render），Web 端**仅支持 `remote_url` (SSE/HTTP Transport)**。`local_command` (stdio) 仅保留作为未来桌面端本地运行时的扩展能力。
- **连接池单例**: 后端 `McpClientManager` 维护所有启用的 MCP Server 长连接池，避免重复握手。
- **Tool Discovery**:
  - 创建连接或点击刷新（`POST /api/mcp/connections/{id}/refresh`）时，向 MCP Server 发送 `tools/list` 请求；
  - 将获取的工具定义缓存至 `mcp_connections.tools` (jsonb)，Agent Loop 运行时直接读取本地缓存，无需每次轮询 MCP Server。

---

## 8. 非功能性需求与运行环境配置

### 8.1 环境变量规范 (`apps/api/core/config.py`)

后端启动必须具备以下环境变量，未配置直接阻止应用启动：

```ini
# Supabase
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...      # Service Role Key (用于后端管理)
SUPABASE_JWT_SECRET=your-jwt-secret                     # 用于本地解密校验客户端 Session Token

# 模型调用
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-...

# 服务端配置
CORS_ORIGINS=http://localhost:3000,https://your-domain.vercel.app
STORAGE_BUCKET_SKILLS=skills
SANDBOX_CACHE_DIR=/tmp/devagent/sandboxes
```

### 8.2 鉴权与行级安全 (RLS)
- 除 `/login` 外，所有前端请求通过 Header `Authorization: Bearer <token>` 携带 Supabase Auth Token。
- 后端 FastAPI 依赖注入 `get_current_user` 校验 JWT，解析得到 `user_id` 并将其透传至 Repository 层与上下文。
- 数据库全部表开启 RLS，策略约束 `auth.uid() = user_id`，防止水平越权。

### 8.3 上下文窗口管理 (Context Truncation)
- 对话上下文随轮次增长，为防止单次请求超出模型窗口上限（抛出 400 Bad Request），`chat_service` 执行滑动窗口截断：
  - 恒定保留 System Prompt；
  - 优先保留最新 10~20 轮对话消息；
  - 对历史消息中包含大文本输出的 `tool_result`，仅保留摘要或在超长时剔除较早轮次的 tool 输出。

### 8.4 成本控制与用量记录
- 每次 LLM 请求结束后（无论成功还是客户端中断），必须在 `finally` 块中向 `usage_logs` 表插入一条记录，写入具体 `model`、`input_tokens`、`output_tokens` 及根据当前模型单价折算的 `cost_usd`，不允许有调用路径绕过用量审计。

### 8.5 错误提示文案
- 参考 CDS 规范：说清楚发生了什么 + 提供明确的下一步操作。不用 "Error:" 前缀，系统 UI 严禁使用第一人称 "我"。

---

## 9. 演进阶段与范围说明

本文档完整覆盖基础对话平台、Skill/MCP 扩展机制、应用市场与用量监控的整体技术设计。项目采用能力演进模型推进，不设死板的完成时间限制，以每个阶段功能完整可演示为准：

1. **阶段一（基础对话平台）**: Next.js + FastAPI + Supabase Auth 登录墙、多会话管理、流式对话、外观设置；
2. **阶段二（Skill 与 MCP 核心机制）**: Manifest 格式规范、统一 ToolAdapter、`/` Skill 选择器、MCP Client (remote_url)、沙箱隔离执行；
3. **阶段三（应用市场与扩展）**: 插件发现、详情权限声明、安装/卸载与本地缓存、自研插件上传；
4. **阶段四（旗舰 Skill 包: 研发流程助手）**: 作为首个业务 Skill 单独设计，实现状态机、代码 RAG (pgvector)、Agent Loop 与 diff 生成；
5. **阶段五（体验与深度打磨）**: 命令面板 (Cmd+K)、常用指令模板、Markdown 产出物导出、高级沙箱容器化。