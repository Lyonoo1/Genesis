import asyncio
import difflib
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("genesis.permission")


class PermissionDecision:
    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


class PermissionMode:
    """三档权限审批粒度模式"""

    ACCEPT_EDITS = "accept_edits"  # 默认：放行常规编辑与非破坏性命令；高危/敏感/越权/删除弹窗
    DEFAULT = "default"  # 标准：放行常规编辑与只读命令；非只读命令与高危/敏感/越权/删除弹窗
    REVIEW_ALL = "review_all"  # 严格：常规文件写/编辑与非只读命令均弹窗审阅

    VALID_MODES = {ACCEPT_EDITS, DEFAULT, REVIEW_ALL}

    @classmethod
    def normalize(cls, mode: Optional[str]) -> str:
        if not mode:
            return cls.ACCEPT_EDITS
        lowered = str(mode).strip().lower()
        if lowered in cls.VALID_MODES:
            return lowered
        # 兼容旧前端命名
        if lowered == "approval":
            return cls.DEFAULT
        if lowered in ("auto", "full"):
            return cls.ACCEPT_EDITS
        return cls.ACCEPT_EDITS


# 保守只读命令首词白名单（不含写文件/安装依赖/修改仓库状态的命令）
_READ_ONLY_SINGLE_COMMANDS = {
    "ls",
    "ll",
    "la",
    "pwd",
    "cat",
    "head",
    "tail",
    "wc",
    "find",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "ag",
    "fd",
    "tree",
    "stat",
    "file",
    "which",
    "whereis",
    "type",
    "echo",
    "printf",
    "env",
    "printenv",
    "whoami",
    "uname",
    "date",
    "dirname",
    "basename",
    "realpath",
    "readlink",
    "du",
    "df",
    "ps",
    "id",
    "sort",
    "uniq",
    "cut",
    "tr",
    "diff",
    "cmp",
    "md5",
    "md5sum",
    "shasum",
    "sha256sum",
    "true",
    "false",
}

_READ_ONLY_GIT_SUBCOMMANDS = {
    "status",
    "log",
    "diff",
    "show",
    "rev-parse",
    "ls-files",
    "describe",
    "blame",
    "shortlog",
}

_VERSION_CHECK_COMMANDS = {"node", "npm", "pnpm", "yarn", "python", "python3", "uv", "rustc", "cargo", "go"}

_SHELL_WRITE_OPERATORS = re.compile(r"(?:>>?|\$\(|`|<\(|>\()")
_SHELL_SEGMENT_SPLIT = re.compile(r"\s*(?:&&|\|\||;|\|)\s*")
_ENV_ASSIGN_TOKEN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$")

_FILE_MUTATION_TOOLS = {
    "workspace__write_file",
    "workspace__edit_file",
    "write_file",
    "edit_file",
}
_SHELL_EXEC_TOOLS = {"workspace__execute_command", "workspace__exec_command"}


def _extract_command(tool_name: str, args: dict[str, Any]) -> str:
    if tool_name == "workspace__exec_command":
        return str(args.get("cmd") or args.get("command") or "").strip()
    return str(args.get("command") or args.get("cmd") or "").strip()


def is_read_only_command(cmd: str) -> bool:
    """保守判定 Shell 命令是否为纯只读命令"""
    cleaned = (cmd or "").strip()
    if not cleaned:
        return False
    if _SHELL_WRITE_OPERATORS.search(cleaned):
        return False

    segments = [seg.strip() for seg in _SHELL_SEGMENT_SPLIT.split(cleaned) if seg.strip()]
    if not segments:
        return False

    for seg in segments:
        tokens = seg.split()
        # 跳过前导环境变量赋值如 FOO=1 ls
        idx = 0
        while idx < len(tokens) and _ENV_ASSIGN_TOKEN.match(tokens[idx]):
            idx += 1
        if idx >= len(tokens):
            return False
        head = tokens[idx]
        rest = tokens[idx + 1 :]

        if head in _READ_ONLY_SINGLE_COMMANDS:
            # 拦截 find -delete / find -exec
            if head == "find" and any(t in ("-delete", "-exec", "-execdir") for t in rest):
                return False
            continue

        if head == "git":
            if not rest:
                continue
            sub = rest[0]
            if sub in _READ_ONLY_GIT_SUBCOMMANDS:
                continue
            if sub == "branch" and not any(
                t in ("-d", "-D", "--delete", "-m", "-M", "-c", "-C") for t in rest[1:]
            ):
                continue
            if sub == "remote" and (len(rest) == 1 or rest[1] in ("-v", "show")):
                continue
            return False

        if head in _VERSION_CHECK_COMMANDS and len(rest) == 1 and rest[0] in ("-v", "-V", "--version", "version"):
            continue

        return False

    return True


_SHELL_SCOPE_UNSAFE_OPERATORS = re.compile(r"(?:&&|\|\||[;|<>`\n]|\$\()")


