import io
import json
import logging
import os
import shutil
import zipfile
from typing import Any, Optional

from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from plugins.sandbox.executor import SandboxExecutor

logger = logging.getLogger("genesis.skill_engine")


class SkillEngine:
    """Skill 调度与沙箱自愈引擎：管理无状态容器本地缓存、Supabase Storage 联动与沙箱安全执行。"""

    def __init__(self, base_dir: str = "/tmp/genesis/sandboxes"):
        self.base_dir = base_dir
        os.makedirs(self.base_dir, exist_ok=True)

    def get_skill_dir(self, skill_id: str) -> str:
        return os.path.join(self.base_dir, str(skill_id))

    async def ensure_skill_ready(self, skill: dict[str, Any]) -> tuple[str, str]:
        """检查并确保本地存在该 Skill 的可执行环境。

        若容器重启导致本地目录丢失，自动触发自愈逻辑 (Self-Healing) 从 Storage 重新下载解压。
        """
        skill_id = str(skill["id"])
        sandbox_dir = self.get_skill_dir(skill_id)
        manifest = skill.get("manifest") or {}
        entrypoint = manifest.get("entrypoint", "main.py")
        entry_path = os.path.join(sandbox_dir, entrypoint)

        # 检查入口文件是否存在且有效
        if os.path.exists(entry_path):
            return entry_path, sandbox_dir

        logger.info("检测到 Skill [%s] 本地沙箱未就绪，启动自愈解压流程...", skill_id)
        os.makedirs(sandbox_dir, exist_ok=True)

        storage_path = skill.get("storage_path")
        if not storage_path:
            raise AppException(
                code=ErrorCode.SKILL_NOT_FOUND,
                message=f"Skill [{skill.get('name')}] 缺少 storage_path，无法自愈恢复",
            )

        # 1. 尝试从本地既有路径恢复（开发模式）
        if os.path.isfile(storage_path) and storage_path.endswith(".zip"):
            with zipfile.ZipFile(storage_path, "r") as zip_ref:
                zip_ref.extractall(sandbox_dir)
        else:
            # 2. 从 Supabase Storage 跨节点拉取
            try:
                client = get_supabase_client()
                file_bytes = client.storage.from_("skills").download(storage_path)
                with zipfile.ZipFile(io.BytesIO(file_bytes), "r") as zip_ref:
                    zip_ref.extractall(sandbox_dir)
            except Exception as exc:
                logger.error("从 Storage 下载 Skill [%s] 失败: %s", storage_path, str(exc))
                raise AppException(
                    code=ErrorCode.SANDBOX_ERROR,
                    message=f"自愈下载 Skill 归档失败: {str(exc)}",
                    details={"storage_path": storage_path, "error": str(exc)},
                )

        if not os.path.exists(entry_path):
            raise AppException(
                code=ErrorCode.SANDBOX_ERROR,
                message=f"解压后未在 Skill 根目录找到入口脚本: {entrypoint}",
                details={"expected_entry_path": entry_path},
            )

        return entry_path, sandbox_dir

    async def execute_skill(
        self,
        skill: dict[str, Any],
        arguments: dict[str, Any],
        timeout: int = 30,
    ) -> dict[str, Any]:
        """自愈调度并执行沙箱任务"""
        entry_path, sandbox_dir = await self.ensure_skill_ready(skill)
        return await SandboxExecutor.run_skill(
            entry_path=entry_path,
            working_dir=sandbox_dir,
            input_args=arguments,
            timeout=timeout,
        )

    def unpack_and_validate_zip(self, zip_bytes: bytes, target_dir: str) -> dict[str, Any]:
        """解压用户上传的 Skill zip 包并校验 manifest.json 结构"""
        os.makedirs(target_dir, exist_ok=True)
        try:
            with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zip_ref:
                zip_ref.extractall(target_dir)
        except Exception as exc:
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"无法解析上传的 Zip 压缩归档: {str(exc)}",
            )

        manifest_path = os.path.join(target_dir, "manifest.json")
        if not os.path.exists(manifest_path):
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message="Skill 压缩包根目录必须包含 manifest.json 清单文件",
            )

        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest_data = json.load(f)
        except Exception as exc:
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"manifest.json 格式非法: {str(exc)}",
            )

        entrypoint = manifest_data.get("entrypoint", "main.py")
        if not os.path.exists(os.path.join(target_dir, entrypoint)):
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"未找到 manifest.json 声明的入口脚本: {entrypoint}",
            )

        return manifest_data

    def cleanup_sandbox(self, skill_id: str) -> None:
        """卸载或清理本地缓存"""
        sandbox_dir = self.get_skill_dir(skill_id)
        if os.path.exists(sandbox_dir):
            shutil.rmtree(sandbox_dir, ignore_errors=True)


# 全局单例
skill_engine = SkillEngine()
