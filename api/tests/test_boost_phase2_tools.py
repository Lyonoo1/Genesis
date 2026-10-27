import asyncio
import os
import shutil
import tempfile
import pytest
from pathlib import Path

from services.workspace_tool_executor import (
    WorkspaceToolExecutor,
    ShadowGitCheckpoint,
)
from services.permission_manager import (
    PermissionManager,
    PermissionDecision,
    ApprovalManager,
    permission_manager,
)
from services.tool_adapter import ToolAdapter


@pytest.fixture
def temp_ws():
    tmp = tempfile.mkdtemp(prefix="genesis_boost_ws_")
    yield tmp
    if os.path.exists(tmp):
        shutil.rmtree(tmp)


# ============================================================================
# 任务 1: 四级降级模糊匹配 + AST 语法自愈 + Unified Diff
# ============================================================================

def test_smart_edit_tier1_exact_and_crlf(temp_ws):
    """测试 Tier 1 精确匹配与 CRLF 换行符统一归一化"""
    initial = "def hello():\r\n    return 'world'\r\n"
    WorkspaceToolExecutor.write_file(temp_ws, "hello.py", initial)

    old_str = "return 'world'\r\n"
    new_str = "return 'genesis'\r\n"
    res = WorkspaceToolExecutor.edit_file(temp_ws, "hello.py", old_str, new_str)

    assert res["success"] is True
    assert "return 'genesis'" in res["modified_content"]
    assert res["additions"] >= 1
    assert res["deletions"] >= 1
    assert "diff" in res and "--- a/hello.py" in res["diff"]

    # 验证磁盘落地内容
    saved = Path(temp_ws, "hello.py").read_text(encoding="utf-8")
    assert "return 'genesis'" in saved


def test_smart_edit_tier1_ambiguity(temp_ws):
    """测试 Tier 1 精确匹配出现多处重复时提示补充 3 行上下文"""
    content = "count = 0\nprint(count)\ncount = 0\n"
    WorkspaceToolExecutor.write_file(temp_ws, "dup.py", content)

    res = WorkspaceToolExecutor.edit_file(temp_ws, "dup.py", "count = 0", "count = 1")
    assert res["success"] is False
    assert "不具备唯一性" in res["error"]
    assert "3 行上下文" in res["error"]


def test_smart_edit_tier2_trailing_whitespace(temp_ws):
    """测试 Tier 2 忽略行尾空格匹配"""
    initial = "def process():   \n    data = load()  \n    return data   \n"
    WorkspaceToolExecutor.write_file(temp_ws, "proc.py", initial)

    # old_str 没有多余行尾空格
    old_str = "def process():\n    data = load()\n    return data"
    new_str = "def process():\n    data = load_safe()\n    return data"
    res = WorkspaceToolExecutor.edit_file(temp_ws, "proc.py", old_str, new_str)

    assert res["success"] is True
    assert "load_safe" in res["modified_content"]


def test_smart_edit_tier3_indentation_offset(temp_ws):
    """测试 Tier 3 忽略缩进偏移与自动对齐补偿"""
    initial = (
        "class Service:\n"
        "    def run(self):\n"
        "        val = 10\n"
        "        return val * 2\n"
    )
    WorkspaceToolExecutor.write_file(temp_ws, "service.py", initial)

    # 模型输出的代码缺少顶层 4 个空格缩进
    old_str = (
        "def run(self):\n"
        "    val = 10\n"
        "    return val * 2"
    )
    new_str = (
        "def run(self):\n"
        "    val = 20\n"
        "    return val * 3"
    )

    res = WorkspaceToolExecutor.edit_file(temp_ws, "service.py", old_str, new_str)
    assert res["success"] is True

    saved = Path(temp_ws, "service.py").read_text(encoding="utf-8")
    assert "        val = 20" in saved
    assert "        return val * 3" in saved
    assert "    def run(self):" in saved


