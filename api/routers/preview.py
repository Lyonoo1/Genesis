import os
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import HTMLResponse, FileResponse

from services.terminal_manager import get_default_workspace
from services.workspace_tool_executor import WorkspaceToolExecutor
from services.preview_service import inject_preview_bridge

router = APIRouter(prefix="/preview", tags=["Workspace Preview Bridge"])


def _get_workspace_root(workspace_path: Optional[str] = None) -> str:
    if workspace_path and os.path.isdir(workspace_path):
        return os.path.abspath(workspace_path)
    env_root = os.environ.get("WORKSPACE_ROOT")
    if env_root and os.path.isdir(env_root):
        return os.path.abspath(env_root)
    return get_default_workspace()


def _resolve_target_file(ws_root: str, path: str) -> Path:
    # 1. 直接尝试从 ws_root 解析
    try:
        candidate = WorkspaceToolExecutor.resolve_safe_path(ws_root, path)
        if candidate.exists():
            return candidate
    except Exception:
        candidate = None

    # 2. 如果包含首段 session_id (例如 uuid/index.html 或 sess-1/style.css)
    if "/" in path:
        first_segment, remaining = path.split("/", 1)
        try:
            sub_candidate = WorkspaceToolExecutor.resolve_safe_path(ws_root, remaining)
            if sub_candidate.exists():
                return sub_candidate
        except Exception:
            pass

        # 尝试通过 session_id 关联的项目目录解析
        try:
            from core.sqlite_db import get_db_connection

            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT project_id FROM sessions WHERE id = ?",
                    (first_segment,),
                )
                row = cursor.fetchone()
                if row and row[0]:
                    proj_id = row[0]
                    cursor.execute(
                        "SELECT name FROM projects WHERE id = ?",
                        (proj_id,),
                    )
                    p_row = cursor.fetchone()
                    if p_row and p_row[0]:
                        candidate_dir = Path(ws_root) / p_row[0]
                        if candidate_dir.is_dir():
                            c_target = WorkspaceToolExecutor.resolve_safe_path(
                                str(candidate_dir), remaining
                            )
                            if c_target.exists():
                                return c_target
        except Exception:
            pass

    return candidate or WorkspaceToolExecutor.resolve_safe_path(ws_root, path)


@router.get(
    "",
    summary="工作区预览根路由默认 index.html",
    include_in_schema=False,
)
@router.get(
    "/",
    summary="工作区预览根路由默认 index.html",
    include_in_schema=False,
)
@router.get(
    "/{file_path:path}",
    summary="工作区静态页面与资源预览代理路由（支持 Session 命名空间与探针注入）",
)
async def preview_workspace_file(
    file_path: str = "",
    workspace: Optional[str] = Query(default=None, description="可选工作区根路径"),
):
    clean_path = (file_path or "").split("?")[0].split("#")[0].strip("/")
    if not clean_path:
        clean_path = "index.html"
    ws_root = _get_workspace_root(workspace)
    try:
        target = _resolve_target_file(ws_root, clean_path)
    except PermissionError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"禁止越权访问工作区外部路径: {e}",
        )

    if not target.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"预览文件未找到: {file_path}",
        )

    # 若请求的是目录，自动寻找子目录下的 index.html
    if target.is_dir():
        candidate = target / "index.html"
        if candidate.exists():
            target = candidate
        else:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"目录缺少 index.html 入口: {file_path}",
            )

    # 若为 HTML 文件，自动注入 genesis-preview-bridge 探针脚本
    if target.suffix.lower() in (".html", ".htm"):
        raw_html = target.read_text(encoding="utf-8", errors="replace")
        injected_html = inject_preview_bridge(raw_html)
        return HTMLResponse(
            content=injected_html,
            media_type="text/html; charset=utf-8",
            headers={"Cache-Control": "no-cache"},
        )

    # 其他静态资源 (JS/CSS/图片/字体等) 原样流式返回
    return FileResponse(
        str(target),
        headers={"Cache-Control": "public, max-age=60"},
    )