def build_scope_signature(
    tool_name: str,
    args: dict[str, Any],
    workspace_root: Optional[str] = None,
) -> Optional[str]:
    """后端唯一权威的 scope_signature 生成函数。

    删除类、敏感路径、越权路径、高危破坏性命令及复合/重定向 Shell 命令一律返回 None（禁止会话级放行）。
    """
    if tool_name == "workspace__delete_file":
        return None

    if tool_name in _FILE_MUTATION_TOOLS:
        raw_path = str(args.get("path", "")).strip()
        if not raw_path:
            return None
        is_restricted, _ = PermissionManager.check_restricted_path(
            raw_path, workspace_root=workspace_root or args.get("workspace_root")
        )
        if is_restricted:
            return None
        return f"edit:{raw_path}"

    if tool_name in _SHELL_EXEC_TOOLS:
        cmd = _extract_command(tool_name, args)
        if not cmd:
            return None
        if (
            PermissionManager.matches_deny_list(cmd)
            or PermissionManager.DESTRUCTIVE_COMMAND_WORD.search(cmd)
            or _SHELL_SCOPE_UNSAFE_OPERATORS.search(cmd)
        ):
            return None
        tokens = cmd.split()
        return f"bash:{' '.join(tokens[:2])}" if tokens else None

    return f"tool:{tool_name}"


def _compute_file_diff_preview(
    tool_name: str,
    args: dict[str, Any],
    workspace_root: Optional[str] = None,
) -> tuple[str, Optional[str]]:
    """为写/编辑文件操作预计算 unified diff 与 +N -M 统计。"""
    raw_path = str(args.get("path", "")).strip()
    old_content = ""
    if raw_path and workspace_root and not str(workspace_root).startswith("bridge://"):
        try:
            target = Path(raw_path)
            if not target.is_absolute():
                target = (Path(workspace_root) / target).resolve()
            else:
                target = target.resolve()
            if target.exists() and target.is_file():
                old_content = target.read_text(encoding="utf-8", errors="replace")
        except Exception:
            old_content = ""

    if tool_name in ("workspace__edit_file", "edit_file"):
        old_str = str(args.get("old_string", ""))
        new_str = str(args.get("new_string", ""))
        if old_content and old_str and old_str in old_content:
            new_content = old_content.replace(old_str, new_str, 1)
            diff_lines = list(
                difflib.unified_diff(
                    old_content.splitlines(),
                    new_content.splitlines(),
                    fromfile=f"a/{raw_path or 'file'}",
                    tofile=f"b/{raw_path or 'file'}",
                    lineterm="",
                    n=3,
                )
            )
        else:
            diff_lines = list(
                difflib.unified_diff(
                    old_str.splitlines(),
                    new_str.splitlines(),
                    fromfile=f"a/{raw_path or 'file'}",
                    tofile=f"b/{raw_path or 'file'}",
                    lineterm="",
                    n=3,
                )
            )
    else:
        new_content = str(args.get("content", ""))
        diff_lines = list(
            difflib.unified_diff(
                old_content.splitlines(),
                new_content.splitlines(),
                fromfile=f"a/{raw_path or 'file'}",
                tofile=f"b/{raw_path or 'file'}",
                lineterm="",
                n=3,
            )
        )

    additions = sum(1 for ln in diff_lines if ln.startswith("+") and not ln.startswith("+++"))
    deletions = sum(1 for ln in diff_lines if ln.startswith("-") and not ln.startswith("---"))
    diff_stat = f"+{additions} -{deletions}" if (additions or deletions) else None
    diff_text = "\n".join(diff_lines) if diff_lines else (str(args.get("content", ""))[:2000] or "(无变更内容)")
    return diff_text, diff_stat


