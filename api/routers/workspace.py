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
        from services.context_compiler import workspace_dirty_tracker
        bridge = BridgeManager.get_instance()
        uid = ws_root[len("bridge://"):].split("::", 1)[0]
        res = await bridge.call_rpc(uid, "fs.writeFile", {"path": body.path, "content": body.content}, timeout=15)
        if not res.get("success"):
            raise HTTPException(status_code=500, detail=res.get("error", f"写入文件失败: {body.path}"))
        workspace_dirty_tracker.record_user_external_modification(
            session_id=body.session_id,
            path=body.path,
            old_content=None,
            new_content=body.content,
            source="monaco_edit",
            workspace_root=ws_root,
        )
        return {
            "success": True,
            "path": body.path,
            "size": len(body.content.encode("utf-8")),
            "is_bridge": True,
        }

    old_content: Optional[str] = None
    try:
        full_path = WorkspaceToolExecutor.resolve_safe_path(ws_root, body.path)
        if full_path.exists() and full_path.is_file():
            old_content = full_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        pass

    try:
        res = WorkspaceToolExecutor.write_file(
            workspace_root=ws_root,
            path=body.path,
            content=body.content,
            overwrite=body.overwrite,
        )
        if not res.get("success"):
            raise HTTPException(status_code=500, detail=res.get("error", f"写入文件失败: {body.path}"))

        from services.context_compiler import workspace_dirty_tracker
        workspace_dirty_tracker.record_user_external_modification(
            session_id=body.session_id,
            path=body.path,
            old_content=old_content,
            new_content=body.content,
            source="monaco_edit",
            workspace_root=ws_root,
        )
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"写入文件失败: {exc}")


class RevertPatchRequest(BaseModel):
    patch_id: Optional[str] = Field(default=None, description="快照补丁ID")
    session_id: Optional[str] = Field(default=None, description="会话ID")
    path: Optional[str] = Field(default=None, description="文件相对路径")
    project_id: Optional[str] = Field(default=None, description="项目ID")


class AcceptPatchRequest(BaseModel):
    patch_id: str = Field(..., description="快照补丁ID")


class PlanDecisionRequest(BaseModel):
    session_id: str = Field(..., description="会话ID")
    approved: bool = Field(..., description="是否批准规划")
    feedback: Optional[str] = Field(default=None, description="驳回时的修改意见或补充说明")


@router.post("/revert_patch", summary="回滚指定文件补丁并压入脏状态感知告警")
async def revert_patch(
    body: RevertPatchRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    from core.sqlite_db import (
        db_get_file_snapshot,
        db_get_latest_file_snapshot,
        db_update_file_snapshot_status,
    )
    from services.context_compiler import workspace_dirty_tracker
    from services.workspace_tool_executor import ShadowGitCheckpoint

    snapshot: Optional[dict[str, Any]] = None
    if body.patch_id:
        snapshot = db_get_file_snapshot(body.patch_id)
    elif body.session_id and body.path:
        snapshot = db_get_latest_file_snapshot(body.session_id, body.path)

    if not snapshot:
        raise HTTPException(status_code=404, detail="未找到对应的文件快照")

    sid = snapshot["session_id"] or body.session_id or "default"
    file_path = snapshot["file_path"]
    orig_content = snapshot.get("original_content")

    ws_root = await chat_service.resolve_workspace_root(
        user_id=user.id,
        session_id=sid,
        project_id=body.project_id,
    )

    restored_via_git = False
    commit_hash = snapshot.get("shadow_commit_hash")
    if commit_hash and not ws_root.startswith("bridge://"):
        try:
            sg = ShadowGitCheckpoint(ws_root)
            restored_via_git = sg.restore_checkpoint(commit_hash)
        except Exception:
            pass

    current_disk_content = ""
    if not ws_root.startswith("bridge://"):
        try:
            target = WorkspaceToolExecutor.resolve_safe_path(ws_root, file_path)
            if target.exists() and target.is_file():
                current_disk_content = target.read_text(encoding="utf-8", errors="replace")

            if not restored_via_git:
                if orig_content is None or (orig_content == "" and not snapshot.get("modified_content")):
                    if target.exists():
                        target.unlink()
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(orig_content or "", encoding="utf-8")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"文件还原失败: {e}")
    else:
        from services.bridge_manager import BridgeManager
        bridge = BridgeManager.get_instance()
        uid = ws_root[len("bridge://"):].split("::", 1)[0]
        await bridge.call_rpc(uid, "fs.writeFile", {"path": file_path, "content": orig_content or ""}, timeout=15)

    db_update_file_snapshot_status(snapshot["id"], "rejected")

    workspace_dirty_tracker.record_user_external_modification(
        session_id=sid,
        path=file_path,
        old_content=current_disk_content or snapshot.get("modified_content"),
        new_content=orig_content or "",
        source="diff_rejected",
        patch_id=snapshot["id"],
        workspace_root=ws_root,
    )

    return {
        "success": True,
        "patch_id": snapshot["id"],
        "status": "rejected",
        "file_path": file_path,
        "message": f"补丁 {snapshot['id']} 已成功回滚并标记为 rejected",
    }


@router.post("/accept_patch", summary="接受并锁定指定文件补丁")
async def accept_patch(
    body: AcceptPatchRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    from core.sqlite_db import db_get_file_snapshot, db_update_file_snapshot_status

    snapshot = db_get_file_snapshot(body.patch_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="未找到对应的文件快照")

    db_update_file_snapshot_status(body.patch_id, "accepted")
    return {
        "success": True,
        "patch_id": body.patch_id,
        "status": "accepted",
        "message": f"补丁 {body.patch_id} 已成功接受",
    }


@router.post("/plan_decision", summary="在 Plan 模式下对计划做出批准或驳回决策")
async def plan_decision(
    body: PlanDecisionRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    from datetime import datetime, timezone
    from core.sqlite_db import db_upsert_agent_goal
    from services.agent_state_machine import AgentStateMachine

    sm = AgentStateMachine.get_active(body.session_id)
    if sm:
        if body.approved:
            sm.approve_plan()
        else:
            sm.reject_plan(feedback=body.feedback)
        current_state = sm.state.value
        current_mode = sm.mode.value
    else:
        current_mode = "act" if body.approved else "plan"
        current_state = "COMPILING_CONTEXT" if body.approved else "PLANNING"

    db_upsert_agent_goal({
        "session_id": body.session_id,
        "mode": current_mode,
        "lifecycle_state": current_state,
        "proposed_plan": body.feedback if not body.approved else None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })

    return {
        "success": True,
        "session_id": body.session_id,
        "approved": body.approved,
        "mode": current_mode,
        "state": current_state,
        "feedback": body.feedback,
        "message": "计划已批准，进入 ACT 执行模式" if body.approved else "计划已驳回，返回规划重构模式",
    }