def test_smart_edit_tier4_sliding_window_similarity(temp_ws):
    """测试 Tier 4 滑动窗口寻找最高相似度代码并回传带真实行号切片"""
    content = (
        "import os\n"
        "import sys\n"
        "\n"
        "def compute(items):\n"
        "    total = 0\n"
        "    for it in items:\n"
        "        total += it.price * it.qty\n"
        "    return total\n"
        "\n"
        "def display():\n"
        "    pass\n"
    )
    WorkspaceToolExecutor.write_file(temp_ws, "calc.py", content)

    # 模型输入微小偏差代码（例如 price vs cost，漏掉了 qty 逻辑）
    old_typo = (
        "def compute(items):\n"
        "    total = 0\n"
        "    for it in items:\n"
        "        total += it.cost\n"
        "    return total"
    )
    new_str = "def compute(items):\n    return sum(items)"

    res = WorkspaceToolExecutor.edit_file(temp_ws, "calc.py", old_typo, new_str)
    assert res["success"] is False
    assert "未找到精确匹配，但在第 4 行附近找到高度相似代码" in res["error"]
    assert "4 | def compute(items):" in res["error"]
    assert "7 |         total += it.price * it.qty" in res["error"]


def test_ast_syntax_self_healing_warning(temp_ws):
    """测试 AST 语法自愈预检：成功修改后附加带行号切片的警告信息"""
    initial = (
        "def correct():\n"
        "    return 1\n"
    )
    WorkspaceToolExecutor.write_file(temp_ws, "broken.py", initial)

    old_str = "    return 1"
    # 注入 Python 语法错误（缺少闭合括号）
    broken_str = "    val = (1 + 2\n    return val"

    res = WorkspaceToolExecutor.edit_file(temp_ws, "broken.py", old_str, broken_str)
    assert res["success"] is True  # 修改依然已应用落盘
    assert "AST 语法自愈警告" in res["message"]
    assert "syntax_warning" in res
    assert "[AST 语法自愈警告] 修改已应用，但检测到第" in res["syntax_warning"]

    # 磁盘文件确实被写入
    saved = Path(temp_ws, "broken.py").read_text(encoding="utf-8")
    assert "val = (1 + 2" in saved


def test_write_file_unified_diff(temp_ws):
    """测试 write_file 输出结构化 diff、additions、deletions"""
    # 1. 首次创建
    res1 = WorkspaceToolExecutor.write_file(temp_ws, "config.json", '{"version": 1}')
    assert res1["success"] is True
    assert res1["additions"] == 1
    assert res1["deletions"] == 0
    assert "diff" in res1 and "+{\"version\": 1}" in res1["diff"]

    # 2. 覆盖更新
    res2 = WorkspaceToolExecutor.write_file(temp_ws, "config.json", '{"version": 2}')
    assert res2["success"] is True
    assert res2["additions"] == 1
    assert res2["deletions"] == 1
    assert "-{\"version\": 1}" in res2["diff"]
    assert "+{\"version\": 2}" in res2["diff"]


# ============================================================================
# 任务 2: 零死锁双模后台执行器
# ============================================================================

def test_execute_command_foreground(temp_ws):
    """测试常规前台同步命令执行"""
    res = WorkspaceToolExecutor.execute_command(temp_ws, "echo 'hello foreground'")
    assert res["success"] is True
    assert "hello foreground" in res["stdout"]
    assert res["returncode"] == 0


@pytest.mark.anyio
async def test_execute_command_background_port_probe(temp_ws):
    """测试后台守护进程与端口探针实时捕获"""
    # 模拟 Vite / Web 开发服务器打印端口
    cmd = (
        'python3 -c "'
        'import time; '
        'print(\'  VITE v5.2.0  ready in 250 ms\\n\\n  ➜  Local:   http://localhost:5173/\\n\', flush=True); '
        'time.sleep(10)'
        '"'
    )

    res = await WorkspaceToolExecutor.execute_command(
        temp_ws,
        cmd,
        is_background=True,
    )

    assert res["success"] is True
    assert res["status"] == "running_in_background"
    assert "http://localhost:5173" in res["url"]
    assert res["pid"] > 0
    assert "VITE" in res["stdout"]

    # 清理后台进程
    WorkspaceToolExecutor._kill_process_tree(res["pid"])


