import os
import shutil
import tempfile
import pytest
from pathlib import Path

from services.workspace_tool_executor import WorkspaceToolExecutor
from services.tool_adapter import ToolAdapter
from services.chat_service import ChatService


@pytest.fixture
def temp_workspace():
    tmp_dir = tempfile.mkdtemp(prefix="genesis_test_ws_")
    yield tmp_dir
    if os.path.exists(tmp_dir):
        shutil.rmtree(tmp_dir)


def test_safe_path_resolution(temp_workspace):
    # 正常合法相对路径
    p1 = WorkspaceToolExecutor.resolve_safe_path(temp_workspace, "sub/file.txt")
    assert str(p1).startswith(str(Path(temp_workspace).resolve()))

    # 路径穿越攻击阻断
    with pytest.raises(PermissionError):
        WorkspaceToolExecutor.resolve_safe_path(temp_workspace, "../outside.txt")

    with pytest.raises(PermissionError):
        WorkspaceToolExecutor.resolve_safe_path(temp_workspace, "/etc/passwd")


def test_workspace_file_lifecycle(temp_workspace):
    # 1. 写入文件（含自动创建深层目录）
    res_write = WorkspaceToolExecutor.write_file(
        temp_workspace,
        "src/components/Button.tsx",
        "export const Button = () => <button>Click</button>;",
    )
    assert res_write["success"] is True
    assert (Path(temp_workspace) / "src/components/Button.tsx").exists()

    # 2. 读取文件
    res_read = WorkspaceToolExecutor.read_file(
        temp_workspace, "src/components/Button.tsx"
    )
    assert res_read["success"] is True
    assert "export const Button" in res_read["content"]

    # 3. 列出目录
    res_list = WorkspaceToolExecutor.list_dir(temp_workspace, recursive=True)
    assert res_list["success"] is True
    assert any("Button.tsx" in item["name"] for item in res_list["items"])

    # 4. 删除单个文件
    res_del = WorkspaceToolExecutor.delete_file(
        temp_workspace, "src/components/Button.tsx"
    )
    assert res_del["success"] is True
    assert not (Path(temp_workspace) / "src/components/Button.tsx").exists()


def test_workspace_wildcard_delete(temp_workspace):
    # 创建多个 .asf 与 .tmp 测试文件
    (Path(temp_workspace) / "test1.asf").write_text("asf content 1")
    (Path(temp_workspace) / "test2.asf").write_text("asf content 2")
    (Path(temp_workspace) / "keep.txt").write_text("keep this file")

    res = WorkspaceToolExecutor.delete_file(temp_workspace, "*.asf")
    assert res["success"] is True
    assert res["deleted_count"] == 2
    assert not (Path(temp_workspace) / "test1.asf").exists()
    assert not (Path(temp_workspace) / "test2.asf").exists()
    assert (Path(temp_workspace) / "keep.txt").exists()


def test_workspace_root_delete_protection(temp_workspace):
    res = WorkspaceToolExecutor.delete_file(temp_workspace, ".")
    assert res["success"] is False
    assert "安全限制" in res["error"]


def test_workspace_execute_command(temp_workspace):
    res = WorkspaceToolExecutor.execute_command(temp_workspace, "echo 'hello genesis'")
    assert res["success"] is True
    assert "hello genesis" in res["stdout"]
    assert res["returncode"] == 0


def test_tool_adapter_workspace_parsing():
    kind, target, method = ToolAdapter.parse_namespaced_tool("workspace__delete_file")
    assert kind == "workspace"
    assert method == "delete_file"

    kind, target, method = ToolAdapter.parse_namespaced_tool("workspace__execute_command")
    assert kind == "workspace"
    assert method == "execute_command"


@pytest.mark.anyio
async def test_chat_service_collects_builtin_workspace_tools():
    service = ChatService()
    tools_list, tools_lookup = await service.collect_tools("mock_user_id")

    tool_names = [t["function"]["name"] for t in tools_list]
    assert "workspace__delete_file" in tool_names
    assert "workspace__write_file" in tool_names
    assert "workspace__read_file" in tool_names
    assert "workspace__list_dir" in tool_names
    assert "workspace__execute_command" in tool_names

    assert tools_lookup["workspace__delete_file"]["type"] == "workspace"