def build_tool_approval_item(
    tool_call_id: str,
    tool_name: str,
    args: dict[str, Any],
    perm_reason: Optional[str],
    scope_signature: Optional[str],
    workspace_root: Optional[str] = None,
) -> dict[str, Any]:
    """构造 confirmation_required 中的 tool_approval 项，包含 code_preview、risk_level 与 diff_stat。"""
    is_high_risk = False
    if tool_name == "workspace__delete_file":
        is_high_risk = True
    elif tool_name in _SHELL_EXEC_TOOLS:
        cmd = _extract_command(tool_name, args)
        if PermissionManager.DESTRUCTIVE_COMMAND_WORD.search(cmd):
            is_high_risk = True
    elif tool_name in _FILE_MUTATION_TOOLS:
        raw_path = str(args.get("path", "")).strip()
        restricted, _ = PermissionManager.check_restricted_path(
            raw_path, workspace_root=workspace_root or args.get("workspace_root")
        )
        if restricted:
            is_high_risk = True

    if is_high_risk:
        risk_level = "high"
    elif tool_name in _SHELL_EXEC_TOOLS or tool_name in _FILE_MUTATION_TOOLS:
        risk_level = "medium"
    else:
        risk_level = "low"

    diff_stat: Optional[str] = None
    if tool_name in _SHELL_EXEC_TOOLS:
        cmd = _extract_command(tool_name, args)
        code_preview: dict[str, Any] = {
            "language": "bash",
            "content": cmd,
        }
        title = "允许 Genesis 执行终端命令？"
        review_title = "是否执行以下终端命令？"
    elif tool_name in _FILE_MUTATION_TOOLS:
        raw_path = str(args.get("path", "")).strip()
        diff_text, diff_stat = _compute_file_diff_preview(tool_name, args, workspace_root=workspace_root)
        code_preview = {
            "language": "diff",
            "filename": raw_path or undefined_filename(args),
            "content": diff_text,
        }
        title = f"允许 Genesis 修改 {raw_path or '工作区文件'}？"
        review_title = "是否应用以下文件变更？"
    elif tool_name == "workspace__delete_file":
        raw_path = str(args.get("path", "")).strip()
        code_preview = {
            "language": "bash",
            "filename": raw_path or None,
            "content": f"rm -rf {raw_path}",
        }
        title = f"允许 Genesis 删除 {raw_path or '目标文件'}？"
        review_title = "是否确认删除以下文件或目录？"
    else:
        try:
            pretty_args = json.dumps(args or {}, ensure_ascii=False, indent=2)
        except Exception:
            pretty_args = str(args)
        code_preview = {
            "language": "json",
            "content": pretty_args,
        }
        title = f"允许 Genesis 调用工具 {tool_name}？"
        review_title = "是否批准以下工具调用？"

    item: dict[str, Any] = {
        "item_id": f"item_{tool_call_id}",
        "tool_call_id": tool_call_id,
        "title": title,
        "review_title": review_title,
        "subtitle": perm_reason or "该操作需要你的明确确认后方可执行。",
        "selection_mode": "approval",
        "risk_level": risk_level,
        "tool_name": tool_name,
        "scope_signature": scope_signature,
        "code_preview": code_preview,
        "custom_input": {
            "enabled": True,
            "mode": "override",
            "placeholder": "拒绝并告知 Genesis 调整方向…",
        },
    }
    if diff_stat:
        item["diff_stat"] = diff_stat
    return item


def undefined_filename(args: dict[str, Any]) -> Optional[str]:
    val = args.get("filename") or args.get("file") or args.get("path")
    return str(val).strip() if val else None


