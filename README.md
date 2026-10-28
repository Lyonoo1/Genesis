# Genesis - 下一代全栈 AI 智能体研发工作台

Genesis 是面向专业工程师的高性能、可扩展 AI 智能体研发工作台（AI Agent Workbench）。融合 ReAct 智能体编排循环、Claude Code 级安全代码重构引擎、全双工终端仿真、隔离子代理（Subagent）、实时网页渲染探针与本地反向隧道 Bridge，构建开箱即用的 AI 协同开发环境。

---

## 目录

- [核心能力与技术架构](#核心能力与技术架构)
  - [1. 智能体 ReAct 编排与全双工流式引擎](#1-智能体-react-编排与全双工流式引擎)
  - [2. 工业级工作区工具与影子 Git 快照](#2-工业级工作区工具与影子-git-快照)
  - [3. 零死锁异步终端与进程管理](#3-零死锁异步终端与进程管理)
  - [4. 隔离子代理系统 (Subagent Isolation)](#4-隔离子代理系统-subagent-isolation)
  - [5. 三道闸门权限管线 (Permission Guard)](#5-三道闸门权限管线-permission-guard)
  - [6. 本地反向长连接隧道 (Genesis Bridge)](#6-本地反向长连接隧道-genesis-bridge)
  - [7. 实时网页预览与运行时探针 (Preview Bridge)](#7-实时网页预览与运行时探针-preview-bridge)
  - [8. MCP 协议集成与 Skill 沙箱引擎](#8-mcp-协议集成与-skill-沙箱引擎)
  - [9. 双模持久化 (SQLite / Supabase)](#9-双模持久化-sqlite--supabase)
- [快速上手指南](#快速上手指南)
  - [前置依赖](#前置依赖)
  - [依赖安装](#依赖安装)
  - [环境变量配置](#环境变量配置)
  - [本地一键联调](#本地一键联调)
  - [单元测试与质量验证](#单元测试与质量验证)
  - [Genesis Local Bridge 接入本地项目](#genesis-local-bridge-接入本地项目)
  - [Docker 容器化与生产部署](#docker-容器化与生产部署)
- [SSE 事件流协议参考](#sse-事件流协议参考)
- [项目目录结构与二次开发指引](#项目目录结构与二次开发指引)

---

## 核心能力与技术架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Genesis Web Frontend                            │
│   Next.js 14 App Router + Tailwind CSS + Zustand + Monaco + Xterm.js   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ HTTP / SSE / WebSocket
┌──────────────────────────────────▼─────────────────────────────────────┐
│                        Genesis Core API (FastAPI)                      │
│ ┌───────────────────────────┐         ┌──────────────────────────────┐ │
│ │  Agent ReAct Loop Engine  │◄───────►│  Context Manager (L1 Gate)   │ │
│ └─────────────┬─────────────┘         └──────────────────────────────┘ │
│               │                                                        │
│ ┌─────────────▼─────────────┐         ┌──────────────────────────────┐ │
│ │ Permission Pipeline (1-3) │         │ Subagent Runner (Explore/Ver)│ │
│ └─────────────┬─────────────┘         └──────────────────────────────┘ │
│               │                                                        │
│ ┌─────────────▼──────────────────────────────────────────────────────┐ │
│ │ Workspace Tools (Edit/Write/Grep/Find/Bash) & ShadowGit Checkpoint │ │
│ └─────────────┬──────────────────────────────────────────────────────┘ │
│               │                                                        │
│ ┌─────────────▼─────────────┐         ┌──────────────────────────────┐ │
│ │ Local Bridge (WS RPC)     │         │ MCP Client & Skill Engine    │ │
│ └───────────────────────────┘         └──────────────────────────────┘ │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│                 Persistence: SQLite (WAL) / Supabase                   │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. 智能体 ReAct 编排与全双工流式引擎
- **全双工 SSE 流式响应**：遵循 W3C 标准，响应头自带 `X-Accel-Buffering: no` 强行击穿 Nginx/Caddy/Cloudflare 等反向代理缓冲，保证零延迟打字机体验。
- **深度思考与旁路分流**：
  - 完整适配 DeepSeek-R1、OpenAI o1/o3-mini、Claude 3.7 Sonnet 等推理模型的思考过程 (`reasoning_content` / `reasoning_delta`)。
  - 会话标题异步生成内置旁路轻量模型路由字典（如 `deepseek-r1` 自动分流至 `deepseek-chat`，`claude-3-7-sonnet` 分流至 `claude-3-5-haiku`），避免消耗主模型昂贵的上下文与时间。
- **运行中实时插话 (Mid-task Steering)**：当 Agent 正在执行多步工具调用链路时，调用 `/api/chat/{session_id}/steer` 可在队列中直接注入指令。底层任务不打断，在下一步前自动根据用户插话转向。
- **秒级任务熔断**：通过 `RUNNING_TASKS` 全局注册表，前端可随时取消 `asyncio.Task` 并优雅回收所有子协程与子进程。

### 2. 工业级工作区工具与影子 Git 快照
- **四级降级智能局部匹配编辑 (`workspace__edit_file`)**：
  - **Tier 1**：精确字符串匹配。
  - **Tier 2**：忽略行尾多余空白符匹配。
  - **Tier 3**：忽略缩进偏移量，按命中行的缩进差自动对齐（Auto-Indentation Alignment）。
  - **Tier 4**：滑动窗口代码相似度计算；若高于 50% 相似度则回传带有真实行号的上下文片段，拒绝盲目瞎改。
- **AST 语法自愈预检**：支持 Tree-sitter 多语言解析（降级为 Python 内置 `ast.parse` 与 `json.loads`），在代码落地写入后立即检测语法异常，自动附带警告信息促使 Agent 自主修复。
- **结构化 Unified Diff 生成**：每次读写或替换自动计算统一 Diff、添加行数与删除行数，直接向前端推送可视化 Code Diff。
- **独立影子 Git 快照 (`ShadowGitCheckpoint`)**：
  - 基于独立的 `GIT_DIR`（`.genesis/shadow_git`）与全局忽略规则，与用户日常主 Git 提交彻底物理隔离。
  - 在执行关键写入/删除操作前自动生成快照，支持秒级 100% 回滚工作区（`git read-tree --reset -u && git clean -fd`）。
- **路径防穿越 (Path Traversal Guard)**：所有文件操作强制经过 `resolve_safe_path` 校验，阻断任何通过 `../` 越权访问工作区外部敏感路径的风险。
- **输出截断与磁盘转存 (Claude Code s08 范式)**：当控制台输出或检索结果超长时，自动溢出转存至磁盘（`.genesis_outputs/tool-results/`），保留首尾各 20 行，并把物理文件路径回传给模型。

### 3. 零死锁异步终端与进程管理
- **异步 Shell 执行器 (`workspace__execute_command`)**：
  - 后台常驻排空协程持续消费子进程 stdout/stderr，彻底杜绝操作系统 64KB 管道缓冲区写满导致的进程永久挂死（Deadlock）。
  - 支持后台守护任务智能探测（自动匹配 `vite`、`next dev`、`uvicorn`、`http.server` 等命令正则，或显式传入 `is_background: true`）。
  - 内置端口就绪探针，在进程拉起后 4.5 秒内自动扫描输出日志捕获监听端口并提取 `http://localhost:<port>` 预览地址。
- **进程组连根拔起**：启动时采用 `start_new_session=True`，超时熔断或手动取消时通过 `os.killpg(pgid, SIGKILL)` 清理整个进程树，杜绝僵尸进程。
- **Web 终端仿真 (PTY + Xterm.js)**：
  - 基于 POSIX `openpty()` 分配真实主从伪终端，绑定控制终端 `TIOCSCTTY`。
  - 维护最大 512KB 的环形终端历史缓存，断线重连即时回放控制台画面。

### 4. 隔离子代理系统 (Subagent Isolation)
解决大范围代码检索污染主会话上下文的核心机制：
- **Explore Subagent**：纯只读探索模式，仅授予 `read_file`、`grep_search`、`find_by_name`、`list_dir` 权限，深入架构检索后提炼高密度结论。
- **Verify Subagent**：测试验证模式，仅开放只读与 `execute_command` 运行测试用例，精确定位报错原因。
- **沙箱隔离**：子代理内部 ReAct 循环独立运行，上限 8 步，输出硬限制在 2000 字符内，数万中间过程 Token 用后即焚。

### 5. 三道闸门权限管线 (Permission Guard)
- **闸门 1（硬拒绝黑名单）**：永久阻断高危指令（如 `rm -rf /`、`sudo`、`:(){ :|:& };:` fork bomb 等）。
- **闸门 2（破坏性与敏感规则）**：正则识别高危破坏行为（`drop table`、`chmod 777`、`rmdir`）以及对敏感配置（`.env*`、`.git`、`.ssh`、`.aws`）的非法访问。
- **闸门 3（人机协同审批）**：触发拦截时挂起 `asyncio.Future`，向前端推送交互确认通知，经开发者明确授权（Allow/Deny）后方可继续执行。

### 6. 本地反向长连接隧道 (Genesis Bridge)
- 零外部依赖的 Node.js 18+ 原生客户端 (`scripts/genesis-bridge.mjs`)。
- 本地设备主动通过 WSS/WS 发起出站连接至云端 Genesis 服务端，经 JWT Token 安全鉴权后与当前用户绑定。
- **无需公网 IP、无需配置路由器 NAT 穿透**，云端 Agent 即可透明代理执行本地物理机文件读写与终端命令。

### 7. 实时网页预览与运行时探针 (Preview Bridge)
- 内置工作区静态文件与单页应用预览代理路由（`/api/preview/*`）。
- 自动为 HTML 注入 `__genesis_preview_bridge__` 探针脚本，实时捕获 iframe 内部的 `window.onerror`、`unhandledrejection` 与 `console.error`，通过 `postMessage` 回传给外部工作台，辅助 Agent 自动定位前端运行时崩溃。

### 8. MCP 协议集成与 Skill 沙箱引擎
- **Model Context Protocol (MCP)**：支持接入外部标准 MCP Server（stdio / sse），自动发现工具并注入隔离命名空间（`mcp__<server>__<tool>`），直接转换为标准 Function Calling Schema。
- **Skill 插件沙箱**：本地安装的自定义技能运行于隔离临时目录，内置超时硬上限（默认 30 秒）防卡死。
- **官方插件市场**：内置前端构建、自动化代码审查等插件模版。

### 9. 双模持久化 (SQLite / Supabase)
- **开箱即用 SQLite**：默认开启 WAL（Write-Ahead Logging）模式，零配置运行所有项目、会话、消息、模型配置与终端元数据。
- **云端 Supabase 协同**：支持配置 Supabase URL 与 JWT Secret，本地/云端多写同步与严格的行级安全隔离（RLS）。

---

## 快速上手指南

### 前置依赖

- **Python** >= 3.11
- **uv** (极速 Python 包与虚拟环境管理器): `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **Node.js** >= 18.17.0
- **pnpm** >= 8: `npm install -g pnpm`

### 依赖安装

在 Genesis 根目录下执行：
```bash
make install
```
该命令会自动完成：
1. `cd api && uv sync`：安装后端所有 Python 依赖与虚拟环境。
2. `cd web && pnpm install`：安装前端 Next.js 所有依赖。

### 环境变量配置

#### 1. 后端配置 (`api/.env`)
从模版复制：
```bash
cp api/.env.example api/.env
```
修改核心字段：
```ini
ENVIRONMENT=development
PORT=8000
FRONTEND_URL=http://localhost:3000

# LLM 密钥（至少填写一个供 Agent 驱动）
OPENAI_API_KEY=sk-xxxx
OPENAI_BASE_URL=https://api.openai.com/v1   # 支持中转或第三方兼容 API (DeepSeek, Qwen 等)

# 可选：Anthropic
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1

# 可选：Supabase（不填则默认纯本地 SQLite 模式）
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-or-service-key
SUPABASE_JWT_SECRET=your-supabase-jwt-secret
```

#### 2. 前端配置 (`web/.env.local`)
从模版复制：
```bash
cp web/.env.example web/.env.local
```
```ini
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
# 可选：Supabase 认证模式
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

### 本地一键联调

Genesis 提供了自动化端口校验与环境检查的联调脚本：
```bash
make dev
```
- 后端地址：`http://127.0.0.1:8000` (Swagger 交互文档: `http://127.0.0.1:8000/docs`)
- 前端地址：`http://localhost:3000`
- 脚本会自动检测 8000 与 3000 端口占用；按下 `Ctrl+C` 时会通过捕获 `SIGINT/SIGTERM` 彻底终止前后端子进程，不留残留孤儿进程。

若需分别单独启动：
```bash
make dev-api   # 仅启动 FastAPI (:8000)
make dev-web   # 仅启动 Next.js (:3000)
```

### 单元测试与质量验证

执行前后端全量校验：
```bash
make test
```
或单独运行：
```bash
make test-api   # 运行 pytest 全量单测套件
make test-web   # 运行 Next.js ESLint 与 TypeScript 静态检查
```

### Genesis Local Bridge 接入本地项目

若你的 Genesis 部署在云端服务器，而你想让 Agent 操作你本地电脑上的项目目录：

1. 登录 Genesis 前端，在「设置」页面复制你的登录 **JWT Token**。
2. 在本地电脑的项目目录下执行：
   ```bash
   node /path/to/Genesis/scripts/genesis-bridge.mjs \
     --server https://your-genesis-domain.com \
     --token <YOUR_JWT_TOKEN> \
     --dir .
   ```
3. 终端显示 `Genesis 云端网关已成功建立本地 Bridge 隧道连接` 后，云端智能体即可直接感知并安全操作你当前的物理工作区。

### Docker 容器化与生产部署

#### 开发容器编排
```bash
make docker-up     # 启动容器编排
make docker-down   # 停止容器编排
```

#### 生产容器编排 (含 Nginx 反向代理与持久化挂载)
```bash
make prod-up       # 生产环境后台拉起 (docker-compose.prod.yml)
make prod-logs     # 查看生产容器实时日志
make prod-down     # 优雅关闭生产容器
```

---

## SSE 事件流协议参考

在会话中调用 `POST /api/chat/{session_id}/completion`，返回事件流如下：

| 事件名 (`event`) | 说明 | 数据载荷核心字段 (`data`) |
| :--- | :--- | :--- |
| `text_delta` | 最终回复正文流式切片 | `{"delta": "代码已生成..."}` |
| `reasoning_delta` | 深度思考模型推理过程切片 | `{"delta": "正在分析 AST 结构..."}` |
| `tool_call_start` | 工具调用发起 | `{"tool_call_id": "call_1", "name": "workspace__edit_file", "args": {...}}` |
| `tool_call_result`| 工具执行完成并返回结果 | `{"tool_call_id": "call_1", "result": {...}, "status": "success"}` |
| `step_finish` | 单步 ReAct 结束 | `{"step": 1, "model": "gpt-4o"}` |
| `workbench_file_change` | 工作台文件发生变更 (触发编辑器刷新) | `{"path": "src/App.tsx", "diff": "...", "additions": 10, "deletions": 2}` |
| `workbench_preview` | 探测到 Web 预览地址 | `{"url": "http://localhost:5173", "pid": 12345}` |
| `workbench_todos` | 任务状态机更新 | `{"todos": [{"id": "1", "content": "重构入口", "status": "completed"}]}` |
| `subagent_progress`| 隔离子代理进度广播 | `{"agent_type": "explore", "step": 2, "message": "正在检索目录..."}` |
| `mid_task_steered` | 实时插话生效通知 | `{"content": "请优先使用 Tailwind v3", "status": "enqueued"}` |
| `session_title_updated` | 会话标题智能提炼完成 | `{"title": "重构用户认证组件"}` |
| `done` | 对话轮次全部处理完成 | `{"session_id": "...", "metrics": {"total_tokens": 1280}}` |
| `error` | 异常报错通知 | `{"code": "INTERNAL_SERVER_ERROR", "message": "..."}` |

---

## 项目目录结构与二次开发指引

```
Genesis/
├── Makefile                 # 统一工程命令集 (make dev / test / install / clean / docker)
├── docker-compose.yml       # 开发环境 Docker 编排
├── docker-compose.prod.yml  # 生产环境 Docker 编排 (带 Nginx)
├── nginx/                   # Nginx 生产反向代理配置
├── scripts/
│   ├── dev.sh               # 端口检测、环境初始与优雅关闭联调脚本
│   ├── deploy.sh            # 自动化发布流水线脚本
│   └── genesis-bridge.mjs   # 本地反向 WebSocket 隧道客户端
├── supabase/                # Supabase 数据库迁移、RLS 策略与 Seed 数据
├── api/                     # FastAPI 后端核心引擎
│   ├── main.py              # 服务入口、全局中间件、异常捕获与生命周期
│   ├── core/
│   │   ├── config.py        # Pydantic 强类型环境变量设置
│   │   ├── database.py      # Supabase Client 依赖注入
│   │   ├── sqlite_db.py     # 本地持久化 SQLite 引擎 (WAL 模式)
│   │   ├── security.py      # JWT 鉴权校验器与当前用户提取
│   │   └── exceptions.py    # 统一业务异常与状态码映射
│   ├── routers/             # 业务 REST / WebSocket 路由分发
│   │   ├── chat.py          # 对话 ReAct 循环、SSE 推送与插话端点
│   │   ├── bridge.py        # Local Bridge 反向长连接隧道网关
│   │   ├── terminal.py      # Web 终端 WebSocket 通信与生命周期路由
│   │   ├── preview.py       # 静态文件代理与 Preview 探针注入路由
│   │   ├── sessions.py      # 对话会话与消息历史管理
│   │   ├── projects.py      # 工作区项目工作空间
│   │   ├── mcp.py           # MCP Server 注册与动态工具发现
│   │   ├── skills.py        # 本地技能与沙箱执行路由
│   │   ├── marketplace.py   # 官方插件市场
│   │   └── models.py        # 用户自定义大模型配置管理
│   ├── services/            # 核心业务与领域模型服务
│   │   ├── chat_service.py  # Agent ReAct 驱动与事件编排主逻辑
│   │   ├── workspace_tool_executor.py # 局部匹配编辑、影子 Git、命令异步执行器
│   │   ├── subagent_runner.py         # 隔离子代理 (Explore/Verify) 调度引擎
│   │   ├── permission_manager.py      # 三道闸门权限决策管线
│   │   ├── context_manager.py         # L1 输出守门员与长上下文压缩
│   │   ├── terminal_manager.py        # PTY 进程隔离与终端环形缓存
│   │   ├── bridge_manager.py          # 本地 Bridge WebSocket 注册与 RPC 代理
│   │   ├── preview_service.py         # Preview 桥接探针脚本注入
│   │   ├── todo_manager.py            # 结构化待办任务状态机
│   │   ├── tool_adapter.py            # 工具命名空间转换与 Schema 适配
│   │   ├── skill_engine.py            # Skill 本地沙箱执行引擎
│   │   └── llm_adapter.py             # 多大模型提供商统一适配层
│   └── tests/               # Pytest 单元与集成测试套件
└── web/                     # Next.js 14 前端交互工作台
    ├── app/                 # App Router 路由布局
    ├── components/
    │   ├── chat/            # 对话面板、思考折叠区、工具调用状态卡片
    │   ├── workbench/       # Monaco Editor 代码编辑区、Diff 对比视图、Preview iframe
    │   ├── terminal/        # Xterm.js 终端集成面板
    │   ├── sidebar/         # 项目与会话列表、归档管理
    │   ├── marketplace/     # 插件市场面板
    │   └── modals/          # 权限审批弹窗、设置面板
    ├── stores/              # Zustand 状态管理 (useChatStore, useWorkbenchStore 等)
    └── lib/                 # API 客户端与工具类
```

### 二次开发常见场景

#### 1. 新增内置工作区工具
1. 在 [tool_adapter.py](file:///Users/lyon/Desktop/agentProject/Genesis/api/services/tool_adapter.py) 的 `BUILTIN_WORKSPACE_TOOLS` 列表中定义工具的 Function Calling JSON Schema。
2. 在 [workspace_tool_executor.py](file:///Users/lyon/Desktop/agentProject/Genesis/api/services/workspace_tool_executor.py) 的 `WorkspaceToolExecutor` 中编写对应的执行方法。
3. 在 [chat_service.py](file:///Users/lyon/Desktop/agentProject/Genesis/api/services/chat_service.py) 的工具分拣执行分支中绑定该实现。

#### 2. 添加权限管控拦截
- 涉及高危操作判断，在 [permission_manager.py](file:///Users/lyon/Desktop/agentProject/Genesis/api/services/permission_manager.py) 的 `evaluate` 方法中增加匹配规则，返回 `PermissionDecision.DENY`（直接阻断）或 `PermissionDecision.ASK`（挂起并推送到前端由用户手动审批）。

#### 3. 接入自定义 MCP Server
- 通过前端「设置 -> MCP 管理」或直接调用 `POST /api/mcp/servers` 传入 `command`、`args` 或 `endpoint`，系统将自动发起协议握手并把探测到的外部工具融入 ReAct 决策流中。