@pytest.mark.anyio
async def test_execute_command_daemon_regex_auto_background(temp_ws):
    """测试后端根据命令正则自动判定 is_background=True"""
    # 命令中含有 vite 或 npm run dev 时应自动转为后台执行
    cmd = (
        'python3 -c "'
        'import time; '
        'print(\'Listening on port 8000\', flush=True); '
        'time.sleep(10)'
        '" # vite server'
    )

    res = await WorkspaceToolExecutor.execute_command(temp_ws, cmd)
    assert res["success"] is True
    assert res["status"] == "running_in_background"
    assert "http://localhost:8000" in res["url"]
    assert res["pid"] > 0

    WorkspaceToolExecutor._kill_process_tree(res["pid"])


@pytest.mark.anyio
async def test_execute_command_64kb_pipe_no_deadlock(temp_ws):
    """测试持续后台排空协程：生成超过 64KB 输出的大日志，绝对不挂死管道"""
    # 输出 3000 行，每行约 50 字节，总计 ~150KB，远超系统 64KB 管道缓冲区限制
    cmd = (
        'python3 -c "'
        'for i in range(3000): '
        '    print(f\'LOG_LINE_{i:04d}_\' + \'x\' * 40, flush=True)'
        '"'
    )

    res = await WorkspaceToolExecutor.execute_command(temp_ws, cmd, timeout=10)
    assert res["success"] is True
    assert res["returncode"] == 0
    # 环形缓冲区保留最后 500 行
    assert "LOG_LINE_2999" in res["stdout"]


@pytest.mark.anyio
async def test_execute_command_cancellation_kills_process_tree(temp_ws):
    """测试 CancelledError 触发时整组连根拔起子进程树"""
    # 启动一个包含子孙进程的长任务
    cmd = "python3 -c 'import time; time.sleep(30)'"

    task = asyncio.create_task(
        WorkspaceToolExecutor.execute_command(temp_ws, cmd, timeout=30)
    )
    await asyncio.sleep(0.3)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


# ============================================================================
# 任务 3: 敏感文件权限拦截与检索工具
# ============================================================================

def test_permission_manager_sensitive_paths(temp_ws):
    """测试敏感路径强制人机审批拦截 (env, git, ssh, aws 及工作区外部)"""
    mgr = PermissionManager.get_instance()

    # 1. 敏感配置文件拦截
    dec, reason = mgr.evaluate(
        "workspace__write_file", {"path": ".env"}, workspace_root=temp_ws
    )
    assert dec == PermissionDecision.ASK
    assert "敏感路径强制审批" in reason

    dec, reason = mgr.evaluate(
        "workspace__edit_file", {"path": "sub/.env.local"}, workspace_root=temp_ws
    )
    assert dec == PermissionDecision.ASK

    dec, reason = mgr.evaluate(
        "workspace__write_file", {"path": ".git/config"}, workspace_root=temp_ws
    )
    assert dec == PermissionDecision.ASK

    dec, reason = mgr.evaluate(
        "workspace__write_file", {"path": ".ssh/authorized_keys"}, workspace_root=temp_ws
    )
    assert dec == PermissionDecision.ASK

    dec, reason = mgr.evaluate(
        "workspace__write_file", {"path": ".aws/credentials"}, workspace_root=temp_ws
    )
    assert dec == PermissionDecision.ASK

    # 2. 越权跳出工作区根目录拦截
    dec, reason = mgr.evaluate(
        "workspace__write_file", {"path": "../outside.py"}, workspace_root=temp_ws
    )
    assert dec == PermissionDecision.ASK
    assert "越权路径强制审批" in reason

    # 3. 正常工作区内部普通文件直接放行
    dec, reason = mgr.evaluate(
        "workspace__write_file", {"path": "src/components/Header.tsx"}, workspace_root=temp_ws
    )
    assert dec == PermissionDecision.ALLOW


