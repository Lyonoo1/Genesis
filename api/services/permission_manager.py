import asyncio
import logging
import re
from typing import Any, Optional

logger = logging.getLogger("genesis.permission")


class PermissionDecision:
    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


class PermissionManager:
    """Claude Code (s03) 工业级三道闸门权限管线：硬黑名单 -> 高危规则匹配 -> 人机协同审批"""

    _instance: Optional["PermissionManager"] = None

    # 闸门 1: 硬拒绝黑名单 (永远禁止的操作)
    DENY_LIST = [
        "rm -rf /",
        "rm -rf ~",
        "rm -rf /*",
        "sudo ",
        "dd if=",
        "mkfs",
        "> /dev/sda",
        ">/dev/sda",
        "shutdown",
        "reboot",
        ":(){ :|:& };:",  # fork bomb
    ]

    # 闸门 2: 高危破坏性规则识别
    DESTRUCTIVE_COMMAND_WORD = re.compile(
        r"(?i)(?:^|[;&|()\n])\s*(?:rm|del|rmdir|format|mkfs|drop\s+table|drop\s+database|chmod\s+777)(?=\s|$|[;&|()])"
    )

    # 闸门 2: 敏感文件与系统路径规则 (env, env.*, git, ssh, aws)
    SENSITIVE_PATH_PATTERN = re.compile(r"(^|/)\.(env(\.[^/]+)?|git|ssh|aws)(/|$)")

    def __init__(self):
        # 挂起的审批凭证："{session_id}:{tool_call_id}" -> asyncio.Future[bool]
        self._pending_approvals: dict[str, asyncio.Future[bool]] = {}

    @classmethod
    def get_instance(cls) -> "PermissionManager":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _make_key(self, session_id: str, tool_call_id: str) -> str:
        return f"{session_id}:{tool_call_id}"

    def evaluate(
        self,
        tool_name: str,
        args: dict[str, Any],
        workspace_root: Optional[str] = None,
    ) -> tuple[str, Optional[str]]:
        """三道闸门评估：返回 (decision: 'allow' | 'deny' | 'ask', reason: str | None)"""
        # 闸门 1: 检查硬拒绝命令
        if tool_name == "workspace__execute_command":
            cmd = str(args.get("command", "")).strip()
            for bad in self.DENY_LIST:
                if bad in cmd:
                    return (
                        PermissionDecision.DENY,
                        f"安全策略物理拦截：命中系统危险命令黑名单 '{bad}'",
                    )

        # 闸门 2: 检查文件删除等不可逆操作
        if tool_name == "workspace__delete_file":
            path = str(args.get("path", "")).strip()
            return (
                PermissionDecision.ASK,
                f"高危操作审批：智能体申请物理删除文件/目录 '{path}'",
            )

        # 闸门 2: 检查敏感路径读写与越权路径操作
        if tool_name in ("workspace__write_file", "workspace__edit_file", "write_file", "edit_file"):
            raw_path = str(args.get("path", "")).strip()
            norm_path = raw_path.replace("\\", "/")
            if self.SENSITIVE_PATH_PATTERN.search(norm_path):
                return (
                    PermissionDecision.ASK,
                    f"敏感路径强制审批：智能体申请修改敏感文件/目录 '{raw_path}'",
                )

            # 校验是否位于工作区根目录之外
            ws_root = workspace_root or args.get("workspace_root")
            if ws_root:
                try:
                    import os
                    from pathlib import Path
                    target = Path(raw_path)
                    if not target.is_absolute():
                        target = (Path(ws_root) / target).resolve()
                    else:
                        target = target.resolve()
                    root = Path(ws_root).resolve()
                    if not (str(target) == str(root) or str(target).startswith(str(root) + os.sep)):
                        return (
                            PermissionDecision.ASK,
                            f"越权路径强制审批：目标路径 '{raw_path}' 位于工作区根目录之外",
                        )
                except Exception:
                    return (
                        PermissionDecision.ASK,
                        f"越权路径强制审批：目标路径 '{raw_path}' 解析异常",
                    )
            else:
                if os.path.isabs(raw_path) or norm_path.startswith("..") or "/../" in norm_path:
                    return (
                        PermissionDecision.ASK,
                        f"越权路径强制审批：目标路径 '{raw_path}' 疑似位于工作区根目录之外",
                    )

        # 闸门 2: 检查 Shell 高危破坏性指令
        if tool_name == "workspace__execute_command":
            cmd = str(args.get("command", "")).strip()
            if self.DESTRUCTIVE_COMMAND_WORD.search(cmd):
                return (
                    PermissionDecision.ASK,
                    f"高危操作审批：智能体申请在终端执行敏感命令 '{cmd}'",
                )

        # 闸门 3 未命中：默认直接放行（只读、普通编辑、非高危命令）
        return PermissionDecision.ALLOW, None

    def register_approval(
        self,
        session_id: str,
        tool_call_id: str,
    ) -> asyncio.Future[bool]:
        """为需要用户人工批准的操作注册异步 Future"""
        key = self._make_key(session_id, tool_call_id)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()
        self._pending_approvals[key] = future
        return future

    def resolve_approval(
        self,
        session_id: str,
        tool_call_id: str,
        approved: bool,
    ) -> bool:
        """用户在前端点击批准/拒绝后，唤醒挂起的 Future 协程"""
        key = self._make_key(session_id, tool_call_id)
        future = self._pending_approvals.pop(key, None)
        if future and not future.done():
            future.set_result(approved)
            logger.info("会话 [%s] 的工具调用 [%s] 审批已判定: %s", session_id, tool_call_id, approved)
            return True
        return False

    def cancel_session_approvals(self, session_id: str) -> None:
        """清理指定会话中所有遗留的审批 Future"""
        prefix = f"{session_id}:"
        keys_to_clear = [k for k in self._pending_approvals if k.startswith(prefix)]
        for k in keys_to_clear:
            fut = self._pending_approvals.pop(k, None)
            if fut and not fut.done():
                fut.cancel()


permission_manager = PermissionManager.get_instance()
ApprovalManager = PermissionManager
approval_manager = permission_manager