class PermissionManager:
    """工业级三道闸门权限管线 + 人机协同确认状态与防过度提问配额中心"""

    _instance: Optional["PermissionManager"] = None

    # 闸门 1: 硬拒绝黑名单 (任何模式下永远物理拦截，优先级高于一切白名单)
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

    # 闸门 2: 敏感文件与系统路径规则 (env, env.*, git, ssh, aws；忽略大小写以防 macOS/Windows 绕过)
    SENSITIVE_PATH_PATTERN = re.compile(r"(?i)(^|/)\.(env(\.[^/]+)?|git|ssh|aws)(/|$)")

    # agent__ask_user 防过度提问硬常量
    MAX_ASK_CALLS_PER_TURN = 1
    MAX_ASK_ITEMS_PER_CALL = 3
    CONSECUTIVE_SKIP_COOLDOWN_THRESHOLD = 2

    def __init__(self):
        # 挂起的确认凭证："{session_id}:{request_id}" -> asyncio.Future[dict]
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        # 向后兼容旧字段名指向同一容器（仅供内部调试/历史引用）
        self._pending_approvals = self._pending
        # 下发时记录的权威 scope_signature，用于 resolve 时二次防伪造校验
        self._expected_scopes: dict[str, Optional[str]] = {}
        # 挂起请求的完整下发信封（供 P2-1/P2-2 事件总线快照与刷新恢复使用）
        self._envelopes: dict[str, dict[str, Any]] = {}
        # 挂起请求的上下文（user_id / workspace_root / risk_level，供 P2-3 工作区规则写入校验）
        self._request_context: dict[str, dict[str, Any]] = {}
        # 会话级白名单：session_id -> {scope_signature}
        self._session_grants: dict[str, set[str]] = {}
        # 工作区级持久化权限规则缓存：(user_id, workspace_key) -> {scope_signature}
        self._ws_rules_cache: dict[tuple[str, str], set[str]] = {}
        # agent__ask_user 防过度提问状态：session_id -> 本轮已提问次数 / 跨轮连续跳过次数 / 冷却状态
        self._turn_ask_counts: dict[str, int] = {}
        self._consecutive_skips: dict[str, int] = {}
        self._cooldown_sessions: set[str] = set()
        self._cooldown_active_turn: set[str] = set()

    @classmethod
    def get_instance(cls) -> "PermissionManager":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _make_key(self, session_id: str, request_id: str) -> str:
        return f"{session_id}:{request_id}"

    @classmethod
    def matches_deny_list(cls, cmd: str) -> Optional[str]:
        for bad in cls.DENY_LIST:
            if bad in cmd:
                return bad
        return None

    @classmethod
    def check_restricted_path(
        cls,
        raw_path: str,
        workspace_root: Optional[str] = None,
    ) -> tuple[bool, Optional[str]]:
        """检查是否为敏感路径或工作区越权路径，返回 (is_restricted, reason)"""
        cleaned = (raw_path or "").strip()
        norm_path = cleaned.replace("\\", "/")
        if cls.SENSITIVE_PATH_PATTERN.search(norm_path):
            return True, f"敏感路径强制审批：智能体申请修改敏感文件/目录 '{cleaned}'"

        if workspace_root and not str(workspace_root).startswith("bridge://"):
            try:
                target = Path(cleaned)
                if not target.is_absolute():
                    target = (Path(workspace_root) / target).resolve()
                else:
                    target = target.resolve()
                root = Path(workspace_root).resolve()
                if not (str(target) == str(root) or str(target).startswith(str(root) + os.sep)):
                    return True, f"越权路径强制审批：目标路径 '{cleaned}' 位于工作区根目录之外"
            except Exception:
                return True, f"越权路径强制审批：目标路径 '{cleaned}' 解析异常"
        else:
            if os.path.isabs(cleaned) or norm_path.startswith("..") or "/../" in norm_path:
                return True, f"越权路径强制审批：目标路径 '{cleaned}' 疑似位于工作区根目录之外"

        return False, None

    # ------------------------------------------------------------------
    # 三档权限评估
    # ------------------------------------------------------------------

    def evaluate(
        self,
        tool_name: str,
        args: dict[str, Any],
        workspace_root: Optional[str] = None,
        permission_mode: Optional[str] = None,
    ) -> tuple[str, Optional[str]]:
        """三道闸门 + 三档权限模式评估：返回 (decision: 'allow' | 'deny' | 'ask', reason: str | None)"""
        mode = PermissionMode.normalize(permission_mode)

        # 闸门 1: 硬拒绝命令黑名单（任何模式永远物理拦截）
        if tool_name in _SHELL_EXEC_TOOLS:
            cmd = _extract_command(tool_name, args)
            hit = self.matches_deny_list(cmd)
            if hit:
                return (
                    PermissionDecision.DENY,
                    f"安全策略物理拦截：命中系统危险命令黑名单 '{hit}'",
                )

        # 闸门 2a: 文件删除（任何模式强制审批）
        if tool_name == "workspace__delete_file":
            path = str(args.get("path", "")).strip()
            return (
                PermissionDecision.ASK,
                f"高危操作审批：智能体申请物理删除文件/目录 '{path}'",
            )

        # 闸门 2b: 敏感路径与工作区越权路径（任何模式强制审批）
        if tool_name in _FILE_MUTATION_TOOLS:
            raw_path = str(args.get("path", "")).strip()
            restricted, reason = self.check_restricted_path(
                raw_path, workspace_root=workspace_root or args.get("workspace_root")
            )
            if restricted:
                return PermissionDecision.ASK, reason

            # review_all 模式：常规文件写/编辑也弹 Diff 审批
            if mode == PermissionMode.REVIEW_ALL:
                return (
                    PermissionDecision.ASK,
                    f"全量审阅模式：智能体申请写入或编辑文件 '{raw_path}'",
                )
            return PermissionDecision.ALLOW, None

        # 闸门 2c: Shell 破坏性指令与模式分层
        if tool_name in _SHELL_EXEC_TOOLS:
            cmd = _extract_command(tool_name, args)
            if self.DESTRUCTIVE_COMMAND_WORD.search(cmd):
                return (
                    PermissionDecision.ASK,
                    f"高危操作审批：智能体申请在终端执行敏感命令 '{cmd}'",
                )
            # default / review_all 模式：对所有非只读命令弹窗
            if mode in (PermissionMode.DEFAULT, PermissionMode.REVIEW_ALL):
                if not is_read_only_command(cmd):
                    return (
                        PermissionDecision.ASK,
                        f"命令执行审批：智能体申请在终端执行非只读命令 '{cmd}'",
                    )
            return PermissionDecision.ALLOW, None

        # 闸门 3 未命中：默认直接放行
        return PermissionDecision.ALLOW, None

    # ------------------------------------------------------------------
    # 会话白名单管理（后端权威）
    # ------------------------------------------------------------------

    def is_granted(self, session_id: str, sig: Optional[str]) -> bool:
        return bool(sig) and sig in self._session_grants.get(str(session_id), set())

    def _load_workspace_rules(self, user_id: str, workspace_key: str) -> set[str]:
        cache_key = (str(user_id), str(workspace_key))
        cached = self._ws_rules_cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            from repositories.permission_rule_repository import permission_rule_repository

            rows = permission_rule_repository.list_sync(str(user_id), str(workspace_key))
            sigs = {str(r["scope_signature"]) for r in rows if r.get("scope_signature")}
        except Exception as exc:
            logger.warning("加载工作区权限规则失败: %s", exc)
            sigs = set()
        self._ws_rules_cache[cache_key] = sigs
        return sigs

    def invalidate_workspace_cache(
        self,
        user_id: str,
        workspace_key: Optional[str] = None,
    ) -> None:
        uid = str(user_id)
        if workspace_key:
            self._ws_rules_cache.pop((uid, str(workspace_key)), None)
        else:
            for k in [k for k in list(self._ws_rules_cache.keys()) if k[0] == uid]:
                self._ws_rules_cache.pop(k, None)

    def is_allowed(
        self,
        user_id: Optional[str],
        session_id: str,
        workspace_root: Optional[str],
        sig: Optional[str],
    ) -> bool:
        """统一白名单判定顺序（在 evaluate 返回 ASK 且 sig 非空时调用）：
        1. 工作区持久化规则命中 -> True，并更新 last_used_at
        2. 会话白名单命中 -> True
        """
        if not sig:
            return False
        if user_id and workspace_root:
            from repositories.permission_rule_repository import (
                compute_workspace_key,
                permission_rule_repository,
            )

            ws_key, _ = compute_workspace_key(workspace_root)
            if ws_key:
                ws_sigs = self._load_workspace_rules(str(user_id), ws_key)
                if sig in ws_sigs:
                    try:
                        permission_rule_repository.touch_sync(str(user_id), ws_key, sig)
                    except Exception:
                        pass
                    return True
        return self.is_granted(str(session_id), sig)

    def _apply_scope_grant(
        self,
        *,
        sid: str,
        scope: Optional[str],
        client_sig: Optional[str],
        expected_sig: Optional[str],
        risk_level: Optional[str],
        user_id: Optional[str],
        workspace_root: Optional[str],
    ) -> tuple[str, bool]:
        """校验并落盘 session / workspace_rule 授权，返回 (最终生效 scope, 是否触发 grants_changed)。"""
        if scope == "session":
            if expected_sig and client_sig and client_sig == expected_sig:
                grant_set = self._session_grants.setdefault(sid, set())
                if expected_sig not in grant_set:
                    grant_set.add(expected_sig)
                    return "session", True
                return "session", False
            return "once", False

        if scope == "workspace_rule":
            if (
                risk_level != "high"
                and expected_sig
                and client_sig
                and client_sig == expected_sig
                and user_id
                and workspace_root
            ):
                from repositories.permission_rule_repository import (
                    compute_workspace_key,
                    permission_rule_repository,
                )

                ws_key, ws_label = compute_workspace_key(workspace_root)
                if ws_key:
                    try:
                        permission_rule_repository.add_sync(
                            user_id=str(user_id),
                            workspace_key=ws_key,
                            label=ws_label,
                            sig=expected_sig,
                            session_id=sid,
                        )
                        cache_key = (str(user_id), ws_key)
                        self._load_workspace_rules(str(user_id), ws_key).add(expected_sig)
                        return "workspace_rule", True
                    except Exception as exc:
                        logger.warning("写入工作区权限规则失败，降级为 once: %s", exc)
            return "once", False

        return "once", False

    def list_grants(self, session_id: str) -> list[str]:
        return sorted(self._session_grants.get(str(session_id), set()))

    def clear_grants(self, session_id: str) -> None:
        sid = str(session_id)
        had = sid in self._session_grants and bool(self._session_grants[sid])
        self._session_grants.pop(sid, None)
        if had:
            from services.session_event_bus import session_event_bus

            session_event_bus.publish(sid, "grants_changed", {"grants": []})

    def snapshot(self, session_id: str) -> list[dict[str, Any]]:
        """返回指定会话当前所有挂起确认请求的完整信封快照（供刷新恢复与新标签页同步）。"""
        prefix = f"{session_id}:"
        result: list[dict[str, Any]] = []
        for key, envelope in list(self._envelopes.items()):
            if not key.startswith(prefix):
                continue
            fut = self._pending.get(key)
            if fut and not fut.done():
                result.append(dict(envelope))
        return result

    # ------------------------------------------------------------------
    # 异步挂起 / 决议 / 抢占结案
    # ------------------------------------------------------------------

    def register(
        self,
        session_id: str,
        request_id: str,
        expected_scope_signature: Optional[str] = None,
        envelope: Optional[dict[str, Any]] = None,
        user_id: Optional[str] = None,
        workspace_root: Optional[str] = None,
        risk_level: Optional[str] = None,
        expected_item_scopes: Optional[dict[str, tuple[Optional[str], Optional[str]]]] = None,
    ) -> asyncio.Future[dict[str, Any]]:
        """注册挂起的确认 Future，记录后端下发的权威 scope_signature、完整信封与上下文。"""
        sid = str(session_id)
        rid = str(request_id)
        key = self._make_key(sid, rid)
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[key] = fut
        self._expected_scopes[key] = expected_scope_signature
        self._request_context[key] = {
            "user_id": str(user_id) if user_id else None,
            "workspace_root": workspace_root,
            "risk_level": risk_level,
            "expected_item_scopes": expected_item_scopes or {},
        }
        if envelope is not None:
            env_copy = dict(envelope)
            self._envelopes[key] = env_copy
            from services.session_event_bus import session_event_bus

            session_event_bus.publish(sid, "confirmation_required", env_copy)
        return fut

    def resolve(
        self,
        session_id: str,
        request_id: str,
        payload: dict[str, Any],
    ) -> bool:
        """幂等结案挂起确认。若请求会话/工作区白名单，强制与后端下发签名比对防伪造。"""
        sid = str(session_id)
        rid = str(request_id)
        key = self._make_key(sid, rid)
        fut = self._pending.pop(key, None)
        expected_sig = self._expected_scopes.pop(key, None)
        self._envelopes.pop(key, None)
        ctx = self._request_context.pop(key, {})
        if not fut or fut.done():
            return False

        normalized = dict(payload or {})
        grants_updated = False

        if normalized.get("kind") == "batch_approval" and isinstance(
            normalized.get("item_decisions"), dict
        ):
            # P2-4 批量审批：逐条校验 scope_signature 与 risk_level
            expected_items: dict[str, tuple[Optional[str], Optional[str]]] = (
                ctx.get("expected_item_scopes") or {}
            )
            cleaned_items: dict[str, dict[str, Any]] = {}
            for item_id, raw_dec in normalized["item_decisions"].items():
                if not isinstance(raw_dec, dict):
                    continue
                item_dec = dict(raw_dec)
                if item_dec.get("decision") == "approved" and item_dec.get("permission_scope") in (
                    "session",
                    "workspace_rule",
                ):
                    exp_sig, exp_risk = expected_items.get(str(item_id), (None, None))
                    effective_scope, changed = self._apply_scope_grant(
                        sid=sid,
                        scope=item_dec.get("permission_scope"),
                        client_sig=item_dec.get("scope_signature"),
                        expected_sig=exp_sig,
                        risk_level=exp_risk,
                        user_id=ctx.get("user_id"),
                        workspace_root=ctx.get("workspace_root"),
                    )
                    item_dec["permission_scope"] = effective_scope
                    if effective_scope == "once":
                        item_dec.pop("scope_signature", None)
                    if changed:
                        grants_updated = True
                cleaned_items[str(item_id)] = item_dec
            normalized["item_decisions"] = cleaned_items
        elif (
            normalized.get("decision") == "approved"
            and normalized.get("permission_scope") in ("session", "workspace_rule")
        ):
            requested_scope = normalized.get("permission_scope")
            effective_scope, changed = self._apply_scope_grant(
                sid=sid,
                scope=requested_scope,
                client_sig=normalized.get("scope_signature"),
                expected_sig=expected_sig,
                risk_level=ctx.get("risk_level"),
                user_id=ctx.get("user_id"),
                workspace_root=ctx.get("workspace_root"),
            )
            if effective_scope != requested_scope:
                logger.warning(
                    "会话 [%s] 请求 [%s] 白名单授权校验未通过 (scope=%s client=%s expected=%s risk=%s)，降级为 once",
                    session_id,
                    request_id,
                    requested_scope,
                    normalized.get("scope_signature"),
                    expected_sig,
                    ctx.get("risk_level"),
                )
                normalized["permission_scope"] = "once"
                normalized.pop("scope_signature", None)
            if changed:
                grants_updated = True

        fut.set_result(normalized)
        from services.session_event_bus import session_event_bus

        session_event_bus.publish(
            sid,
            "confirmation_resolved",
            {
                "request_id": rid,
                "decision": str(normalized.get("decision") or "dismissed"),
            },
        )
        if grants_updated:
            session_event_bus.publish(
                sid,
                "grants_changed",
                {"grants": self.list_grants(sid)},
            )
        logger.info(
            "会话 [%s] 确认请求 [%s] 已结案: decision=%s scope=%s",
            session_id,
            request_id,
            normalized.get("decision"),
            normalized.get("permission_scope"),
        )
        return True

    def supersede_session(
        self,
        session_id: str,
        message: Optional[str] = None,
    ) -> list[str]:
        """Chat Override：新消息到达时以 superseded_by_message 原子结案该会话所有挂起项。"""
        sid = str(session_id)
        prefix = f"{sid}:"
        resolved_ids: list[str] = []
        from services.session_event_bus import session_event_bus

        for k in [k for k in list(self._pending.keys()) if k.startswith(prefix)]:
            fut = self._pending.pop(k, None)
            self._expected_scopes.pop(k, None)
            self._envelopes.pop(k, None)
            if fut and not fut.done():
                rid = k[len(prefix) :]
                fut.set_result(
                    {
                        "decision": "superseded_by_message",
                        "superseding_message": message,
                    }
                )
                resolved_ids.append(rid)
                session_event_bus.publish(
                    sid,
                    "confirmation_resolved",
                    {"request_id": rid, "decision": "superseded_by_message"},
                )
        if resolved_ids:
            logger.info(
                "会话 [%s] 因用户新消息抢占，已自动结案 %d 个挂起确认: %s",
                session_id,
                len(resolved_ids),
                resolved_ids,
            )
        return resolved_ids

    def cancel_session_approvals(self, session_id: str) -> None:
        """清理指定会话中遗留的挂起 Future（保留 _session_grants 供同会话下一轮复用）。"""
        sid = str(session_id)
        prefix = f"{sid}:"
        keys_to_clear = [k for k in list(self._pending.keys()) if k.startswith(prefix)]
        from services.session_event_bus import session_event_bus

        for k in keys_to_clear:
            fut = self._pending.pop(k, None)
            self._expected_scopes.pop(k, None)
            self._envelopes.pop(k, None)
            if fut and not fut.done():
                fut.cancel()
                rid = k[len(prefix) :]
                session_event_bus.publish(
                    sid,
                    "confirmation_resolved",
                    {"request_id": rid, "decision": "dismissed"},
                )

    def cleanup_session(self, session_id: str) -> None:
        """会话被物理删除时彻底清理其挂起项、白名单与提问冷却态。"""
        sid = str(session_id)
        self.cancel_session_approvals(sid)
        self.clear_grants(sid)
        self._turn_ask_counts.pop(sid, None)
        self._consecutive_skips.pop(sid, None)
        self._cooldown_sessions.discard(sid)
        self._cooldown_active_turn.discard(sid)

    # 兼容旧调用方法（支持旧测试与过渡期代码）
    def register_approval(
        self,
        session_id: str,
        tool_call_id: str,
    ) -> asyncio.Future[Any]:
        return self.register(str(session_id), str(tool_call_id))

    def resolve_approval(
        self,
        session_id: str,
        tool_call_id: str,
        approved: bool,
    ) -> bool:
        sid = str(session_id)
        key_direct = self._make_key(sid, str(tool_call_id))
        if key_direct in self._pending:
            fut = self._pending.pop(key_direct, None)
            self._expected_scopes.pop(key_direct, None)
            self._envelopes.pop(key_direct, None)
            if fut and not fut.done():
                fut.set_result(bool(approved))
                from services.session_event_bus import session_event_bus

                session_event_bus.publish(
                    sid,
                    "confirmation_resolved",
                    {
                        "request_id": str(tool_call_id),
                        "decision": "approved" if approved else "rejected",
                    },
                )
                return True
            return False
        # 若注册时使用了 cf_ 前缀，兼容映射
        cf_id = str(tool_call_id) if str(tool_call_id).startswith("cf_") else f"cf_{tool_call_id}"
        return self.resolve(
            sid,
            cf_id,
            {
                "request_id": cf_id,
                "decision": "approved" if approved else "rejected",
                "permission_scope": "once",
            },
        )

    # ------------------------------------------------------------------
    # agent__ask_user 双层防过度提问配额与熔断管理
    # ------------------------------------------------------------------

    def advance_user_turn(self, session_id: str) -> None:
        """进入新的用户消息轮次时推进提问配额与跨轮冷却状态。

        - 每轮重置单轮提问计数 _turn_ask_counts = 0；
        - 保留未达阈值的跨轮连续跳过计数 _consecutive_skips（否则单轮限 1 次时永远无法累加到 2）；
        - 当连续 2 次跳过触发冷却后，下一完整用户轮为冷却生效轮（拦截 ask_user），
          再下一轮用户主动发消息时自动解除冷却并清零跳过计数。
        """
        sid = str(session_id)
        self._turn_ask_counts[sid] = 0
        if sid in self._cooldown_sessions:
            if sid in self._cooldown_active_turn:
                self._cooldown_sessions.discard(sid)
                self._cooldown_active_turn.discard(sid)
                self._consecutive_skips.pop(sid, None)
            else:
                self._cooldown_active_turn.add(sid)

    def reset_turn_ask_quota(self, session_id: str, reset_cooldown: bool = True) -> None:
        """重置本轮提问计数；reset_cooldown=True 时同时显式清除跳过计数与冷却状态。"""
        sid = str(session_id)
        self._turn_ask_counts[sid] = 0
        if reset_cooldown:
            self._consecutive_skips.pop(sid, None)
            self._cooldown_sessions.discard(sid)
            self._cooldown_active_turn.discard(sid)

    def check_and_consume_ask_quota(self, session_id: str) -> tuple[bool, Optional[dict[str, Any]]]:
        """校验单轮配额与连续跳过冷却。允许则消耗 1 次配额并返回 (True, None)，否则返回短路结果。"""
        sid = str(session_id)
        if sid in self._cooldown_sessions:
            return False, {
                "status": "cooldown_active",
                "hint": "用户近期连续跳过澄清提问，系统已开启免打扰冷却。请直接采用合理默认方案推进，禁止再次提问。",
            }

        used = self._turn_ask_counts.get(sid, 0)
        if used >= self.MAX_ASK_CALLS_PER_TURN:
            return False, {
                "status": "quota_exceeded",
                "hint": "本轮对话已提问过 1 次，系统禁止连续追问。请基于现有上下文与合理假设直接执行。",
            }

        self._turn_ask_counts[sid] = used + 1
        return True, None

    def record_ask_outcome(self, session_id: str, decision: str) -> None:
        """根据本次 ask_user 结案结果更新连续跳过计数与冷却状态。"""
        sid = str(session_id)
        if decision in ("dismissed", "skipped_all"):
            count = self._consecutive_skips.get(sid, 0) + 1
            self._consecutive_skips[sid] = count
            if count >= self.CONSECUTIVE_SKIP_COOLDOWN_THRESHOLD:
                self._cooldown_sessions.add(sid)
                self._cooldown_active_turn.discard(sid)
        elif decision == "submitted":
            self._consecutive_skips[sid] = 0
            self._cooldown_sessions.discard(sid)
            self._cooldown_active_turn.discard(sid)

    @classmethod
    def normalize_ask_items(cls, raw_items: Any) -> tuple[list[dict[str, Any]], str]:
        """规范化 agent__ask_user 的 items：
        - 硬截断最多 3 题
        - 选择题若未标记任何 recommended: True，自动将首项 options[0].recommended 置为 True
        - 推断 kind: 'parameter_form' 或 'clarification'
        """
        if not isinstance(raw_items, list):
            raw_items = []

        normalized: list[dict[str, Any]] = []
        for idx, raw in enumerate(raw_items[: cls.MAX_ASK_ITEMS_PER_CALL]):
            if not isinstance(raw, dict):
                continue
            item_id = str(raw.get("item_id") or f"q_{idx + 1}")
            title = str(raw.get("title") or f"请确认第 {idx + 1} 项").strip()
            subtitle = str(raw.get("subtitle")).strip() if raw.get("subtitle") else None
            form_fields = raw.get("form_fields") if isinstance(raw.get("form_fields"), list) else None
            raw_options = raw.get("options") if isinstance(raw.get("options"), list) else None

            selection_mode = str(raw.get("selection_mode") or "").strip().lower()
            if selection_mode not in ("single", "multi", "form"):
                if form_fields:
                    selection_mode = "form"
                else:
                    selection_mode = "single"

            item: dict[str, Any] = {
                "item_id": item_id,
                "title": title,
                "selection_mode": selection_mode,
            }
            if subtitle:
                item["subtitle"] = subtitle

            if selection_mode in ("single", "multi"):
                clean_options: list[dict[str, Any]] = []
                for opt_idx, opt in enumerate(raw_options or []):
                    if not isinstance(opt, dict):
                        continue
                    opt_id = str(opt.get("id") or f"opt_{opt_idx + 1}")
                    label = str(opt.get("label") or opt_id).strip()
                    clean_opt: dict[str, Any] = {
                        "id": opt_id,
                        "label": label,
                    }
                    if opt.get("description"):
                        clean_opt["description"] = str(opt["description"]).strip()
                    if opt.get("recommended") is True:
                        clean_opt["recommended"] = True
                    clean_options.append(clean_opt)

                if clean_options and not any(o.get("recommended") is True for o in clean_options):
                    clean_options[0]["recommended"] = True

                item["options"] = clean_options
                if selection_mode == "single":
                    item["auto_advance"] = raw.get("auto_advance", True) is not False

                raw_custom = raw.get("custom_input")
                if isinstance(raw_custom, dict):
                    item["custom_input"] = {
                        "enabled": raw_custom.get("enabled", True) is not False,
                        "mode": "append" if selection_mode == "multi" else str(raw_custom.get("mode") or "override"),
                        "placeholder": str(
                            raw_custom.get("placeholder")
                            or ("补充说明或附加要求…" if selection_mode == "multi" else "或者告诉 Genesis 其他想法…")
                        ),
                    }
                else:
                    item["custom_input"] = {
                        "enabled": True,
                        "mode": "append" if selection_mode == "multi" else "override",
                        "placeholder": "补充说明或附加要求…" if selection_mode == "multi" else "或者告诉 Genesis 其他想法…",
                    }
            else:
                clean_fields: list[dict[str, Any]] = []
                for f_idx, field in enumerate(form_fields or []):
                    if not isinstance(field, dict):
                        continue
                    f_key = str(field.get("key") or f"field_{f_idx + 1}")
                    f_type = str(field.get("type") or "text")
                    if f_type not in ("text", "number", "select", "boolean", "json"):
                        f_type = "text"
                    clean_field: dict[str, Any] = {
                        "key": f_key,
                        "label": str(field.get("label") or f_key),
                        "type": f_type,
                    }
                    for opt_k in ("description", "required", "placeholder", "default_value", "options", "pattern", "min", "max"):
                        if opt_k in field and field[opt_k] is not None:
                            clean_field[opt_k] = field[opt_k]
                    clean_fields.append(clean_field)
                item["form_fields"] = clean_fields

            normalized.append(item)

        if normalized and all(it.get("selection_mode") == "form" for it in normalized):
            kind = "parameter_form"
        else:
            kind = "clarification"
        return normalized, kind


permission_manager = PermissionManager.get_instance()
ApprovalManager = PermissionManager
approval_manager = permission_manager
