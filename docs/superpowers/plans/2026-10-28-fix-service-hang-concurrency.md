# 修复子代理与多会话并发导致服务挂死/卡顿的技术计划书

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底解决并发运行子代理（Subagent）及多会话并发测试时后端接口全局卡死（所有 HTTP 请求在 DevTools 中无限 pending、数据库死锁、前端打字机停滞）的问题，保障单机环境下事件循环流畅度、SQLite 连接安全与任务秒级取消。

**Architecture:**
1. **SQLite 核心层重构**：将 `get_db_connection()` 重构为标准 `@contextmanager` 闭环生成器，确保每次操作无论成功还是抛异常都执行 `conn.close()`；移除连接时重复执行 `PRAGMA journal_mode=WAL`（仅在启动初始化执行一次），设置 `busy_timeout=15000` 消除并发写锁饿死。
2. **工具执行全面异步解耦**：将 `WorkspaceToolExecutor` 的同步阻塞操作（`grep_search`、`find_by_name`、`read_file`、`list_dir` 等）全部通过 `asyncio.to_thread` 投递至后台线程池，并加上 15s 熔断超时，彻底解放 FastAPI/Uvicorn 主事件循环。
3. **文件扫描深度与数量守卫**：扩充黑名单排除目录（`.turbo`、`.cache`、`coverage` 等），为 `os.walk` 增加最大扫描层数（8 层）与最大扫描文件数（2000 个）硬限制，杜绝 2C2G 资源打满。
4. **子代理并发节流与取消链路打通**：在 `chat_service.py` 中引入 `asyncio.Semaphore(2)` 限制单次并行子代理上限；优化 `CancelledError` 捕获与级联传播，确保停止生成或 SSE 断开时毫秒级回收所有子代理和进程。

**Tech Stack:** FastAPI, Python 3.12, asyncio, SQLite3 (WAL mode), pytest

---

## 根因定位与分析 (Root Causes)

在排查代码库后，发现服务在“起子代理 + 多会话并发”时挂死是由以下 **4 个致命技术根因叠加造成的级联雪崩**：

### 1. 致命根因一：SQLite 连接严重泄漏与写锁排他争死 (`api/core/sqlite_db.py`)
- **现象**：`get_db_connection()` 仅返回 `sqlite3.connect(...)`，业务代码统一写作 `with get_db_connection() as conn:`。
- **根因**：在 Python 标准库 `sqlite3` 中，**`with conn:` 仅仅管理事务的 commit/rollback，根本不会调用 `conn.close()`！**
- **恶果**：每次查询或写入数据库（消息入库、更新指标、更新标题、读取会话）都会新开一个未关闭的底层连接与文件句柄。当多个会话并发或子代理频繁写库时，积攒数十个未关闭连接。更致命的是，函数内每次都执行 `PRAGMA journal_mode=WAL;`，在已有活跃事务未关闭时尝试获取独占锁，引发全局数据库锁死（`database is locked`），所有正在等待数据库的请求全部卡死挂起！

### 2. 致命根因二：子代理与文件工具同步霸占单事件循环 (`api/services/subagent_runner.py`)
- **现象**：前端发起新请求（如 `/api/sessions`、`/api/auth/me` 或点击 Stop 中止）完全无响应，在浏览器 Network 面板全部显示 `(pending)`。
- **根因**：FastAPI/Uvicorn 在单 worker 模式下只有一个主事件循环线程。`subagent_runner.py`（以及 `chat_service.py` 内部）直接在 `async` 协程内同步调用了 `WorkspaceToolExecutor.grep_search(...)`、`find_by_name(...)`、`read_file(...)`。
- **恶果**：`os.walk` 递归遍历工作区磁盘与正则逐行匹配是 CPU/磁盘密集型纯同步代码。当子代理执行 8 步探索循环时，主线程被长时间独占，事件循环彻底停摆，所有其他 HTTP 请求根本得不到调度。

### 3. 致命根因三：任务取消信号无法打断同步阻塞代码 (`api/services/chat_service.py`)
- **现象**：用户在界面点击“停止生成”或中断连接，接口依然卡住几分钟甚至直到超时。
- **根因**：Python `asyncio.Task.cancel()` 只能在协程的 `await` 切入点才能抛出 `CancelledError`。如果当前任务正卡在同步的文件读取、递归遍历或 SQLite 锁等待中，取消信号根本无法注入，必须等待同步代码耗尽超时（30s）才可能释放。