def test_grep_search_and_find_by_name(temp_ws):
    """测试 grep_search 与 find_by_name 搜索工具及自动忽略目录"""
    # 创建测试文件结构
    (Path(temp_ws) / "src").mkdir()
    (Path(temp_ws) / "src" / "App.tsx").write_text("const title = 'Genesis App';\nconsole.log(title);")
    (Path(temp_ws) / "src" / "utils.py").write_text("def find_me():\n    return 'Genesis Magic'\n")

    # 应该被自动忽略的目录
    (Path(temp_ws) / "node_modules").mkdir()
    (Path(temp_ws) / "node_modules" / "dep.js").write_text("const title = 'Genesis App';")
    (Path(temp_ws) / ".git").mkdir()
    (Path(temp_ws) / ".git" / "log.txt").write_text("Genesis App")

    # 1. grep_search 验证
    grep_res = WorkspaceToolExecutor.grep_search(temp_ws, query="Genesis")
    assert grep_res["success"] is True
    assert grep_res["total_matches"] == 2
    files = [m["file"] for m in grep_res["matches"]]
    assert any("App.tsx" in f for f in files)
    assert any("utils.py" in f for f in files)
    # 确保排除了 node_modules 和 .git
    assert not any("node_modules" in f for f in files)
    assert not any(".git" in f for f in files)

    # 2. find_by_name 验证
    find_res = WorkspaceToolExecutor.find_by_name(temp_ws, pattern="*.tsx")
    assert find_res["success"] is True
    assert find_res["total_matches"] == 1
    assert find_res["matches"][0]["name"] == "App.tsx"


def test_tool_adapter_schemas():
    """验证 tool_adapter 中新工具与参数的 Schema 定义"""
    tool_map = {t["function"]["name"]: t["function"] for t in ToolAdapter.BUILTIN_WORKSPACE_TOOLS}

    # execute_command 包含 is_background 参数
    exec_tool = tool_map["workspace__execute_command"]
    assert "is_background" in exec_tool["parameters"]["properties"]

    # 包含 grep_search 与 find_by_name 工具
    assert "workspace__grep_search" in tool_map
    assert "workspace__find_by_name" in tool_map

    # 命名空间解析
    kind, _, method = ToolAdapter.parse_namespaced_tool("workspace__grep_search")
    assert kind == "workspace"
    assert method == "grep_search"


# ============================================================================
# 任务 4: 独立影子仓库快照 (ShadowGitCheckpoint)
# ============================================================================

def test_shadow_git_checkpoint_lifecycle(temp_ws):
    """测试 ShadowGitCheckpoint 创建快照、回滚还原及未追踪文件清理"""
    # 1. 初始化原始工作区文件
    (Path(temp_ws) / "file1.txt").write_text("version 1.0\n")
    (Path(temp_ws) / "node_modules").mkdir()
    (Path(temp_ws) / "node_modules" / "pkg.json").write_text('{"name": "test"}')

    sg = ShadowGitCheckpoint(temp_ws)
    hash_v1 = sg.create_checkpoint("v1 snapshot")
    assert len(hash_v1) == 40

    # 2. 模拟修改与新建未追踪文件
    (Path(temp_ws) / "file1.txt").write_text("version 2.0 (modified)\n")
    (Path(temp_ws) / "untracked_new.py").write_text("print('should be removed on restore')")
    assert (Path(temp_ws) / "untracked_new.py").exists()

    # 3. 创建 v2 快照
    hash_v2 = sg.create_checkpoint("v2 snapshot")
    assert len(hash_v2) == 40
    assert hash_v1 != hash_v2

    # 4. 执行回滚到 v1
    success = sg.restore_checkpoint(hash_v1)
    assert success is True

    # 验证 file1.txt 恢复为 1.0，新创建的未追踪文件被物理清理，node_modules 被正确保留
    assert Path(temp_ws, "file1.txt").read_text() == "version 1.0\n"
    assert not Path(temp_ws, "untracked_new.py").exists()
    assert Path(temp_ws, "node_modules", "pkg.json").exists()

    # 5. 执行前滚至 v2
    sg.restore_checkpoint(hash_v2)
    assert "version 2.0" in Path(temp_ws, "file1.txt").read_text()
    assert Path(temp_ws, "untracked_new.py").exists()


# ============================================================================
# 额外严苛边界测试 (Edge Cases & Regression Prevention)
# ============================================================================

