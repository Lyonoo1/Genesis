import os
from pathlib import Path
from typing import Optional, Any
from fastapi import APIRouter, Query, HTTPException, Depends
from pydantic import BaseModel, Field
from core.security import get_current_user, AuthenticatedUser
from services.chat_service import chat_service
from services.workspace_tool_executor import WorkspaceToolExecutor

router = APIRouter(prefix="/workspace", tags=["workspace"])

IGNORE_NAMES = {
    ".git",
    "node_modules",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "release",
    "out",
    ".DS_Store",
    ".turbo",
    ".cache",
    ".output",
    ".genesis_outputs",
    ".idea",
    ".vscode",
}

IGNORE_EXTS = {
    ".pyc",
    ".pyo",
    ".pyd",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".class",
    ".jar",
    ".zip",
    ".tar",
    ".gz",
    ".7z",
    ".rar",
    ".dmg",
    ".iso",
    ".bin",
    ".o",
    ".a",
}


class WorkspaceFileWriteRequest(BaseModel):
    path: str = Field(..., description="文件相对路径")
    content: str = Field(..., description="文件内容")
    session_id: Optional[str] = Field(default=None, description="会话ID")
    project_id: Optional[str] = Field(default=None, description="项目ID")
    overwrite: bool = Field(default=True, description="是否覆写")


def build_file_tree(
    base_dir: Path,
    current_dir: Path,
    max_depth: int = 5,
    depth: int = 0,
    count_ref: Optional[list[int]] = None,
    max_nodes: int = 2000,
) -> list[dict[str, Any]]:
    if count_ref is None:
        count_ref = [0]

    if depth > max_depth or count_ref[0] >= max_nodes or not current_dir.exists() or not current_dir.is_dir():
        return []

    nodes: list[dict[str, Any]] = []
    try:
        entries = sorted(os.scandir(current_dir), key=lambda e: (not e.is_dir(), e.name.lower()))
    except (PermissionError, OSError):
        return []

    for entry in entries:
        if count_ref[0] >= max_nodes:
            break

        if (
            entry.name in IGNORE_NAMES
            or entry.name.startswith(".")
            or entry.name.endswith(".app")
            or any(entry.name.lower().endswith(ext) for ext in IGNORE_EXTS)
        ):
            continue

        rel_path = os.path.relpath(entry.path, base_dir).replace(os.sep, "/")
        if entry.is_dir(follow_symlinks=False):
            count_ref[0] += 1
            children = build_file_tree(base_dir, Path(entry.path), max_depth, depth + 1, count_ref, max_nodes)
            nodes.append({
                "name": entry.name,
                "path": rel_path,
                "kind": "directory",
                "children": children,
            })
        elif entry.is_file(follow_symlinks=False):
            count_ref[0] += 1
            size = 0
            try:
                size = entry.stat().st_size
            except OSError:
                pass
            nodes.append({
                "name": entry.name,
                "path": rel_path,
                "kind": "file",
                "size": size,
            })

    return nodes


@router.get("/tree", summary="获取服务端工作区目录树结构")
async def get_workspace_tree(
    session_id: Optional[str] = Query(default=None, description="会话ID"),
    project_id: Optional[str] = Query(default=None, description="项目ID"),
    user: AuthenticatedUser = Depends(get_current_user),
):
    ws_root = await chat_service.resolve_workspace_root(
        user_id=user.id,
        session_id=session_id,
        project_id=project_id,
    )

    if ws_root.startswith("bridge://"):
        from services.bridge_manager import BridgeManager
        bridge = BridgeManager.get_instance()
        uid = ws_root[len("bridge://"):].split("::", 1)[0]
        meta = bridge.get_metadata(uid) or {}
        local_cwd = meta.get("cwd", ".")
        root_name = Path(local_cwd).name or "local-workspace"
        res = await bridge.call_rpc(uid, "fs.getTree", {}, timeout=15)
        if res.get("success"):
            return {
                "success": True,
                "workspace_root": local_cwd,
                "name": root_name,
                "tree": res.get("tree", []),
                "is_bridge": True,
            }
        return {
            "success": False,
            "workspace_root": local_cwd,
            "tree": [],
            "error": res.get("error", "通过本地 Bridge 获取文件树失败"),
            "is_bridge": True,
        }

    root_path = Path(ws_root).resolve()
    if not root_path.exists() or not root_path.is_dir():
        return {
            "success": False,
            "workspace_root": str(root_path),
            "tree": [],
            "error": "工作区目录不存在",
        }

    tree = build_file_tree(root_path, root_path)
    return {
        "success": True,
        "workspace_root": str(root_path),
        "name": root_path.name or "workspace",
        "tree": tree,
    }