### 4. 致命根因四：单节点有限算力（2C2G）下的无边界扫描
- **现象**：服务器 CPU 飙升 100%，内存吃紧，甚至触发 Linux 隐式降频。
- **根因**：若工作区存在深层目录结构，旧代码未限制最大扫描层数与最大检查文件数，一旦子代理触发大范围通配检索，磁盘 I/O 和内存瞬间打满。

---

## Global Constraints
- Python 3.12 兼容性
- 保持前端现有 SSE 事件规范与数据结构 100% 兼容（不改变前端解析协议）
- 维持单机单文件 SQLite3 存储，利用 WAL 模式提供高读写并发
- 所有的测试使用 `uv run pytest tests/...` 执行

---

## 详细任务拆解 (Implementation Tasks)

### Task 1: 重构 SQLite 连接管理器与生命周期（彻底杜绝连接泄漏与锁争抢）

**Files:**
- Modify: `api/core/sqlite_db.py:1-35`
- Test: `api/tests/test_sqlite_concurrency.py`

**Interfaces:**
- Consumes: `sqlite3`, `contextlib.contextmanager`
- Produces: `@contextmanager def get_db_connection() -> Generator[sqlite3.Connection, None, None]`

- [ ] **Step 1: 编写并发读写与连接自动关闭的失败验证测试**
  在 `api/tests/test_sqlite_concurrency.py` 中编写多线程/多协程并发写入 50 条消息与读取的测试用例，并断言连接在操作后已完全关闭、无锁争抢挂起。

- [ ] **Step 2: 运行测试验证**
  Run: `cd api && uv run pytest tests/test_sqlite_concurrency.py -v`

- [ ] **Step 3: 重构 `api/core/sqlite_db.py` 中的 `get_db_connection`**
  - 使用 `@contextmanager` 包装，在 `finally` 块中强制执行 `conn.close()`。
  - 移除每次连接时重复执行的 `PRAGMA journal_mode=WAL;`，改为仅在 `init_sqlite_db()` 中设置一次持久化生效。
  - 将 `PRAGMA busy_timeout=15000;` 设为 15 秒并配置 `PRAGMA synchronous=NORMAL;`。
  - 确保所有 CRUD 函数内的 `with get_db_connection() as conn:` 均能在上下文退出时自动调用 `conn.close()`。

- [ ] **Step 4: 运行测试验证通过**
  Run: `cd api && uv run pytest tests/test_sqlite_concurrency.py -v`

- [ ] **Step 5: 提交更改**
  ```bash
  git add api/core/sqlite_db.py api/tests/test_sqlite_concurrency.py
  git commit -m "fix(db): ensure sqlite connections close properly and eliminate lock contention"
  ```

---

### Task 2: 工作区文件检索安全守卫与全局异步化（彻底脱离事件循环）

**Files:**
- Modify: `api/services/workspace_tool_executor.py:165-200, 1085-1265`
- Modify: `api/services/subagent_runner.py:270-320`
- Modify: `api/services/chat_service.py:840-870`
- Test: `api/tests/test_workspace_async.py`

**Interfaces:**
- Consumes: `asyncio.to_thread`, `asyncio.wait_for`
- Produces: 非阻塞式工具调用管线，最大目录深度为 8，最大扫描文件数为 2000

- [ ] **Step 1: 编写事件循环非阻塞测试**
  在 `api/tests/test_workspace_async.py` 中编写测试：在主事件循环中启动后台心跳定时器（每 10ms 记录一次时间），同时并发执行大目录 `grep_search` 与 `find_by_name`，断言心跳定时器延迟波动不超过 50ms（证明主事件循环未被同步阻塞）。

- [ ] **Step 2: 运行测试验证失败**
  Run: `cd api && uv run pytest tests/test_workspace_async.py -v`

- [ ] **Step 3: 优化 `WorkspaceToolExecutor` 检索守卫**
  - 扩展 `EXCLUDED_SEARCH_DIRS`，加入 `.turbo`, `.cache`, `coverage`, `.output`, `.nuxt`, `target`, `vendor`, `.gemini`。
  - 在 `grep_search` 和 `find_by_name` 的 `os.walk` 中引入 `max_depth = 8` 和 `max_files_scanned = 2000` 熔断机制，超限自动跳出并标记 `truncated = True`。

