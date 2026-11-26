import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Optional

from core.config import settings

_SAFE_ID_RE = re.compile(r"[^a-zA-Z0-9_.-]")


def get_api_source_root() -> Path:
    """获取当前后端 api 源码根目录 (容器内通常为 /app，本地开发为 Genesis/api)"""
    return Path(__file__).resolve().parent.parent


def is_container_env() -> bool:
    """检测当前进程是否运行在容器环境内"""
    return os.path.exists("/.dockerenv") or os.path.exists("/.containerenv")


def is_restricted_env() -> bool:
    """判断当前是否处于受限运行态（生产环境或容器环境）"""
    env = (os.environ.get("ENVIRONMENT") or settings.ENVIRONMENT or "").strip().lower()
    return env == "production" or is_container_env()


def get_sandbox_tmp_dir() -> Path:
    """获取隔离沙箱基础根目录，兼容容器挂载卷与桌面端用户数据目录"""
    env_sandbox = (os.environ.get("SANDBOX_TMP_DIR") or "").strip()
    if env_sandbox:
        return Path(env_sandbox).resolve()

    desktop_data_dir = (os.environ.get("GENESIS_DATA_DIR") or "").strip()
    if desktop_data_dir:
        return (Path(desktop_data_dir) / "sandboxes").resolve()

    default_dir = settings.SANDBOX_TMP_DIR
    if sys.platform == "win32" and default_dir.startswith("/"):
        return (Path(tempfile.gettempdir()) / "genesis" / "sandboxes").resolve()
    return Path(default_dir).resolve()


def _resolve_candidates(raw_paths: tuple[str, ...]) -> set[Path]:
    resolved: set[Path] = set()
    for raw in raw_paths:
        p = Path(raw)
        resolved.add(p)
        try:
            resolved.add(p.resolve())
        except OSError:
            pass
    return resolved


_FORBIDDEN_EXACT_DIRS = _resolve_candidates(
    (
        "/",
        "/root",
        "/home",
        "/var",
        "/tmp",
        "/opt",
        "/Users",
        "/Volumes",
    )
)

_FORBIDDEN_TREE_ROOTS = _resolve_candidates(
    (
        "/app",
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/boot",
        "/dev",
        "/proc",
        "/sys",
        "/System",
        "/Applications",
        "/Library",
    )
)


def is_forbidden_workspace_path(path_str: Optional[str]) -> bool:
    """校验路径是否落入后端源码目录、容器 /app 或系统敏感目录"""
    if not path_str or not str(path_str).strip():
        return True

    try:
        target = Path(path_str).resolve()
    except OSError:
        return True

    # 1. 绝不允许命中后端 api 源码目录及其任意子目录
    api_root = get_api_source_root()
    if target == api_root or target.is_relative_to(api_root):
        return True

    # 2. 绝不允许命中 /app 或系统目录树（如 /etc, /usr, /System 等）
    for forbidden_tree in _FORBIDDEN_TREE_ROOTS:
        if target == forbidden_tree or target.is_relative_to(forbidden_tree):
            return True

    # 3. 绝不允许直接暴露系统根目录或用户家目录根本身
    if target in _FORBIDDEN_EXACT_DIRS:
        return True
    try:
        home_dir = Path.home().resolve()
        if target == home_dir:
            return True
    except Exception:
        pass

    # 4. Windows 盘符根目录与系统目录兜底
    if sys.platform == "win32":
        if target == Path(target.anchor):
            return True
        win_dir = os.environ.get("WINDIR")
        if win_dir:
            win_path = Path(win_dir).resolve()
            if target == win_path or target.is_relative_to(win_path):
                return True

    # 5. 受限环境下，额外拦截包含后端入口特征文件的目录（防止挂载路径别名泄漏源码）
    if is_restricted_env():
        if (target / "main.py").is_file() and (target / "core" / "config.py").is_file():
            return True

    return False


def is_sandbox_root_path(path_str: Optional[str]) -> bool:
    """判断路径是否属于沙箱隔离根基目录（而非真实项目目录）"""
    if not path_str or not str(path_str).strip():
        return False
    try:
        target = Path(path_str).resolve()
    except OSError:
        return False

    sandbox_base = get_sandbox_tmp_dir()
    sandbox_ws_base = (sandbox_base / "workspaces").resolve()
    return target in {sandbox_base, sandbox_ws_base}


def sanitize_user_segment(user_id: Optional[str]) -> str:
    """清洗用户标识为安全目录名，彻底阻断路径穿越字符"""
    raw = str(user_id or "default").strip()
    cleaned = _SAFE_ID_RE.sub("_", raw).strip("._")
    return cleaned or "default"


def get_isolated_sandbox_workspace(
    user_id: Optional[str] = None,
    base_dir: Optional[str] = None,
) -> str:
    """获取并创建按用户隔离的空沙箱工作区目录，确保无法逃逸出沙箱根"""
    if base_dir and not is_forbidden_workspace_path(base_dir):
        base_path = Path(base_dir).resolve()
        ws_parent = (
            base_path
            if base_path.name == "workspaces"
            else (base_path / "workspaces").resolve()
        )
    else:
        ws_parent = (get_sandbox_tmp_dir() / "workspaces").resolve()

    safe_uid = sanitize_user_segment(user_id)
    target = (ws_parent / safe_uid).resolve()
    if not target.is_relative_to(ws_parent):
        target = (ws_parent / "default").resolve()

    target.mkdir(parents=True, exist_ok=True)
    return str(target)