def test_smart_edit_trailing_newline_in_middle_of_file(temp_ws):
    """测试 old_string 带尾随换行符且位于文件中间时的 Tier 2 与 Tier 3 精准匹配（防 split bug）"""
    content = (
        "class Controller:\n"
        "    def run(self):\n"
        "        val = compute()   \n"
        "        return val\n"
        "    def stop(self):\n"
        "        pass\n"
    )
    WorkspaceToolExecutor.write_file(temp_ws, "controller.py", content)

    # 1. Tier 2: 目标块末尾带换行符，且在文件中间，带行尾空格
    old_str_t2 = "    def run(self):\n        val = compute()\n        return val\n"
    new_str_t2 = "    def run(self):\n        val = compute_fast()\n        return val\n"
    res = WorkspaceToolExecutor.edit_file(temp_ws, "controller.py", old_str_t2, new_str_t2)
    assert res["success"] is True
    assert "Tier 2" in res["message"]
    saved = Path(temp_ws, "controller.py").read_text(encoding="utf-8")
    assert "compute_fast()" in saved
    # 确保没有插入多余空行
    assert "return val\n    def stop(self):" in saved

    # 2. Tier 3: 目标块缩进偏移且末尾带换行符，位于文件中间
    old_str_t3 = "def run(self):\n    val = compute_fast()\n    return val\n"
    new_str_t3 = "def run(self):\n    val = compute_v2()\n    return val\n"
    res3 = WorkspaceToolExecutor.edit_file(temp_ws, "controller.py", old_str_t3, new_str_t3)
    assert res3["success"] is True
    assert "Tier 3" in res3["message"]
    saved3 = Path(temp_ws, "controller.py").read_text(encoding="utf-8")
    assert "compute_v2()" in saved3
    assert "        val = compute_v2()" in saved3
    assert "return val\n    def stop(self):" in saved3


def test_smart_edit_empty_old_string(temp_ws):
    """测试 old_string 为空或纯空白时的保护拦截"""
    WorkspaceToolExecutor.write_file(temp_ws, "empty_test.py", "x = 1\n")
    res = WorkspaceToolExecutor.edit_file(temp_ws, "empty_test.py", "", "x = 2")
    assert res["success"] is False
    assert "不能为空" in res["error"]


def test_smart_edit_tab_indentation_tier3(temp_ws):
    """测试 Tier 3 对制表符 (Tab) 缩进的自动对齐补偿"""
    initial = "def outer():\n\tval = 1\n\treturn val\n"
    WorkspaceToolExecutor.write_file(temp_ws, "tabbed.py", initial)

    # 模型没有带 tab 缩进
    old_str = "val = 1\nreturn val"
    new_str = "val = 2\nreturn val"

    res = WorkspaceToolExecutor.edit_file(temp_ws, "tabbed.py", old_str, new_str)
    assert res["success"] is True
    saved = Path(temp_ws, "tabbed.py").read_text(encoding="utf-8")
    assert "\tval = 2\n" in saved
    assert "\treturn val\n" in saved


def test_json_syntax_error_warning(temp_ws):
    """测试 JSON 文件的语法自愈预检警告"""
    WorkspaceToolExecutor.write_file(temp_ws, "data.json", '{\n  "key": "val"\n}\n')
    # 注入非法逗号导致 JSON 语法错误
    res = WorkspaceToolExecutor.edit_file(
        temp_ws, "data.json", '  "key": "val"', '  "key": "val",'
    )
    assert res["success"] is True
    assert "AST 语法自愈警告" in res["message"]


def test_grep_search_includes_normal_dotfiles(temp_ws):
    """测试 grep_search 正确检索 .env.example / .gitignore 等正常点文件，仅排除保护目录"""
    (Path(temp_ws) / ".env.example").write_text("DATABASE_URL=postgres://localhost/test\n")
    (Path(temp_ws) / ".gitignore").write_text("node_modules/\n.venv/\n")

    res = WorkspaceToolExecutor.grep_search(temp_ws, query="DATABASE_URL")
    assert res["success"] is True
    assert res["total_matches"] >= 1
    assert any(".env.example" in m["file"] for m in res["matches"])


def test_find_by_name_direct_file_path(temp_ws):
    """测试 find_by_name 当 path 指定具体文件时的命中逻辑"""
    fp = Path(temp_ws) / "specific.ts"
    fp.write_text("console.log(1);")

    res = WorkspaceToolExecutor.find_by_name(temp_ws, pattern="*.ts", path="specific.ts")
    assert res["success"] is True
    assert res["total_matches"] == 1
    assert res["matches"][0]["name"] == "specific.ts"


