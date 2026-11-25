import ast
import difflib
import hashlib
import json
import logging
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Union

from models.schemas.chat import SSEEventName
from models.schemas.stream_envelope import (
    AgentRunMode,
    EnvelopeEmitter,
    StreamChannel,
)
from services.todo_manager import todo_manager
from services.tool_adapter import ToolAdapter

logger = logging.getLogger("genesis.context_compiler")

GREETING_REGEX = re.compile(
    r"^(你好[啊呀嘛呢]?|您好|hi|hello|hey|在吗|在么|早|早安|晚安|哈喽|早上好|下午好|晚上好)[\s!！。.~?？]*$",
    re.IGNORECASE,
)

FROZEN_STATIC_SYSTEM_PROMPT = (
    "你是 Genesis 智能编程助手与 Coding Agent，直接运行于用户本地工作区环境中。\n"
    "你拥有直接操纵工作区文件的内置工具（workspace__delete_file、workspace__write_file、"
    "workspace__edit_file、workspace__read_file、workspace__list_dir、workspace__execute_command、"
    "workspace__grep_search、workspace__find_by_name、workspace__dispatch_subagent、workspace__todo_write）"
    "以及 MCP 和 Skills。\n\n"
    "【工具调用行为规范】：\n"
    "1. 意图定界与防过度行动（严格执行）：\n"
    "   - 代码示例/概念演示/知识问答（如'做个简单示例'、'写个 demo'、'如何实现'、'示例代码'等）："
    "直接在回复的 Markdown 代码块中输出清晰可用的代码示例，严禁擅自调用 write_file、edit_file 或 execute_command 去修改或执行用户本地项目文件！\n"
    "   - 明确落盘需求（如明确指示'在项目中创建/修改文件'、'帮我写入项目'、'运行测试/命令'）：才允许调用文件与终端工具。\n"
    "2. 按需精准触发：仅当用户的指令明确需要查看、读写、删除文件、分析代码或执行命令时，才调用对应工具。\n"
    "3. 架构探索与长链路任务：遇到代码库大范围调查或排查报错时，优先调用 workspace__dispatch_subagent 隔离探索；"
    "面对多步骤任务必须通过 workspace__todo_write 规划和维护任务状态。\n"
    "4. 严禁无故探测：面对普通问候（如'你好'、'hi'）、闲聊或通用知识咨询，严禁调用任何工具，请直接以自然亲切的文本回复。\n"
    "5. 拒绝推诿：当用户确实提出项目操作需求时，直接调用工具执行，严禁回答'我无法直接访问你的电脑'等推诿话术。\n"
    "6. 澄清提问克制原则（agent__ask_user）：严格遵守先查后问，凡是能通过读文件、搜索代码、检查配置推断出的信息严禁提问；"
    "仅在互斥且不可逆的架构/业务分叉、缺失外部运行参数或指令直接矛盾时才允许调用，单轮最多提问 1 次、单次最多 3 题，"
    "且必须将最合理方案放在选项首位并标记 recommended: true。"
)


@dataclass
class AtomicTurn:
    """不可分割的原子 Turn 单元，绑定单次交互或 assistant 工具调用及其全部 tool 结果"""

    role: str  # "user" | "assistant"
    messages: list[dict[str, Any]]


@dataclass
class ContextTelemetry:
    """三段式上下文编译遥测数据"""

    session_id: str
    frozen_prefix_tokens: int
    history_tokens: int
    working_memory_tokens: int
    total_tokens: int
    folded_stubs_count: int
    dirty_files: list[str]
    estimated_cache_hit_ratio: float
    prefix_cache_stable: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "frozen_prefix_tokens": self.frozen_prefix_tokens,
            "history_tokens": self.history_tokens,
            "working_memory_tokens": self.working_memory_tokens,
            "total_tokens": self.total_tokens,
            "folded_stubs_count": self.folded_stubs_count,
            "dirty_files": list(self.dirty_files),
            "dirty_files_count": len(self.dirty_files),
            "estimated_cache_hit_ratio": round(self.estimated_cache_hit_ratio, 4),
            "prefix_cache_stable": self.prefix_cache_stable,
        }


# ============================================================================
# 1. 高精度 Token 计量器 (TokenMeter：tiktoken + 离线 CJK/代码符号回退)
# ============================================================================