- [ ] **Step 4: 将 `subagent_runner.py` 与 `chat_service.py` 工具调用全线异步化**
  - 在 `subagent_runner.py` 中，将所有文件读写和搜索调用（`read_file`, `grep_search`, `find_by_name`, `list_dir`）包裹在 `await asyncio.wait_for(asyncio.to_thread(...), timeout=15.0)` 中。
  - 在 `chat_service.py` 的普通工具分发中，对 `grep_search` 与 `find_by_name` 同样包裹在 `asyncio.to_thread` 中并施加超时。

- [ ] **Step 5: 运行测试验证通过**
  Run: `cd api && uv run pytest tests/test_workspace_async.py -v`

- [ ] **Step 6: 提交更改**
  ```bash
  git add api/services/workspace_tool_executor.py api/services/subagent_runner.py api/services/chat_service.py api/tests/test_workspace_async.py
  git commit -m "perf(tools): offload workspace tools to thread pool and enforce scan boundaries"
  ```

---

### Task 3: 子代理并发流控与取消中断链路强化（防止级联雪崩）

**Files:**
- Modify: `api/services/chat_service.py:1060-1160`
- Modify: `api/services/subagent_runner.py:130-170`
- Test: `api/tests/test_subagent_cancellation.py`

**Interfaces:**
- Consumes: `asyncio.Semaphore(2)`, `asyncio.CancelledError`
- Produces: 优雅中断且不残留孤儿子任务的并发子代理管线

- [ ] **Step 1: 编写子代理取消响应速度测试**
  在 `api/tests/test_subagent_cancellation.py` 中启动一个正在运行多步循环的 Subagent 任务，调用 `task.cancel()`，断言任务在 300ms 内退出并且状态标志被清除。

- [ ] **Step 2: 运行测试验证**
  Run: `cd api && uv run pytest tests/test_subagent_cancellation.py -v`

- [ ] **Step 3: 实现并发子代理信号量节流与异常清理**
  - 在 `chat_service.py` 中，使用 `asyncio.Semaphore(2)` 限制同时运行的子代理数量，超出排队，避免突发打满资源。
  - 在 `_run_single_subagent` 中精细化捕获 `asyncio.CancelledError`，确保当父级 Task 取消时，子任务立即退出，且不会向已关闭的队列/生成器继续 yield 导致报错。

- [ ] **Step 4: 运行测试验证通过**
  Run: `cd api && uv run pytest tests/test_subagent_cancellation.py -v`

- [ ] **Step 5: 提交更改**
  ```bash
  git add api/services/chat_service.py api/services/subagent_runner.py api/tests/test_subagent_cancellation.py
  git commit -m "fix(subagent): add concurrency semaphore and clean cancellation handling"
  ```

---

### Task 4: 端到端并发压力与会话并发回归测试

**Files:**
- Create: `api/tests/test_chat_concurrency.py`
- Modify: `docker-compose.prod.yml` (如有需要微调超时或限制参数)

**Interfaces:**
- Consumes: FastAPI TestClient / httpx AsyncClient
- Produces: 模拟 5 个并发会话同时发送消息和查询会话列表，验证 0 挂起、0 超时、0 死锁

- [ ] **Step 1: 编写多会话并发端到端测试**
  在 `api/tests/test_chat_concurrency.py` 中模拟：
  1. 会话 A 触发需要运行工具的耗时任务。
  2. 会话 B、C、D 同时发起普通的打字机生成和会话查询。
  3. 会话 A 收到停止信号 `/chat/{session_id}/stop`。
  4. 验证会话 B/C/D 的响应时间和会话查询毫秒级返回，会话 A 准时终止。

- [ ] **Step 2: 执行全量端到端并发测试**
  Run: `cd api && uv run pytest tests/test_chat_concurrency.py -v`

- [ ] **Step 3: 运行全量测试套件确保无既有功能回退**
  Run: `cd api && uv run pytest tests/test_standalone_auth.py tests/test_sessions_messages.py -v`

- [ ] **Step 4: 提交代码并记录**
  ```bash
  git add api/tests/test_chat_concurrency.py
  git commit -m "test(concurrency): add multi-session concurrent stress tests"
  ```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-28-fix-service-hang-concurrency.md` and Artifact. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

**For this plan I recommend Native**, because the tasks involve tightly coupled ASGI event loop, SQLite connection management, and asyncio concurrency primitives where session-level context continuity ensures zero regressions. Does the plan capture what you want, and which approach should we use?