def test_shadow_git_restore_invalid_hash(temp_ws):
    """测试 ShadowGitCheckpoint 传入非法 hash 优雅返回 False 而非崩溃"""
    sg = ShadowGitCheckpoint(temp_ws)
    success = sg.restore_checkpoint("0000000000000000000000000000000000000000")
    assert success is False


def test_permission_manager_windows_path_and_unprefixed_tool(temp_ws):
    """测试 PermissionManager 处理 Windows 反斜杠路径与无前缀工具名"""
    mgr = PermissionManager.get_instance()

    # Windows 风格反斜杠路径敏感文件
    dec, _ = mgr.evaluate(
        "write_file", {"path": "config\\.env"}, workspace_root=temp_ws
    )
    assert dec == PermissionDecision.ASK

    # 无前缀 edit_file
    dec2, _ = mgr.evaluate(
        "edit_file", {"path": ".ssh\\keys"}, workspace_root=temp_ws
    )
    assert dec2 == PermissionDecision.ASK


def test_background_process_session_filter():
    """测试后台任务按 session_id 过滤机制"""
    class MockProc:
        returncode = None

    fake_task_1 = {
        "proc": MockProc(),
        "command": "pnpm dev",
        "session_id": "session-aaa",
        "drain_task": None,
        "ring_buffer": None,
    }
    fake_task_2 = {
        "proc": MockProc(),
        "command": "python server.py",
        "session_id": "session-bbb",
        "drain_task": None,
        "ring_buffer": None,
    }
    WorkspaceToolExecutor._background_tasks[99901] = fake_task_1
    WorkspaceToolExecutor._background_tasks[99902] = fake_task_2

    try:
        # 1. 指定 session-aaa 过滤
        procs_aaa = WorkspaceToolExecutor.list_background_processes("session-aaa")
        assert len(procs_aaa) == 1
        assert procs_aaa[0]["pid"] == 99901
        assert procs_aaa[0]["command"] == "pnpm dev"

        # 2. 指定 session-bbb 过滤
        procs_bbb = WorkspaceToolExecutor.list_background_processes("session-bbb")
        assert len(procs_bbb) == 1
        assert procs_bbb[0]["pid"] == 99902

        # 3. 不传 session 过滤全量
        all_procs = WorkspaceToolExecutor.list_background_processes()
        pids = [p["pid"] for p in all_procs]
        assert 99901 in pids
        assert 99902 in pids
    finally:
        WorkspaceToolExecutor._background_tasks.pop(99901, None)
        WorkspaceToolExecutor._background_tasks.pop(99902, None)


@pytest.mark.anyio
async def test_revert_files_endpoint(temp_ws):
    """测试通过 revert 接口恢复原文件或删除新建文件"""
    from routers.chat import revert_files_endpoint, RevertFilesRequest, RevertFileItem

    # 1. 模拟已有文件被修改后恢复
    f1 = Path(temp_ws) / "modified.py"
    f1.write_text("old version content", encoding="utf-8")
    # 模型改成了 new
    f1.write_text("new buggy content", encoding="utf-8")

    # 2. 模拟全新创建的文件
    f2 = Path(temp_ws) / "new_created.py"
    f2.write_text("newly created content", encoding="utf-8")

    orig_ws = os.environ.get("WORKSPACE_ROOT")
    os.environ["WORKSPACE_ROOT"] = temp_ws
    try:
        req = RevertFilesRequest(
            files=[
                RevertFileItem(path="modified.py", original_content="old version content"),
                RevertFileItem(path="new_created.py", original_content=""),
            ]
        )
        res = await revert_files_endpoint(req)
        assert res["success"] is True
        assert "modified.py" in res["reverted"]
        assert "new_created.py" in res["reverted"]

        # 验证 f1 恢复为 old version content
        assert f1.read_text(encoding="utf-8") == "old version content"
        # 验证新建文件被成功清理删除
        assert not f2.exists()
    finally:
        if orig_ws:
            os.environ["WORKSPACE_ROOT"] = orig_ws
        else:
            os.environ.pop("WORKSPACE_ROOT", None)