@router.get("/file", summary="读取服务端工作区文件内容")
async def get_workspace_file(
    path: str = Query(..., description="文件相对路径"),
    session_id: Optional[str] = Query(default=None, description="会话ID"),
    project_id: Optional[str] = Query(default=None, description="项目ID"),
    user: AuthenticatedUser = Depends(get_current_user),
):
    ws_root = await chat_service.resolve_workspace_root(
        user_id=user.id,
        session_id=session_id,
        project_id=project_id,
    )

    if ws_root.startswith("bridge://"):
        from services.bridge_manager import BridgeManager
        bridge = BridgeManager.get_instance()
        uid = ws_root[len("bridge://"):].split("::", 1)[0]
        res = await bridge.call_rpc(uid, "fs.readFile", {"path": path}, timeout=15)
        if not res.get("success"):
            raise HTTPException(status_code=404, detail=res.get("error", f"文件不存在: {path}"))
        content = res.get("content", "")
        return {
            "success": True,
            "path": path,
            "name": Path(path).name,
            "content": content,
            "size": len(content.encode("utf-8")),
            "is_bridge": True,
        }

    try:
        full_path = WorkspaceToolExecutor.resolve_safe_path(ws_root, path)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))

    if not full_path.exists():
        raise HTTPException(status_code=404, detail=f"文件不存在: {path}")
    if full_path.is_dir():
        raise HTTPException(status_code=400, detail=f"指定路径是目录而不是文件: {path}")

    # 读取文件文本内容（最大限制 1MB 避免撑爆前端）
    try:
        stat = full_path.stat()
        if stat.st_size > 1024 * 1024:
            content = full_path.read_text(encoding="utf-8", errors="replace")[:1024 * 1024]
        else:
            content = full_path.read_text(encoding="utf-8", errors="replace")
        return {
            "success": True,
            "path": path,
            "name": full_path.name,
            "content": content,
            "size": stat.st_size,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"读取文件失败: {exc}")


@router.post("/file", summary="向服务端工作区写入或创建文件")
async def write_workspace_file(
    body: WorkspaceFileWriteRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    ws_root = await chat_service.resolve_workspace_root(
        user_id=user.id,
        session_id=body.session_id,
        project_id=body.project_id,
    )

    if ws_root.startswith("bridge://"):
        from services.bridge_manager import BridgeManager
        bridge = BridgeManager.get_instance()
        uid = ws_root[len("bridge://"):].split("::", 1)[0]
        res = await bridge.call_rpc(uid, "fs.writeFile", {"path": body.path, "content": body.content}, timeout=15)
        if not res.get("success"):
            raise HTTPException(status_code=500, detail=res.get("error", f"写入文件失败: {body.path}"))
        return {
            "success": True,
            "path": body.path,
            "size": len(body.content.encode("utf-8")),
            "is_bridge": True,
        }

    try:
        res = WorkspaceToolExecutor.write_file(
            workspace_root=ws_root,
            path=body.path,
            content=body.content,
            overwrite=body.overwrite,
        )
        if not res.get("success"):
            raise HTTPException(status_code=500, detail=res.get("error", f"写入文件失败: {body.path}"))
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"写入文件失败: {exc}")