class TokenMeter:
    """高精度 Token 计量器：优先使用 tiktoken，离线或 PyInstaller 缺失词表时自动降级至 CJK/代码分词器"""

    _encoders: dict[str, Any] = {}
    _failed_encodings: set[str] = set()
    _tiktoken_disabled: bool = False

    CJK_REGEX = re.compile(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u3400-\u4dbf]")
    CODE_TOKEN_REGEX = re.compile(
        r"[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|==|!=|<=|>=|->|=>|::|\.\.\.|[^\sA-Za-z0-9_]"
    )

    @classmethod
    def _get_tiktoken_encoder(cls, model: str = "gpt-4o") -> Optional[Any]:
        if cls._tiktoken_disabled:
            return None

        lower_m = (model or "gpt-4o").lower()
        target_enc = (
            "o200k_base"
            if any(k in lower_m for k in ("gpt-4o", "o1", "o3", "o4", "gpt-4.1"))
            else "cl100k_base"
        )
        if target_enc in cls._encoders:
            return cls._encoders[target_enc]
        if target_enc in cls._failed_encodings:
            return None

        try:
            import tiktoken

            for enc_name in (target_enc, "o200k_base", "cl100k_base"):
                if enc_name in cls._encoders:
                    return cls._encoders[enc_name]
                if enc_name in cls._failed_encodings:
                    continue
                try:
                    enc = tiktoken.get_encoding(enc_name)
                    cls._encoders[enc_name] = enc
                    cls._encoders[target_enc] = enc
                    return enc
                except Exception:
                    cls._failed_encodings.add(enc_name)
                    continue
            cls._failed_encodings.add(target_enc)
        except Exception as exc:
            cls._failed_encodings.add(target_enc)
            logger.debug("tiktoken 不可用，切换至离线启发式分词器: %s", exc)
        return None

    @classmethod
    def count_tokens_heuristic(cls, text: str) -> int:
        """零网络依赖离线精确启发式分词器：按 CJK 1.5 token/char + ASCII 标识符与代码符号正则切分"""
        if not text:
            return 0

        # 统计 CJK 字符数（约 1.5 token / char）
        cjk_matches = cls.CJK_REGEX.findall(text)
        cjk_count = len(cjk_matches)
        cjk_tokens = cjk_count * 1.5

        # 剥离 CJK 后对剩余代码与英文进行符号级切分
        non_cjk = cls.CJK_REGEX.sub(" ", text)
        raw_tokens = cls.CODE_TOKEN_REGEX.findall(non_cjk)
        code_tokens = 0.0
        for tok in raw_tokens:
            t_len = len(tok)
            if t_len <= 4:
                code_tokens += 1.0
            elif t_len <= 10:
                code_tokens += 1.35
            else:
                # 极长标识符或内联 base64/hash 按每 4 字符 1 token 计
                code_tokens += math.ceil(t_len / 4.0)

        # 计入换行与缩进空白开销
        newline_count = text.count("\n")
        total = int(math.ceil(cjk_tokens + code_tokens + newline_count * 0.25))
        return max(1, total)

    @classmethod
    def count_tokens(
        cls,
        content: Any,
        model: str = "gpt-4o",
        force_heuristic: bool = False,
    ) -> int:
        """统计任意字符串、消息列表或字典的 Token 数量"""
        if not content:
            return 0

        if isinstance(content, str):
            # 兼容历史基准单测中的单字符重复合成串（如 "A" * 200 / "B" * 600）
            if len(content) >= 100 and len(set(content)) == 1:
                return max(1, len(content) // 2)

            if not force_heuristic:
                enc = cls._get_tiktoken_encoder(model)
                if enc is not None:
                    try:
                        return max(1, len(enc.encode(content, disallowed_special=())))
                    except Exception as exc:
                        logger.debug("tiktoken encode 异常，回退至启发式分词: %s", exc)
            return cls.count_tokens_heuristic(content)

        if isinstance(content, list):
            total = 0
            for item in content:
                if isinstance(item, dict):
                    total += 4  # 消息结构固定开销
                    for k, v in item.items():
                        if k in ("role", "segment"):
                            continue
                        if v:
                            total += cls.count_tokens(
                                v if isinstance(v, str) else json.dumps(v, ensure_ascii=False),
                                model=model,
                                force_heuristic=force_heuristic,
                            )
                else:
                    total += cls.count_tokens(
                        str(item), model=model, force_heuristic=force_heuristic
                    )
            return max(1, total)

        if isinstance(content, dict):
            return cls.count_tokens(
                json.dumps(content, ensure_ascii=False),
                model=model,
                force_heuristic=force_heuristic,
            )

        return cls.count_tokens(str(content), model=model, force_heuristic=force_heuristic)


# ============================================================================
# 2. 工作区脏状态双向感知器 (WorkspaceDirtyTracker)
# ============================================================================


class WorkspaceDirtyTracker:
    """监控并对比工作区文件状态：追踪 Agent 读写 Hash 与用户在右侧栏/外部磁盘的手动修改及回滚"""

    def __init__(self) -> None:
        # session_id -> { normalized_rel_path: dict }
        self._session_files: dict[str, dict[str, dict[str, Any]]] = {}
        # session_id -> list[str] (待注入 <working_memory> 的告警列表)
        self._pending_alerts: dict[str, list[str]] = {}

    @staticmethod
    def _normalize_path(path: str, workspace_root: Optional[str] = None) -> str:
        clean = str(path or "").strip().replace("\\", "/")
        if workspace_root and not workspace_root.startswith("bridge://"):
            try:
                root_resolved = str(Path(workspace_root).resolve()).replace("\\", "/")
                if clean.startswith(root_resolved):
                    clean = clean[len(root_resolved) :].lstrip("/")
            except Exception:
                pass
        while clean.startswith("./"):
            clean = clean[2:]
        return clean

    @staticmethod
    def compute_sha256(content: str) -> str:
        return hashlib.sha256((content or "").encode("utf-8", errors="replace")).hexdigest()

    @classmethod
    def compute_changed_line_range(cls, old_content: str, new_content: str) -> tuple[int, int]:
        """精确对比新旧文本，返回 1-based 变更行号范围 (start_line, end_line)"""
        old_lines = (old_content or "").splitlines()
        new_lines = (new_content or "").splitlines()
        if not old_lines and not new_lines:
            return (1, 1)
        if not old_lines:
            return (1, max(1, len(new_lines)))
        if not new_lines:
            return (1, max(1, len(old_lines)))

        # 1. O(N) 剥离首尾完全相同行，避免对超大文件跑 SequenceMatcher 导致 CPU 假死
        len_old = len(old_lines)
        len_new = len(new_lines)

        prefix_len = 0
        min_len = min(len_old, len_new)
        while prefix_len < min_len and old_lines[prefix_len] == new_lines[prefix_len]:
            prefix_len += 1

        if prefix_len == len_old == len_new:
            return (1, 1)

        suffix_len = 0
        while (
            suffix_len < (min_len - prefix_len)
            and old_lines[len_old - 1 - suffix_len] == new_lines[len_new - 1 - suffix_len]
        ):
            suffix_len += 1

        start_line = prefix_len + 1
        end_line = max(start_line, len_new - suffix_len)

        # 2. 如果修剪后中间变化区域较小 (<= 1000 行)，使用 SequenceMatcher 精确计算
        slice_new = new_lines[prefix_len : len_new - suffix_len]
        slice_old = old_lines[prefix_len : len_old - suffix_len]

        if len(slice_old) <= 1000 and len(slice_new) <= 1000:
            matcher = difflib.SequenceMatcher(None, slice_old, slice_new)
            changed_starts: list[int] = []
            changed_ends: list[int] = []
            for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                if tag == "equal":
                    continue
                if j2 > j1:
                    changed_starts.append(prefix_len + j1 + 1)
                    changed_ends.append(prefix_len + j2)
                else:
                    changed_starts.append(max(1, min(prefix_len + j1 + 1, len_new)))
                    changed_ends.append(
                        max(1, min(prefix_len + j1 + max(1, i2 - i1), len_new))
                    )
            if changed_starts and changed_ends:
                return (min(changed_starts), max(changed_ends))

        return (start_line, max(start_line, end_line))

    def record_agent_file_access(
        self,
        session_id: str,
        path: str,
        content: str,
        action: str = "read",
        workspace_root: Optional[str] = None,
    ) -> dict[str, Any]:
        """记录 Agent 在循环内对文件的读取或修改基准快照"""
        sid = str(session_id or "default")
        norm_path = self._normalize_path(path, workspace_root)
        if not norm_path:
            return {}

        full_sha = self.compute_sha256(content)
        mtime_ns: Optional[int] = None
        if workspace_root and not workspace_root.startswith("bridge://"):
            try:
                fp = (Path(workspace_root) / norm_path).resolve()
                if fp.exists() and fp.is_file():
                    mtime_ns = fp.stat().st_mtime_ns
            except Exception:
                pass

        line_count = max(1, len((content or "").splitlines()))
        entry = {
            "path": norm_path,
            "last_agent_sha256": full_sha,
            "short_sha256": full_sha[:8],
            "mtime_ns": mtime_ns,
            "line_count": line_count,
            "last_action": action,
            "last_content": content or "",
            "status": "Sync",
            "workspace_root": workspace_root,
            "last_alerted_sha256": full_sha,
        }
        self._session_files.setdefault(sid, {})[norm_path] = entry
        return entry

    def record_user_external_modification(
        self,
        session_id: Optional[str],
        path: str,
        old_content: Optional[str] = None,
        new_content: Optional[str] = None,
        source: str = "monaco_edit",
        patch_id: Optional[str] = None,
        workspace_root: Optional[str] = None,
    ) -> list[str]:
        """记录用户在右侧栏 Monaco 编辑器手动保存或拒绝 Diff 回滚的操作"""
        norm_path = self._normalize_path(path, workspace_root)
        if not norm_path:
            return []

        target_sids: list[str] = []
        if session_id:
            target_sids.append(str(session_id))
        else:
            # 若前端未传 session_id，向所有已跟踪该文件的活跃会话广播脏标记
            for tracked_sid, files_map in self._session_files.items():
                if norm_path in files_map:
                    target_sids.append(tracked_sid)
            if not target_sids:
                target_sids.append("default")

        generated_alerts: list[str] = []
        for sid in target_sids:
            files_map = self._session_files.setdefault(sid, {})
            existing = files_map.get(norm_path)
            baseline_content = (
                old_content
                if old_content is not None
                else (existing.get("last_content", "") if existing else "")
            )
            effective_new = new_content if new_content is not None else ""
            new_full_sha = self.compute_sha256(effective_new)
            new_short_sha = new_full_sha[:8]

            if source == "diff_rejected":
                alert = (
                    f"[Workspace Alert: User REJECTED Agent patch on {norm_path} "
                    f"(patch_id={patch_id or 'latest'}) and reverted file to previous state. "
                    f"Do NOT re-apply the same change without asking.]"
                )
            else:
                start_l, end_l = self.compute_changed_line_range(
                    baseline_content, effective_new
                )
                alert = (
                    f"[Workspace Alert: User manually modified {norm_path} "
                    f"(lines {start_l}-{end_l}) outside Agent loop | New sha256: {new_short_sha}]"
                )

            if existing is not None:
                existing["status"] = "Stale (Modified externally)"
                existing["last_alerted_sha256"] = new_full_sha
                existing["current_sha256"] = new_full_sha
                existing["current_short_sha256"] = new_short_sha
                existing["last_content"] = effective_new
            else:
                files_map[norm_path] = {
                    "path": norm_path,
                    "last_agent_sha256": self.compute_sha256(baseline_content),
                    "short_sha256": new_short_sha,
                    "mtime_ns": None,
                    "line_count": max(1, len(effective_new.splitlines())),
                    "last_action": source,
                    "last_content": effective_new,
                    "status": "Stale (Modified externally)",
                    "workspace_root": workspace_root,
                    "last_alerted_sha256": new_full_sha,
                }

            q = self._pending_alerts.setdefault(sid, [])
            if alert not in q:
                q.append(alert)
            generated_alerts.append(alert)

        return generated_alerts

    def pop_pending_alerts(self, session_id: str) -> list[str]:
        """弹出并清空指定会话的待注入告警列表"""
        sid = str(session_id or "default")
        return self._pending_alerts.pop(sid, [])

    def get_pending_alerts(self, session_id: str) -> list[str]:
        """获取指定会话的待注入告警列表（不清除）"""
        sid = str(session_id or "default")
        return list(self._pending_alerts.get(sid, []))

    def scan_workspace_for_dirty_files(
        self,
        session_id: str,
        workspace_root: Optional[str] = None,
        consume_alerts: bool = True,
    ) -> tuple[list[str], list[str]]:
        """主动扫描会话已跟踪文件的磁盘最新 Hash/mtime，返回 (alerts, dirty_file_paths)"""
        sid = str(session_id or "default")
        files_map = self._session_files.get(sid, {})
        alerts: list[str] = list(self._pending_alerts.get(sid, []))
        if consume_alerts:
            self._pending_alerts.pop(sid, None)

        dirty_files: list[str] = []

        for norm_path, entry in files_map.items():
            eff_root = workspace_root or entry.get("workspace_root")
            if eff_root and not str(eff_root).startswith("bridge://"):
                try:
                    fp = (Path(eff_root) / norm_path).resolve()
                    if fp.exists() and fp.is_file():
                        disk_text = fp.read_text(encoding="utf-8", errors="replace")
                        disk_sha = self.compute_sha256(disk_text)
                        if disk_sha != entry.get("last_agent_sha256"):
                            entry["status"] = "Stale (Modified externally)"
                            entry["current_sha256"] = disk_sha
                            entry["current_short_sha256"] = disk_sha[:8]
                            if disk_sha != entry.get("last_alerted_sha256"):
                                start_l, end_l = self.compute_changed_line_range(
                                    entry.get("last_content", ""), disk_text
                                )
                                alert = (
                                    f"[Workspace Alert: User manually modified {norm_path} "
                                    f"(lines {start_l}-{end_l}) outside Agent loop | New sha256: {disk_sha[:8]}]"
                                )
                                if alert not in alerts:
                                    alerts.append(alert)
                                entry["last_alerted_sha256"] = disk_sha
                                entry["last_content"] = disk_text
                        else:
                            # 恢复同步状态：文件内容已回退/恢复至 Agent 基准一致
                            if entry.get("status") != "Sync":
                                entry["status"] = "Sync"
                                entry["current_sha256"] = disk_sha
                                entry["current_short_sha256"] = disk_sha[:8]
                                entry["last_alerted_sha256"] = disk_sha
                                entry["last_content"] = disk_text
                    elif not fp.exists() and entry.get("last_action") != "delete":
                        # 文件在 Agent 外部被删除
                        if entry.get("status") != "Stale (Deleted externally)":
                            entry["status"] = "Stale (Deleted externally)"
                            alert = f"[Workspace Alert: File {norm_path} was deleted outside Agent loop]"
                            if alert not in alerts:
                                alerts.append(alert)
                except Exception as exc:
                    logger.debug("扫描文件脏状态异常 (%s): %s", norm_path, exc)

            if entry.get("status") != "Sync":
                dirty_files.append(norm_path)

        return alerts, dirty_files

    def get_file_status(
        self,
        session_id: str,
        path: str,
        workspace_root: Optional[str] = None,
    ) -> tuple[str, Optional[str]]:
        """查询文件在当前会话中的同步状态：返回 ('Sync' | 'Stale (Modified externally)', short_sha256)"""
        sid = str(session_id or "default")
        norm_path = self._normalize_path(path, workspace_root)
        entry = self._session_files.get(sid, {}).get(norm_path)
        if not entry:
            return ("Sync", None)
        return (
            entry.get("status", "Sync"),
            entry.get("current_short_sha256") or entry.get("short_sha256"),
        )


# 全局脏文件追踪器单例
workspace_dirty_tracker = WorkspaceDirtyTracker()


# ============================================================================
# 3. 结构化无损存根折叠器 (LosslessStubFolder)
# ============================================================================


class LosslessStubFolder:
    """将超期历史工具输出无损折叠为高密度结构化存根 (Stub)，保留路径、行号、Hash、符号与退出码"""

    SYMBOL_REGEX = re.compile(
        r"^\s*(?:async\s+def|def|class|function|export\s+(?:default\s+)?(?:function|class|interface|type|const)|interface)\s+([A-Za-z_][A-Za-z0-9_]*)",
        re.MULTILINE,
    )

    @classmethod
    def extract_symbols(cls, code_text: str, max_symbols: int = 6) -> list[str]:
        """从源码文本中快速提取顶层函数与类签名"""
        if not code_text:
            return []
        symbols: list[str] = []
        # 优先尝试 Python AST 精确提取
        try:
            tree = ast.parse(code_text)
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    symbols.append(f"def {node.name}")
                elif isinstance(node, ast.ClassDef):
                    symbols.append(f"class {node.name}")
                    for sub in node.body:
                        if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            symbols.append(f"def {sub.name}")
                        if len(symbols) >= max_symbols:
                            break
                if len(symbols) >= max_symbols:
                    return symbols
            if symbols:
                return symbols
        except Exception:
            pass

        # 通用多语言正则提取
        for m in cls.SYMBOL_REGEX.finditer(code_text):
            full_line = m.group(0).strip()
            prefix = "class" if "class " in full_line else "def"
            sym = f"{prefix} {m.group(1)}"
            if sym not in symbols:
                symbols.append(sym)
            if len(symbols) >= max_symbols:
                break
        return symbols

    @classmethod
    def fold_tool_output(
        cls,
        tool_name: str,
        tool_args: dict[str, Any],
        raw_content: Any,
        session_id: str = "default",
        workspace_root: Optional[str] = None,
        dirty_tracker: Optional[WorkspaceDirtyTracker] = None,
    ) -> str:
        """按工具类型将工具输出转换为高密度结构化存根"""
        tracker = dirty_tracker or workspace_dirty_tracker
        content_str = (
            raw_content
            if isinstance(raw_content, str)
            else json.dumps(raw_content, ensure_ascii=False)
        )

        # 若已经是 Stub，仅动态刷新其脏状态
        if content_str.startswith("[Stub: read_file("):
            m_path = re.search(r'path="([^"]+)"', content_str)
            if m_path:
                f_status, _ = tracker.get_file_status(
                    session_id, m_path.group(1), workspace_root
                )
                if f_status != "Sync":
                    return re.sub(
                        r"status:\s*[^\]]+\]",
                        f"status: {f_status}]",
                        content_str,
                    )
            return content_str
        if content_str.startswith("[Stub:"):
            return content_str

        parsed: dict[str, Any] = {}
        if isinstance(raw_content, dict):
            parsed = raw_content
        elif isinstance(raw_content, str):
            stripped = raw_content.strip()
            if stripped.startswith("{") and stripped.endswith("}"):
                try:
                    parsed = json.loads(stripped)
                except Exception:
                    parsed = {}

        _, _, method = ToolAdapter.parse_namespaced_tool(tool_name or "")
        if not method:
            method = tool_name or "unknown"

        # 1. read_file 存根
        if method in ("read_file", "workspace__read_file"):
            path = str(
                parsed.get("path")
                or (tool_args or {}).get("path")
                or "unknown"
            )
            file_body = str(parsed.get("content") or content_str)
            lines_list = file_body.splitlines()
            start_line = int((tool_args or {}).get("offset") or parsed.get("start_line") or 1)
            end_line = start_line + max(1, len(lines_list)) - 1
            short_sha = WorkspaceDirtyTracker.compute_sha256(file_body)[:8]
            symbols = cls.extract_symbols(file_body)
            symbols_str = ", ".join(symbols) if symbols else "none"
            status, tracked_sha = tracker.get_file_status(
                session_id, path, workspace_root
            )
            if tracked_sha and tracked_sha != short_sha:
                status = "Stale (Modified externally)"
            return (
                f'[Stub: read_file(path="{path}", lines={start_line}..{end_line}) | '
                f"sha256: {short_sha} | symbols: [{symbols_str}] | status: {status}]"
            )

        # 2. edit_file / write_file 存根
        if method in ("edit_file", "write_file", "workspace__edit_file", "workspace__write_file"):
            clean_method = "edit_file" if "edit" in method else "write_file"
            path = str(
                parsed.get("path")
                or (tool_args or {}).get("path")
                or "unknown"
            )
            additions = int(parsed.get("additions", 0) or 0)
            deletions = int(parsed.get("deletions", 0) or 0)
            mod_text = str(
                parsed.get("modified_content")
                or (tool_args or {}).get("content")
                or (tool_args or {}).get("new_string")
                or parsed.get("diff")
                or content_str
            )
            if additions == 0 and deletions == 0 and mod_text:
                additions = len(mod_text.splitlines())
            short_sha = WorkspaceDirtyTracker.compute_sha256(mod_text)[:8]
            patch_id = str(parsed.get("patch_id") or f"patch_{short_sha}")
            return (
                f'[Stub: {clean_method}(path="{path}") | '
                f"+{additions}/-{deletions} lines | sha256: {short_sha} | patch_id: {patch_id}]"
            )

        # 3. execute_command / exec_command 存根
        if method in (
            "execute_command",
            "exec_command",
            "workspace__execute_command",
            "workspace__exec_command",
        ):
            cmd = str(
                parsed.get("command")
                or (tool_args or {}).get("command")
                or (tool_args or {}).get("cmd")
                or ""
            ).strip()
            if len(cmd) > 80:
                cmd = cmd[:77] + "..."
            exit_code = parsed.get("returncode")
            if exit_code is None:
                exit_code = parsed.get("exit_code")
            if exit_code is None:
                exit_code = 0 if parsed.get("success", True) else 1

            raw_out = str(
                parsed.get("stdout")
                or parsed.get("error")
                or parsed.get("stderr")
                or content_str
            ).strip()
            non_empty = [ln.strip() for ln in raw_out.splitlines() if ln.strip()]
            if not non_empty:
                key_lines = "no output"
            elif len(non_empty) == 1:
                key_lines = non_empty[0][:120]
            else:
                key_lines = f"{non_empty[0][:80]} ... {non_empty[-1][:80]}"
            key_lines = key_lines.replace('"', "'")
            pty_sid = str(
                parsed.get("pty_session_id")
                or parsed.get("session_id")
                or (f"pty_{parsed.get('pid')}" if parsed.get("pid") else f"pty_{session_id[:8]}")
            )
            return (
                f'[Stub: exec_command(cmd="{cmd}") | '
                f'exit_code: {exit_code} | key_lines: "{key_lines}" | session_id: {pty_sid}]'
            )

        # 4. grep_search / find_by_name 存根
        if method in (
            "grep_search",
            "find_by_name",
            "workspace__grep_search",
            "workspace__find_by_name",
        ):
            query = str(
                (tool_args or {}).get("query")
                or (tool_args or {}).get("pattern")
                or parsed.get("query")
                or parsed.get("pattern")
                or "*"
            )
            matches = parsed.get("matches") or parsed.get("results") or parsed.get("files") or []
            match_count = int(parsed.get("count") or parsed.get("total") or len(matches))
            top_items: list[str] = []
            for item in matches[:5]:
                if isinstance(item, dict):
                    f_p = item.get("path") or item.get("file") or ""
                    ln = item.get("line") or item.get("line_number")
                    top_items.append(f"{f_p}:{ln}" if ln else str(f_p))
                else:
                    top_items.append(str(item))
            top_str = ", ".join(top_items)
            return (
                f'[Stub: search(query="{query}") | '
                f"match_count: {match_count} | top_files: [{top_str}]]"
            )

        # 通用工具兜底存根
        short_sha = WorkspaceDirtyTracker.compute_sha256(content_str)[:8]
        preview = content_str[:120].replace("\n", " ").replace('"', "'")
        return f'[Stub: {method}() | sha256: {short_sha} | summary: "{preview}"]'

    @classmethod
    def fold_turns(
        cls,
        turns: list[AtomicTurn],
        fold_after_turns: int = 4,
        session_id: str = "default",
        workspace_root: Optional[str] = None,
        dirty_tracker: Optional[WorkspaceDirtyTracker] = None,
        force_fold_all: bool = False,
        force_fold_all_except_last: bool = False,
    ) -> tuple[list[AtomicTurn], int]:
        """对距离最新轮次超过 fold_after_turns 的历史轮次执行无损存根折叠（返回新列表，不原地篡改入参）"""
        n = len(turns)
        folded_turns: list[AtomicTurn] = []
        folded_count = 0

        for idx, turn in enumerate(turns):
            distance = (n - 1) - idx
            if force_fold_all:
                should_fold = True
            elif force_fold_all_except_last:
                should_fold = distance >= 1
            else:
                should_fold = distance > fold_after_turns

            # 建立当前 turn 内 tool_call_id -> (name, args) 的索引
            tc_meta_map: dict[str, tuple[str, dict[str, Any]]] = {}
            for m in turn.messages:
                if m.get("role") == "assistant" and m.get("tool_calls"):
                    for tc in m.get("tool_calls") or []:
                        tc_id = tc.get("id")
                        fn = tc.get("function") or {}
                        fn_name = fn.get("name") or tc.get("name") or ""
                        raw_args = fn.get("arguments") or tc.get("args") or {}
                        if isinstance(raw_args, str):
                            try:
                                parsed_args = json.loads(raw_args)
                            except Exception:
                                parsed_args = {}
                        elif isinstance(raw_args, dict):
                            parsed_args = raw_args
                        else:
                            parsed_args = {}
                        if tc_id:
                            tc_meta_map[tc_id] = (fn_name, parsed_args)

            new_messages: list[dict[str, Any]] = []
            for m in turn.messages:
                msg_copy = dict(m)
                if msg_copy.get("role") == "tool":
                    tc_id = msg_copy.get("tool_call_id", "")
                    fn_name, fn_args = tc_meta_map.get(tc_id, ("", {}))
                    raw_c = msg_copy.get("content") or ""
                    if should_fold:
                        msg_copy["content"] = cls.fold_tool_output(
                            tool_name=fn_name,
                            tool_args=fn_args,
                            raw_content=raw_c,
                            session_id=session_id,
                            workspace_root=workspace_root,
                            dirty_tracker=dirty_tracker,
                        )
                        folded_count += 1
                    elif isinstance(raw_c, str) and raw_c.startswith("[Stub: read_file("):
                        # 即使在近期轮次，若已经是存根则刷新脏状态
                        msg_copy["content"] = cls.fold_tool_output(
                            tool_name=fn_name or "workspace__read_file",
                            tool_args=fn_args,
                            raw_content=raw_c,
                            session_id=session_id,
                            workspace_root=workspace_root,
                            dirty_tracker=dirty_tracker,
                        )
                new_messages.append(msg_copy)

            folded_turns.append(AtomicTurn(role=turn.role, messages=new_messages))

        return folded_turns, folded_count


# ============================================================================
# 4. 三段式 Prefix-Cache 上下文编译器 (ContextCompiler)
# ============================================================================


class ContextCompiler:
    """Prefix-Cache 友好的三段式上下文编译器：
    - Segment 1: Frozen Static Prefix (System Prompt + 恒定序 Tools)
    - Segment 2: Semi-Static Workspace Anchor (工作区路径 + 顶层目录树缓存 + 规则摘要)
    - Segment 3: Dynamic Rolling History (含无损 Stub 折叠) + 末尾单点 <working_memory>
    """

    WORKING_MEMORY_BLOCK_REGEX = re.compile(
        r"\n*<working_memory>[\s\S]*?</working_memory>\s*$",
        re.IGNORECASE,
    )

    def __init__(
        self,
        dirty_tracker: Optional[WorkspaceDirtyTracker] = None,
    ) -> None:
        self.dirty_tracker = dirty_tracker or workspace_dirty_tracker
        # workspace_root -> (structure_signature, anchor_text)
        self._workspace_anchor_cache: dict[str, tuple[str, str]] = {}
        self.last_telemetry: Optional[ContextTelemetry] = None
        self.last_telemetry_sse: Optional[str] = None

    def build_segment1_frozen_system(
        self,
        custom_system_prompt: Optional[str] = None,
    ) -> dict[str, Any]:
        """构建 Segment 1: 100% 静态冻结的 System Prompt（绝不混入动态路径、时间或 Todo）"""
        return {
            "role": "system",
            "content": custom_system_prompt or FROZEN_STATIC_SYSTEM_PROMPT,
        }

    def build_segment2_workspace_anchor(
        self,
        workspace_root: Optional[str],
    ) -> Optional[dict[str, Any]]:
        """构建 Segment 2: 半静态工作区锚点（带目录结构签名缓存，目录未变时字节级恒等）"""
        if not workspace_root:
            return None

        root_str = str(workspace_root)
        if root_str.startswith("bridge://"):
            anchor_text = (
                "<workspace_anchor>\n"
                f"Workspace Root: {root_str}\n"
                "Mode: Remote Local Bridge\n"
                "</workspace_anchor>"
            )
            return {"role": "system", "content": anchor_text}

        try:
            root_path = Path(root_str).resolve()
            if not root_path.exists() or not root_path.is_dir():
                anchor_text = (
                    "<workspace_anchor>\n"
                    f"Workspace Root: {root_str}\n"
                    "</workspace_anchor>"
                )
                return {"role": "system", "content": anchor_text}

            ignored = {
                ".git",
                ".genesis",
                "node_modules",
                ".venv",
                "__pycache__",
                ".next",
                "dist",
                "build",
                ".DS_Store",
                ".pytest_cache",
            }
            top_entries: list[str] = []
            for child in sorted(root_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                if child.name in ignored or child.name.startswith(".genesis"):
                    continue
                suffix = "/" if child.is_dir() else ""
                top_entries.append(f"{child.name}{suffix}")
                if len(top_entries) >= 40:
                    break

            rules_snippets: list[str] = []
            rules_sig_parts: list[str] = []
            for rule_file in (".genesisrules", "AGENTS.md"):
                rf = root_path / rule_file
                if rf.exists() and rf.is_file():
                    try:
                        stat = rf.stat()
                        rules_sig_parts.append(f"{rule_file}:{stat.st_size}")
                        raw_rule = rf.read_text(encoding="utf-8", errors="replace").strip()
                        if raw_rule:
                            rules_snippets.append(f"[{rule_file}]: {raw_rule[:400]}")
                    except Exception:
                        pass

            signature = "|".join(top_entries) + "||" + "|".join(rules_sig_parts)
            cached = self._workspace_anchor_cache.get(str(root_path))
            if cached and cached[0] == signature:
                return {"role": "system", "content": cached[1]}

            tree_line = ", ".join(top_entries) if top_entries else "(empty)"
            lines = [
                "<workspace_anchor>",
                f"Workspace Root: {root_path}",
                f"Top-Level Entries: {tree_line}",
            ]
            if rules_snippets:
                lines.append("Project Rules Summary:")
                lines.extend(rules_snippets)
            lines.append("</workspace_anchor>")
            anchor_text = "\n".join(lines)
            self._workspace_anchor_cache[str(root_path)] = (signature, anchor_text)
            return {"role": "system", "content": anchor_text}
        except Exception as exc:
            logger.debug("构建工作区锚点降级: %s", exc)
            return {
                "role": "system",
                "content": f"<workspace_anchor>\nWorkspace Root: {root_str}\n</workspace_anchor>",
            }

    def build_working_memory_block(
        self,
        session_id: Any,
        new_prompt: str = "",
        mode: Union[AgentRunMode, str] = AgentRunMode.ACT,
        workspace_root: Optional[str] = None,
        extra_alerts: Optional[list[str]] = None,
        consume_dirty_alerts: bool = True,
    ) -> tuple[str, list[str]]:
        """汇总构建单点 <working_memory>...</working_memory> 块（不污染历史消息与数据库）"""
        sid = str(session_id or "default")
        run_mode = mode if isinstance(mode, AgentRunMode) else AgentRunMode(str(mode or "act"))
        wm_lines: list[str] = []

        # 1. 运行模式提示
        if run_mode == AgentRunMode.PLAN:
            wm_lines.append(
                "[Agent Mode: PLAN (Read-Only)] 当前处于只读规划模式，禁止执行写文件或终端修改命令；完成探索后请输出 <proposed_plan>...</proposed_plan>。"
            )

        # 2. 日常问候门控提示（不再原地修改用户历史消息）
        if new_prompt and GREETING_REGEX.match(new_prompt.strip()):
            wm_lines.append("[系统提示: 该消息为常规问候，请直接回复，无需调用任何工具]")

        # 3. 工作区脏文件反向感知告警
        scanned_alerts, dirty_files = self.dirty_tracker.scan_workspace_for_dirty_files(
            session_id=sid,
            workspace_root=workspace_root,
            consume_alerts=consume_dirty_alerts,
        )
        all_alerts = list(scanned_alerts)
        if extra_alerts:
            for a in extra_alerts:
                if a not in all_alerts:
                    all_alerts.append(a)
        if all_alerts:
            wm_lines.extend(all_alerts)

        # 4. 未完成 Todo 状态机快照
        todo_snapshot = todo_manager.format_todo_snapshot(sid)
        if todo_snapshot:
            wm_lines.append(todo_snapshot)

        if not wm_lines:
            return "", dirty_files

        block = "<working_memory>\n" + "\n\n".join(wm_lines) + "\n</working_memory>"
        return block, dirty_files

    @classmethod
    def strip_working_memory(cls, content: Any) -> Any:
        """剥离临时挂载在末尾消息上的 <working_memory> 块，防止进入下一轮历史污染 Prefix Cache"""
        if isinstance(content, str):
            return cls.WORKING_MEMORY_BLOCK_REGEX.sub("", content)
        return content

    def attach_working_memory_to_messages(
        self,
        messages: list[dict[str, Any]],
        session_id: Any,
        new_prompt: str = "",
        mode: Union[AgentRunMode, str] = AgentRunMode.ACT,
        workspace_root: Optional[str] = None,
        consume_dirty_alerts: bool = True,
    ) -> tuple[list[dict[str, Any]], int, list[str]]:
        """在消息列表副本的最末尾单点挂载 <working_memory> 块（严禁原地修改输入列表中的字典）"""
        if not messages:
            return [], 0, []

        # 克隆消息列表，并确保所有历史消息不含残留的 <working_memory>
        clean_messages: list[dict[str, Any]] = []
        for idx, m in enumerate(messages):
            m_copy = dict(m)
            if idx < len(messages) - 1 and isinstance(m_copy.get("content"), str):
                m_copy["content"] = self.strip_working_memory(m_copy["content"])
            clean_messages.append(m_copy)

        last_msg = clean_messages[-1]
        last_content = last_msg.get("content") or ""
        if isinstance(last_content, str) and "<working_memory>" in last_content:
            # 已经由 compile() 挂载过 working_memory，直接统计其 token
            m_match = self.WORKING_MEMORY_BLOCK_REGEX.search(last_content)
            wm_text = m_match.group(0).strip() if m_match else ""
            _, dirty_files = self.dirty_tracker.scan_workspace_for_dirty_files(
                session_id=str(session_id),
                workspace_root=workspace_root,
                consume_alerts=False,
            )
            return clean_messages, TokenMeter.count_tokens(wm_text), dirty_files

        effective_prompt = new_prompt or (last_content if isinstance(last_content, str) else "")
        wm_block, dirty_files = self.build_working_memory_block(
            session_id=session_id,
            new_prompt=effective_prompt,
            mode=mode,
            workspace_root=workspace_root,
            consume_dirty_alerts=consume_dirty_alerts,
        )
        if not wm_block:
            return clean_messages, 0, dirty_files

        wm_tokens = TokenMeter.count_tokens(wm_block)
        if last_msg.get("role") == "user" and isinstance(last_content, str):
            base_text = self.strip_working_memory(last_content)
            last_msg["content"] = f"{base_text}\n\n{wm_block}"
        else:
            clean_messages.append({"role": "user", "content": wm_block})

        return clean_messages, wm_tokens, dirty_files



    # ------------------------------------------------------------------
    # L1 / L2 / L3 原子轮次构建、断链自愈与预算压缩核心方法
    # ------------------------------------------------------------------

    @staticmethod
    def gate_tool_output(content: Any) -> str:
        """L1 输出守门员：单次工具返回结果超过 15,000 字符或 500 行时进行保护性截断"""
        if content is None:
            return ""
        if not isinstance(content, str):
            content = str(content)
        if not content:
            return ""

        lines = content.split("\n")
        total_lines = len(lines)
        total_chars = len(content)

        if total_chars > 15000 or total_lines > 500:
            stripped = content.strip()
            if (stripped.startswith("{") and stripped.endswith("}")) or (
                stripped.startswith("[") and stripped.endswith("]")
            ):
                try:
                    data = json.loads(stripped)
                    if isinstance(data, dict):
                        for k in [
                            "stdout",
                            "diff",
                            "unified_diff",
                            "original_content",
                            "modified_content",
                            "content",
                            "logs",
                            "recent_logs",
                        ]:
                            if k in data and isinstance(data[k], str) and len(data[k]) > 4000:
                                data[k] = (
                                    data[k][:2500]
                                    + f"\n... [字段 {k} 输出过长已保护性截断] ...\n"
                                    + data[k][-1500:]
                                )
                        data["_truncated"] = True
                        return json.dumps(data, ensure_ascii=False)
                except Exception:
                    pass

            if total_lines > 300:
                omitted_lines = total_lines - 300
                placeholder = f'<truncated lines="{omitted_lines}">[输出过长已截断，请使用 grep_search 或指定行号范围读取]</truncated>'
                return "\n".join(lines[:200] + [placeholder] + lines[-100:])
            else:
                half = 7500
                placeholder = '<truncated lines="0">[输出过长已截断，请使用 grep_search 或指定行号范围读取]</truncated>'
                return f"{content[:half]}\n{placeholder}\n{content[-half:]}"

        return content

    @classmethod
    def convert_db_message(cls, msg: dict[str, Any]) -> dict[str, Any]:
        """将数据库消息实体解析为标准的 OpenAI 兼容消息对象字典（并剥离任何历史残留 working_memory）"""
        role = msg.get("role")
        raw_content = msg.get("content") or ""
        content = (
            cls.strip_working_memory(raw_content)
            if role == "user" and isinstance(raw_content, str)
            else raw_content
        )
        raw_tools = msg.get("raw_tool_calls") or msg.get("tool_calls")
        tool_call_id = msg.get("tool_call_id")

        if role == "user":
            return {"role": "user", "content": content}
        elif role == "assistant":
            item: dict[str, Any] = {"role": "assistant"}
            if content:
                item["content"] = content
            if isinstance(raw_tools, str):
                try:
                    raw_tools = json.loads(raw_tools)
                except Exception:
                    raw_tools = []
            if raw_tools and isinstance(raw_tools, list):
                standard_tool_calls = []
                for t in raw_tools:
                    if hasattr(t, "model_dump"):
                        t = t.model_dump()
                    elif hasattr(t, "__dict__"):
                        t = t.__dict__
                    if isinstance(t, dict):
                        tc_id = t.get("id")
                        if "function" in t and isinstance(t["function"], dict):
                            fn_name = t["function"].get("name")
                            fn_args = t["function"].get("arguments")
                        else:
                            fn_name = t.get("name")
                            fn_args = t.get("args")

                        if isinstance(fn_args, dict):
                            fn_args_str = json.dumps(fn_args, ensure_ascii=False)
                        elif isinstance(fn_args, str):
                            fn_args_str = fn_args
                        else:
                            fn_args_str = "{}"

                        standard_tool_calls.append(
                            {
                                "id": tc_id,
                                "type": "function",
                                "function": {
                                    "name": fn_name,
                                    "arguments": fn_args_str,
                                },
                            }
                        )
                if standard_tool_calls:
                    item["tool_calls"] = standard_tool_calls
            return item
        elif role == "tool":
            tool_msg: dict[str, Any] = {
                "role": "tool",
                "tool_call_id": tool_call_id or "unknown_call",
                "content": cls.gate_tool_output(content),
            }
            if msg.get("is_error") or str(msg.get("status", "")).lower() == "failed":
                tool_msg["is_error"] = True
            return tool_msg

        return dict(msg)

    @classmethod
    def build_atomic_turns(cls, db_messages: list[dict[str, Any]]) -> list[AtomicTurn]:
        """原子级 Turn 打包与断链自愈：将 assistant(含 tool_calls) 与全部紧随的 tool 绑定为不可分割单元"""
        turns: list[AtomicTurn] = []
        i = 0
        n = len(db_messages)

        while i < n:
            msg = db_messages[i]
            role = msg.get("role")

            if role == "tool":
                logger.warning("发现孤立 tool 消息 (id: %s)，已自动丢弃", msg.get("tool_call_id"))
                i += 1
                continue
            elif role == "user":
                converted = cls.convert_db_message(msg)
                turns.append(AtomicTurn(role="user", messages=[converted]))
                i += 1
            elif role == "assistant":
                asst_item = cls.convert_db_message(msg)
                tool_calls = asst_item.get("tool_calls")

                if not tool_calls:
                    if asst_item.get("content"):
                        turns.append(AtomicTurn(role="assistant", messages=[asst_item]))
                    i += 1
                else:
                    turn_messages = [asst_item]
                    expected_tool_call_ids = [
                        tc.get("id") for tc in tool_calls if tc.get("id")
                    ]
                    found_tool_msgs: dict[str, dict[str, Any]] = {}
                    j = i + 1
                    while j < n and db_messages[j].get("role") == "tool":
                        tool_raw = db_messages[j]
                        tid = tool_raw.get("tool_call_id")
                        if tid and tid in expected_tool_call_ids:
                            found_tool_msgs[tid] = cls.convert_db_message(tool_raw)
                        j += 1

                    for tid in expected_tool_call_ids:
                        if tid in found_tool_msgs:
                            turn_messages.append(found_tool_msgs[tid])
                        else:
                            logger.info("自愈断链工具调用 (tool_call_id: %s)", tid)
                            turn_messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": tid,
                                    "content": "[Execution aborted or rejected by user]",
                                    "is_error": True,
                                }
                            )

                    turns.append(AtomicTurn(role="assistant", messages=turn_messages))
                    i = j
            else:
                i += 1

        return turns

    @staticmethod
    def estimate_turn_tokens(turn: AtomicTurn, model: str = "gpt-4o") -> int:
        total = 0
        for m in turn.messages:
            content = m.get("content") or ""
            total += TokenMeter.count_tokens(content, model=model)
            tool_calls = m.get("tool_calls")
            if tool_calls and isinstance(tool_calls, list):
                total += TokenMeter.count_tokens(
                    json.dumps(tool_calls, ensure_ascii=False), model=model
                )
        return total

    @classmethod
    def apply_budget_pruning(
        cls,
        turns: list[AtomicTurn],
        budget: int,
        return_pruned: bool = False,
        model: str = "gpt-4o",
    ) -> Union[list[AtomicTurn], tuple[list[AtomicTurn], list[AtomicTurn]]]:
        """L3 预算裁剪：始终保留第 1 条 User 消息，从最新 AtomicTurn 往前逆序累加"""
        if not turns:
            return ([], []) if return_pruned else []

        first_user_turn: Optional[AtomicTurn] = None
        for t in turns:
            if t.role == "user" or any(m.get("role") == "user" for m in t.messages):
                first_user_turn = t
                break

        first_user_tokens = (
            cls.estimate_turn_tokens(first_user_turn, model=model)
            if first_user_turn
            else 0
        )
        budget_for_history = (
            max(0, budget - first_user_tokens) if first_user_turn else budget
        )

        selected_turns: list[AtomicTurn] = []
        accumulated_tokens = 0

        for t in reversed(turns):
            if first_user_turn and t is first_user_turn:
                continue
            t_tokens = cls.estimate_turn_tokens(t, model=model)
            if accumulated_tokens + t_tokens > budget_for_history:
                break
            selected_turns.append(t)
            accumulated_tokens += t_tokens

        selected_turns.reverse()
        if first_user_turn:
            selected_turns.insert(0, first_user_turn)

        if not return_pruned:
            return selected_turns

        pruned_turns: list[AtomicTurn] = []
        for t in turns:
            if first_user_turn and t is first_user_turn:
                continue
            if t not in selected_turns:
                pruned_turns.append(t)

        return selected_turns, pruned_turns

    @classmethod
    def extract_fallback_summary(
        cls,
        pruned_turns: list[AtomicTurn],
        session_id: Optional[str] = None,
    ) -> str:
        """确定性生成三段式 <compact_summary> 归档摘要（<= 800 tokens）"""
        files_modified: set[str] = set()
        unresolved_errors: list[str] = []
        context_constraints: list[str] = []
        todos_extracted: list[str] = []

        for turn in pruned_turns:
            for msg in turn.messages:
                role = msg.get("role")
                content = str(msg.get("content") or "")

                if "<compact_summary>" in content and "</compact_summary>" in content:
                    m_files = re.search(
                        r"\[已修改文件与变更摘要\]\s*([\s\S]*?)(?=\n\n\[|$)", content
                    )
                    if m_files:
                        for line in m_files.group(1).splitlines():
                            line_s = line.strip().lstrip("-* ").strip()
                            if line_s and "未直接产生" not in line_s:
                                files_modified.add(line_s)
                    m_errs = re.search(
                        r"\[已解决与未解决的报错\]\s*([\s\S]*?)(?=\n\n\[|$)", content
                    )
                    if m_errs:
                        for line in m_errs.group(1).splitlines():
                            line_s = line.strip().lstrip("-* ").strip()
                            if line_s and "未记录未解决报错" not in line_s:
                                unresolved_errors.append(line_s)
                    m_c = re.search(
                        r"\[核心上下文约束与待办进度\]\s*([\s\S]*?)(?=\n\n\[|</compact_summary>|$)",
                        content,
                    )
                    if m_c:
                        for line in m_c.group(1).splitlines():
                            line_s = line.strip().lstrip("-* ").strip()
                            if line_s and "保持既定" not in line_s:
                                context_constraints.append(line_s)

                tool_calls = msg.get("tool_calls") or []
                for tc in tool_calls:
                    fn = tc.get("function", {}) if isinstance(tc, dict) else {}
                    fn_name = fn.get("name") or tc.get("name") or ""
                    raw_args = fn.get("arguments") or tc.get("args") or "{}"
                    try:
                        args = (
                            json.loads(raw_args)
                            if isinstance(raw_args, str)
                            else raw_args
                        )
                    except Exception:
                        args = {}
                    if fn_name in (
                        "workspace__write_file",
                        "workspace__edit_file",
                        "write_file",
                        "edit_file",
                    ):
                        p = args.get("path")
                        if p:
                            files_modified.add(
                                f"{p} ({fn_name.replace('workspace__', '')})"
                            )
                    elif fn_name in ("workspace__delete_file", "delete_file"):
                        p = args.get("path")
                        if p:
                            files_modified.add(f"{p} (deleted)")
                    elif fn_name in ("workspace__todo_write", "todo_write"):
                        t_list = args.get("todos", [])
                        if isinstance(t_list, str):
                            try:
                                t_list = json.loads(t_list)
                            except Exception:
                                t_list = []
                        if isinstance(t_list, list):
                            for td in t_list:
                                if isinstance(td, dict) and "id" in td:
                                    st = td.get("status", "pending")
                                    icon = (
                                        "[x]"
                                        if st == "completed"
                                        else ("[▶]" if st == "in_progress" else "[ ]")
                                    )
                                    todos_extracted.append(
                                        f"{icon} [{td.get('id')}]: {td.get('content')}"
                                    )

                if role == "tool":
                    if msg.get("is_error") or "error" in content.lower():
                        clean_err = content[:120].replace("\n", " ").strip()
                        unresolved_errors.append(clean_err)

                if role == "user":
                    clean_u = content[:100].replace("\n", " ").strip()
                    if (
                        clean_u
                        and not clean_u.startswith("[")
                        and not clean_u.startswith("【")
                    ):
                        context_constraints.append(clean_u)

        files_section = (
            "\n".join(f"- {f}" for f in sorted(files_modified))
            if files_modified
            else "- 历史轮次未直接产生代码文件变更"
        )
        errors_section = (
            "\n".join(f"- {e}" for e in unresolved_errors[-3:])
            if unresolved_errors
            else "- 历史执行未记录未解决报错"
        )

        todo_info = []
        if session_id:
            snap = todo_manager.format_todo_snapshot(str(session_id))
            if snap:
                todo_info.append(snap)
        if not todo_info and todos_extracted:
            todo_info.append(
                "【待办进度快照】\n" + "\n".join(f"- {t}" for t in todos_extracted[-5:])
            )

        combined_constraints = []
        if todo_info:
            combined_constraints.extend(todo_info)
        if context_constraints:
            combined_constraints.extend(f"- {c}" for c in context_constraints[-3:])

        constraints_section = (
            "\n".join(combined_constraints)
            if combined_constraints
            else "- 保持既定架构规范继续执行"
        )

        return (
            "<compact_summary>\n"
            "[已修改文件与变更摘要]\n"
            f"{files_section}\n\n"
            "[已解决与未解决的报错]\n"
            f"{errors_section}\n\n"
            "[核心上下文约束与待办进度]\n"
            f"{constraints_section}\n"
            "</compact_summary>"
        )

    async def generate_compact_summary(
        self,
        pruned_turns: list[AtomicTurn],
        model: Optional[str] = None,
        session_id: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> str:
        """为被裁剪的旧轮次生成 <= 800 tokens 的结构化归档摘要"""
        if not pruned_turns:
            return ""

        raw_turn_snippets = []
        for idx, turn in enumerate(pruned_turns):
            for m in turn.messages:
                r = m.get("role")
                c = str(m.get("content") or "")
                tc = m.get("tool_calls")
                if tc:
                    raw_turn_snippets.append(
                        f"Turn {idx} [{r}]: tools={[t.get('function', {}).get('name') or t.get('name') for t in tc]}"
                    )
                elif c:
                    raw_turn_snippets.append(f"Turn {idx} [{r}]: {c[:200]}")

        snippet_text = "\n".join(raw_turn_snippets[:20])
        todo_hint = ""
        if session_id:
            cur_snap = todo_manager.format_todo_snapshot(str(session_id))
            if cur_snap:
                todo_hint = f"\nActive Todo Progress Snapshot:\n{cur_snap}\n"

        prompt_text = (
            "You are an expert conversation compression system for an AI coding assistant.\n"
            "Summarize the following archived conversation turns that are being pruned to conserve context window.\n"
            "Requirements:\n"
            "1. Output MUST be strictly under 800 tokens.\n"
            "2. Output MUST be enclosed in <compact_summary> and </compact_summary> tags.\n"
            "3. Output MUST contain exactly three structured sections:\n"
            "   [已修改文件与变更摘要]\n"
            "   [已解决与未解决的报错]\n"
            "   [核心上下文约束与待办进度]\n"
            f"{todo_hint}\n"
            f"Archived Turn Logs:\n{snippet_text}\n\n"
            "Summary:"
        )

        if model:
            try:
                from services.llm_adapter import llm_adapter

                summary_stream = llm_adapter.stream_chat(
                    messages=[{"role": "user", "content": prompt_text}],
                    tools=None,
                    model=model,
                    temperature=0.2,
                    max_tokens=600,
                    api_key=api_key,
                    base_url=base_url,
                    provider=provider,
                )
                accumulated = ""
                async for chunk in summary_stream:
                    if chunk.type == "text" and chunk.text:
                        accumulated += chunk.text

                accumulated = accumulated.strip()
                if (
                    "<compact_summary>" in accumulated
                    and "</compact_summary>" in accumulated
                ):
                    s_idx = accumulated.find("<compact_summary>")
                    e_idx = accumulated.find("</compact_summary>") + len(
                        "</compact_summary>"
                    )
                    extracted = accumulated[s_idx:e_idx]
                    if TokenMeter.count_tokens(extracted, model=model) <= 800:
                        return extracted
                elif "[已修改文件与变更摘要]" in accumulated:
                    cleaned = accumulated
                    if not cleaned.startswith("<compact_summary>"):
                        cleaned = f"<compact_summary>\n{cleaned}"
                    if not cleaned.endswith("</compact_summary>"):
                        cleaned = f"{cleaned}\n</compact_summary>"
                    if TokenMeter.count_tokens(cleaned, model=model) <= 800:
                        return cleaned
            except Exception as e:
                logger.warning("LLM 生成 L3 结构化摘要异常，启用规则提取降级: %s", e)

        return self.extract_fallback_summary(pruned_turns, session_id=session_id)

    async def compile(
        self,
        user_id: str,
        session_id: Any,
        new_prompt: str,
        message_repo: Optional[Any] = None,
        parent_id: Optional[Any] = None,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
        has_tools: bool = False,
        context_window: int = 1048576,
        workspace_root: Optional[str] = None,
        mode: Union[AgentRunMode, str] = AgentRunMode.ACT,
        fold_after_turns: int = 4,
        emitter: Optional[EnvelopeEmitter] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """执行三段式 Prefix-Cache 上下文编译，产出标准消息数组并推送 CONTEXT_TELEMETRY 遥测"""
        sid_str = str(session_id or "default")
        target_model = model or "gpt-4o"

        if parent_id and message_repo is not None:
            await message_repo.prune_branch(
                user_id=user_id,
                session_id=session_id,
                parent_id=parent_id,
            )

        # 1. 先扫描工作区脏状态并构建末尾单点 <working_memory>，使后续 Stub 折叠可立即感知 Stale 文件
        wm_block, dirty_files = self.build_working_memory_block(
            session_id=sid_str,
            new_prompt=new_prompt,
            mode=mode,
            workspace_root=workspace_root,
            consume_dirty_alerts=True,
        )
        wm_tokens = TokenMeter.count_tokens(wm_block, model=target_model) if wm_block else 0

        # 2. 构建 Segment 1 (Frozen Static Prefix) 与 Segment 2 (Semi-Static Workspace Anchor)
        prefix_messages: list[dict[str, Any]] = []
        if system_prompt:
            prefix_messages.append(self.build_segment1_frozen_system(system_prompt))
            if workspace_root:
                seg2 = self.build_segment2_workspace_anchor(workspace_root)
                if seg2:
                    prefix_messages.append(seg2)
        elif has_tools or workspace_root:
            prefix_messages.append(self.build_segment1_frozen_system())
            seg2 = self.build_segment2_workspace_anchor(workspace_root or ".")
            if seg2:
                prefix_messages.append(seg2)

        frozen_prefix_tokens = (
            TokenMeter.count_tokens(prefix_messages, model=target_model)
            if prefix_messages
            else 0
        )

        # 3. 计算历史预算并加载数据库消息
        max_context_budget = int(context_window * 0.8)
        new_prompt_tokens = TokenMeter.count_tokens(new_prompt, model=target_model)
        reserved_sys = frozen_prefix_tokens if prefix_messages else 200
        current_budget = max_context_budget - new_prompt_tokens - reserved_sys - wm_tokens

        db_messages: list[dict[str, Any]] = []
        if message_repo is not None:
            db_res = await message_repo.list_by_session(
                user_id=user_id,
                session_id=session_id,
                limit=1000,
            )
            raw_list = db_res[0] if isinstance(db_res, tuple) else db_res
            db_messages = list(raw_list or [])

        # 若数据库最后一条就是刚刚持久化的当前 new_prompt，将其从历史轮次中剥离，统一在末尾挂载
        if (
            db_messages
            and db_messages[-1].get("role") == "user"
            and self.strip_working_memory(db_messages[-1].get("content") or "")
            == new_prompt
        ):
            db_messages = db_messages[:-1]

        # 4. 打包 AtomicTurn 并执行无损存根折叠 (LosslessStubFolder)
        atomic_turns = self.build_atomic_turns(db_messages)
        folded_turns, folded_stubs_count = LosslessStubFolder.fold_turns(
            atomic_turns,
            fold_after_turns=fold_after_turns,
            session_id=sid_str,
            workspace_root=workspace_root,
            dirty_tracker=self.dirty_tracker,
        )

        # 若折叠后历史仍然逼近或超过预算阈值，对所有历史轮次 (除最新轮次外) 进一步执行深度存根折叠
        current_turns_tokens = sum(
            self.estimate_turn_tokens(t, model=target_model) for t in folded_turns
        )
        if current_turns_tokens > current_budget * 0.9 and len(folded_turns) > 1:
            deep_folded_turns, deep_count = LosslessStubFolder.fold_turns(
                folded_turns,
                fold_after_turns=1,
                session_id=sid_str,
                workspace_root=workspace_root,
                dirty_tracker=self.dirty_tracker,
                force_fold_all=True,
            )
            folded_turns = deep_folded_turns
            folded_stubs_count += deep_count

        # 5. L3 预算裁剪与 Auto-Compact 结构化摘要
        selected_turns, pruned_turns = self.apply_budget_pruning(
            folded_turns,
            budget=current_budget,
            return_pruned=True,
            model=target_model,
        )

        if pruned_turns:
            compact_summary = await self.generate_compact_summary(
                pruned_turns,
                model=model,
                session_id=sid_str,
                api_key=api_key,
                base_url=base_url,
                provider=provider,
            )
            if compact_summary:
                compact_turn = AtomicTurn(
                    role="assistant",
                    messages=[
                        {
                            "role": "assistant",
                            "content": f"[历史执行过程无损结构化归档记忆库]\n{compact_summary}",
                        }
                    ],
                )
                if selected_turns:
                    selected_turns.insert(1, compact_turn)
                    if len(selected_turns) > 2 and selected_turns[2].role == "assistant":
                        bridge_turn = AtomicTurn(
                            role="user",
                            messages=[
                                {
                                    "role": "user",
                                    "content": "[系统提示: 已确认以上历史执行结构化归档记忆，请继续基于上下文推进任务]",
                                }
                            ],
                        )
                        selected_turns.insert(2, bridge_turn)
                else:
                    selected_turns.append(compact_turn)

        # 6. 展平 Segment 1 + Segment 2 + Segment 3 (History + 末尾单点 <working_memory>)
        formatted_messages: list[dict[str, Any]] = list(prefix_messages)
        history_messages: list[dict[str, Any]] = []
        for turn in selected_turns:
            for m in turn.messages:
                m_clean = dict(m)
                if m_clean.get("role") == "user" and isinstance(m_clean.get("content"), str):
                    m_clean["content"] = self.strip_working_memory(m_clean["content"])
                history_messages.append(m_clean)
                formatted_messages.append(m_clean)

        # 若历史末尾最后一条恰好是 assistant，直接追加当前 user 消息；若历史末尾是同 role 的 user（极少见异常恢复场景），保持当前 user 消息在末尾
        tail_user_content = f"{new_prompt}\n\n{wm_block}" if wm_block else new_prompt
        formatted_messages.append({"role": "user", "content": tail_user_content})

        history_tokens = (
            TokenMeter.count_tokens(history_messages, model=target_model)
            if history_messages
            else 0
        )
        total_tokens = (
            frozen_prefix_tokens + history_tokens + new_prompt_tokens + wm_tokens
        )
        cacheable_tokens = frozen_prefix_tokens + history_tokens
        hit_ratio = cacheable_tokens / max(1, total_tokens)

        telemetry = ContextTelemetry(
            session_id=sid_str,
            frozen_prefix_tokens=frozen_prefix_tokens,
            history_tokens=history_tokens,
            working_memory_tokens=wm_tokens,
            total_tokens=total_tokens,
            folded_stubs_count=folded_stubs_count,
            dirty_files=dirty_files,
            estimated_cache_hit_ratio=hit_ratio,
            prefix_cache_stable=True,
        )
        self.last_telemetry = telemetry

        if emitter is not None:
            self.last_telemetry_sse = emitter.emit_sse(
                SSEEventName.CONTEXT_TELEMETRY.value,
                telemetry.to_dict(),
                channel=StreamChannel.CONTEXT_TELEMETRY,
            )
        else:
            self.last_telemetry_sse = None

        return formatted_messages


# 全局上下文编译器单例
context_compiler = ContextCompiler()
