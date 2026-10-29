import ast
import asyncio
import collections
import difflib
import fnmatch
import glob
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Optional, Union

logger = logging.getLogger("genesis.workspace_tool")


class ShadowGitCheckpoint:
    """独立影子仓库快照：基于独立 GIT_DIR 与 GIT_WORK_TREE 实现轻量快照与 100% 回滚还原。

    隔离于用户主 Git 仓库，排除 .git、.genesis、node_modules、.venv 等目录，
    确保修改可完整回滚且不污染用户提交历史。
    """

    EXCLUDE_PATTERNS = [
        ".git/",
        ".genesis/",
        "node_modules/",
        ".venv/",
        "__pycache__/",
        ".next/",
        "dist/",
        "build/",
        ".DS_Store",
    ]

    def __init__(self, workspace_root: str):
        self.workspace_root = str(Path(workspace_root).resolve())
        self.git_dir = str(Path(self.workspace_root) / ".genesis" / "shadow_git")
        self.git_work_tree = self.workspace_root
        self._ensure_init()

    def _get_env(self) -> dict[str, str]:
        env = dict(os.environ)
        original_path = env.get("PATH", "/usr/local/bin:/usr/bin:/bin")
        env["PATH"] = f"/opt/homebrew/bin:/usr/local/bin:{original_path}"
        env["GIT_DIR"] = self.git_dir
        env["GIT_WORK_TREE"] = self.git_work_tree
        # 补齐缺省 author/committer 避免无全局 git 配置环境报错
        env["GIT_AUTHOR_NAME"] = "Genesis"
        env["GIT_AUTHOR_EMAIL"] = "genesis@local"
        env["GIT_COMMITTER_NAME"] = "Genesis"
        env["GIT_COMMITTER_EMAIL"] = "genesis@local"
        return env

    def _ensure_init(self) -> None:
        git_dir_path = Path(self.git_dir)
        git_dir_path.mkdir(parents=True, exist_ok=True)
        if not (git_dir_path / "config").exists():
            subprocess.run(
                ["git", "init"],
                cwd=self.workspace_root,
                env=self._get_env(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )

        exclude_file = git_dir_path / "info" / "exclude"
        exclude_file.parent.mkdir(parents=True, exist_ok=True)
        existing = ""
        if exclude_file.exists():
            existing = exclude_file.read_text(encoding="utf-8")
        needed = [p for p in self.EXCLUDE_PATTERNS if p not in existing]
        if needed:
            new_content = existing.rstrip("\n") + "\n" + "\n".join(needed) + "\n"
            exclude_file.write_text(new_content.lstrip("\n"), encoding="utf-8")

    def create_checkpoint(self, message: str = "snapshot") -> str:
        """执行 git add -A && git write-tree && git commit-tree 返回 commit hash"""
        self._ensure_init()
        env = self._get_env()

        subprocess.run(
            ["git", "add", "-A"],
            cwd=self.workspace_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )

        write_tree = subprocess.run(
            ["git", "write-tree"],
            cwd=self.workspace_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )
        tree_hash = write_tree.stdout.strip()

        commit_tree = subprocess.run(
            ["git", "commit-tree", tree_hash, "-m", message],
            cwd=self.workspace_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )
        commit_hash = commit_tree.stdout.strip()
        return commit_hash

    def restore_checkpoint(self, commit_hash: str) -> bool:
        """执行 git read-tree --reset -u <hash> && git clean -fd 恢复工作区"""
        if not commit_hash:
            return False
        try:
            self._ensure_init()
            env = self._get_env()

            subprocess.run(
                ["git", "read-tree", "--reset", "-u", commit_hash],
                cwd=self.workspace_root,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )

            subprocess.run(
                ["git", "clean", "-fd"],
                cwd=self.workspace_root,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )
            return True
        except subprocess.CalledProcessError as err:
            logger.warning("回滚影子快照失败 commit=%s: %s", commit_hash, getattr(err, "stderr", err))
            return False
        except Exception as e:
            logger.warning("回滚影子快照异常 commit=%s: %s", commit_hash, e)
            return False


class WorkspaceToolExecutor:
    """安全工作区执行引擎：负责本地项目目录下的文件读写、删除、检索与终端命令执行。

    具备路径防穿越（Path Traversal Guard）安全校验与超时熔断保护。
    """

    DAEMON_COMMAND_REGEX = re.compile(
        r"(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)|vite|next\s+dev|uvicorn|flask\s+run|python[0-9.]*\s+-m\s+http\.server|http\.server)",
        re.IGNORECASE,
    )
    ANSI_ESCAPE_REGEX = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
    PORT_REGEX = re.compile(
        r"(?:https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(?P<p1>\d+)|listening\s+(?:on|at)\s+(?:https?://)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:?(?P<p2>\d+)|port\s+(?P<p3>\d+)|ready\s+in\s+\d+|server\s+running\s+at\s+(?P<p4>https?://[^\s]+))",
        re.IGNORECASE,
    )
    EXCLUDED_SEARCH_DIRS = {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        ".genesis",
        ".next",
        "dist",
        "build",
        ".turbo",
        ".cache",
        "coverage",
        ".output",
        ".nuxt",
        "target",
        "vendor",
        ".gemini",
    }
    _background_tasks: dict[int, dict[str, Any]] = {}

    @staticmethod
    def resolve_safe_path(workspace_root: str, relative_path: str) -> Path:
        """解析并校验相对路径或绝对路径，阻断任何越权跳出工作区根目录的访问"""
        root = Path(workspace_root).resolve()
        raw_p = Path(relative_path.strip())

        # 若传入的是绝对路径，直接基于其实际位置判断；若是相对路径，拼接到工作区根目录下
        if raw_p.is_absolute():
            target = raw_p.resolve()
        else:
            target = (root / raw_p).resolve()

        # 核心防穿越：目标路径必须严格位于工作区根目录下或与根目录一致
        try:
            if not (target == root or target.is_relative_to(root)):
                raise PermissionError(f"安全策略拦截：禁止访问工作区外部路径 '{relative_path}'")
        except AttributeError:
            common = os.path.commonpath([str(target), str(root)])
            if common != str(root):
                raise PermissionError(f"安全策略拦截：禁止访问工作区外部路径 '{relative_path}'")
        return target

    @classmethod
    def list_dir(
        cls,
        workspace_root: str,
        path: str = ".",
        recursive: bool = False,
        max_items: int = 100,
    ) -> dict[str, Any]:
        """列出工作区指定目录下的文件和子目录结构"""
        target_dir = cls.resolve_safe_path(workspace_root, path)
        if not target_dir.exists():
            return {"success": False, "error": f"目录不存在: {path}"}
        if not target_dir.is_dir():
            return {"success": False, "error": f"指定路径不是目录: {path}"}

        items = []
        ignore_names = {
            ".git",
            "node_modules",
            ".next",
            "__pycache__",
            ".venv",
            "dist",
            "build",
            ".DS_Store",
        }

        try:
            if recursive:
                for root, dirs, files in os.walk(str(target_dir)):
                    dirs[:] = [d for d in dirs if d not in ignore_names]
                    for name in dirs + files:
                        full_p = Path(root) / name
                        rel = str(full_p.relative_to(target_dir))
                        items.append(
                            {
                                "name": name,
                                "path": rel,
                                "is_dir": full_p.is_dir(),
                                "size": full_p.stat().st_size if full_p.is_file() else None,
                            }
                        )
                        if len(items) >= max_items:
                            break
                    if len(items) >= max_items:
                        break
            else:
                for entry in os.scandir(str(target_dir)):
                    if entry.name in ignore_names:
                        continue
                    items.append(
                        {
                            "name": entry.name,
                            "path": entry.name,
                            "is_dir": entry.is_dir(),
                            "size": entry.stat().st_size if entry.is_file() else None,
                        }
                    )
                    if len(items) >= max_items:
                        break

            return {
                "success": True,
                "workspace_root": str(target_dir),
                "total": len(items),
                "items": items,
            }
        except Exception as e:
            logger.error("列出目录异常: %s", e)
            return {"success": False, "error": str(e)}

    @classmethod
    def read_file(cls, workspace_root: str, path: str) -> dict[str, Any]:
        """读取工作区中指定文件的文本内容"""
        target = cls.resolve_safe_path(workspace_root, path)
        if not target.exists():
            return {"success": False, "error": f"文件不存在: {path}"}
        if not target.is_file():
            return {"success": False, "error": f"指定路径不是普通文件: {path}"}

        try:
            # 限制单文件读取上限为 500KB，避免爆内存
            file_size = target.stat().st_size
            if file_size > 500 * 1024:
                return {
                    "success": False,
                    "error": f"文件过大 ({file_size} 字节)，超过 500KB 读取上限",
                }

            content = target.read_text(encoding="utf-8", errors="replace")
            return {
                "success": True,
                "path": path,
                "size": file_size,
                "content": content,
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    @classmethod
    def apply_smart_edit(
        cls,
        content: str,
        old_str: str,
        new_str: str,
        path: str = "",
    ) -> tuple[bool, str, str]:
        """四级瀑布流模糊匹配：
        Tier 1: 精确匹配
        Tier 2: 忽略行尾空格匹配
        Tier 3: 忽略缩进偏移 + 自动缩进对齐匹配
        Tier 4: 高相似度代码滑动窗口寻找与真实行号回传
        返回: (success: bool, new_content_or_empty: str, message_or_error: str)
        """
        if not old_str:
            return False, "", "待替换的目标代码块 (old_string) 不能为空。"

        # 1. 统一换行符
        norm_content = content.replace("\r\n", "\n")
        norm_old = old_str.replace("\r\n", "\n")
        norm_new = new_str.replace("\r\n", "\n")

        # Tier 1 (精确匹配)
        count = norm_content.count(norm_old)
        if count == 1:
            new_content = norm_content.replace(norm_old, norm_new, 1)
            return True, new_content, "Tier 1 精确匹配替换成功"
        elif count > 1:
            return (
                False,
                "",
                f"目标代码块在文件 '{path}' 中匹配到了 {count} 处，不具备唯一性。请补充上下各 3 行上下文以确保精准替换。",
            )

        # 准备按行匹配 (使用 splitlines 准确保持行语义，记录末尾是否带换行)
        file_lines = norm_content.splitlines()
        has_trailing_newline = norm_content.endswith("\n")
        old_lines = norm_old.splitlines()
        new_lines_raw = norm_new.splitlines()

        m = len(old_lines)
        n = len(file_lines)

        if m == 0:
            return False, "", "待替换的目标代码块 (old_string) 无有效行内容。"

        # Tier 2 (忽略行尾空格)
        matches_tier2 = []
        if m <= n:
            old_rstrip = [l.rstrip() for l in old_lines]
            for i in range(n - m + 1):
                if [file_lines[i + k].rstrip() for k in range(m)] == old_rstrip:
                    matches_tier2.append(i)

        if len(matches_tier2) == 1:
            idx = matches_tier2[0]
            new_lines = file_lines[:idx] + new_lines_raw + file_lines[idx + m :]
            res_content = "\n".join(new_lines)
            if has_trailing_newline and (new_lines or not res_content):
                res_content += "\n"
            return True, res_content, "Tier 2 忽略行尾空格替换成功"
        elif len(matches_tier2) > 1:
            return (
                False,
                "",
                f"目标代码块（忽略行尾空格）在文件 '{path}' 中匹配到了 {len(matches_tier2)} 处，不具备唯一性。请补充上下各 3 行上下文以确保精准替换。",
            )

        # Tier 3 (忽略缩进偏移 + 自动缩进对齐)
        matches_tier3 = []
        if m <= n and any(l.strip() for l in old_lines):
            old_strip = [l.strip() for l in old_lines]
            for i in range(n - m + 1):
                if [file_lines[i + k].strip() for k in range(m)] == old_strip:
                    matches_tier3.append(i)

        if len(matches_tier3) == 1:
            idx = matches_tier3[0]
            # 寻找首个非空行计算缩进差值
            ref_k = 0
            for k in range(m):
                if old_lines[k].strip():
                    ref_k = k
                    break
            file_ref_line = file_lines[idx + ref_k]
            old_ref_line = old_lines[ref_k]
            file_indent_len = len(file_ref_line) - len(file_ref_line.lstrip())
            old_indent_len = len(old_ref_line) - len(old_ref_line.lstrip())
            delta = file_indent_len - old_indent_len

            indent_char = " "
            if file_indent_len > 0 and file_ref_line[0] in (" ", "\t"):
                indent_char = file_ref_line[0]

            adjusted_new_lines = []
            for line in new_lines_raw:
                if not line.strip():
                    adjusted_new_lines.append("")
                elif delta > 0:
                    adjusted_new_lines.append((indent_char * delta) + line)
                elif delta < 0:
                    strip_count = min(abs(delta), len(line) - len(line.lstrip()))
                    adjusted_new_lines.append(line[strip_count:])
                else:
                    adjusted_new_lines.append(line)

            new_lines = file_lines[:idx] + adjusted_new_lines + file_lines[idx + m :]
            res_content = "\n".join(new_lines)
            if has_trailing_newline and (new_lines or not res_content):
                res_content += "\n"
            return True, res_content, "Tier 3 自动缩进对齐替换成功"
        elif len(matches_tier3) > 1:
            return (
                False,
                "",
                f"目标代码块（忽略缩进偏移）在文件 '{path}' 中匹配到了 {len(matches_tier3)} 处，不具备唯一性。请补充上下各 3 行上下文以确保精准替换。",
            )

        # Tier 4 (高相似度代码带行号回传)
        best_ratio = 0.0
        best_i = 0
        best_win = m
        clean_old_target = norm_old.rstrip("\r\n")
        if n > 0:
            for win_len in range(max(1, m - 3), min(n + 1, m + 4)):
                for i in range(n - win_len + 1):
                    cand = "\n".join(file_lines[i : i + win_len])
                    r = difflib.SequenceMatcher(None, cand, clean_old_target).ratio()
                    if r > best_ratio:
                        best_ratio = r
                        best_i = i
                        best_win = win_len

        if best_ratio >= 0.5:
            start_idx = max(0, best_i - 3)
            end_idx = min(n, best_i + best_win + 3)
            snippet_lines = []
            for k in range(start_idx, end_idx):
                snippet_lines.append(f"{k + 1:4d} | {file_lines[k]}")
            snippet = "\n".join(snippet_lines)
            return (
                False,
                "",
                f"未找到精确匹配，但在第 {best_i + 1} 行附近找到高度相似代码，请直接参考以下真实内容重试：\n{snippet}",
            )

        return (
            False,
            "",
            f"目标代码块未在文件 '{path}' 中找到。（最高相似度 {best_ratio:.2f} < 0.5，请核对代码文本后重试）",
        )

    @classmethod
    def check_syntax_errors(cls, file_path: str, content: str) -> Optional[str]:
        """AST 语法自愈预检：优先使用 tree_sitter_language_pack，优雅降级为 ast.parse (.py)。"""
        ext = Path(file_path).suffix.lower()

        # 优先尝试 tree_sitter_language_pack
        try:
            import tree_sitter_language_pack as tslp
            ext_map = {
                ".py": "python",
                ".js": "javascript",
                ".jsx": "javascript",
                ".ts": "typescript",
                ".tsx": "tsx",
                ".json": "json",
                ".html": "html",
                ".css": "css",
                ".go": "go",
                ".rs": "rust",
                ".java": "java",
                ".cpp": "cpp",
                ".c": "c",
            }
            lang = ext_map.get(ext)
            if lang:
                parser = tslp.get_parser(lang)
                tree = parser.parse(content.encode("utf-8"))
                if getattr(tree.root_node, "has_error", True):
                    error_line = None

                    def visit(node: Any) -> None:
                        nonlocal error_line
                        if error_line is not None:
                            return
                        if node.type == "ERROR" or getattr(node, "is_missing", False):
                            start_pt = node.start_point
                            row = getattr(start_pt, "row", start_pt[0])
                            error_line = row + 1
                            return
                        for child in node.children:
                            visit(child)

                    visit(tree.root_node)
                    if error_line is not None:
                        return cls._format_syntax_warning(content, error_line)
        except Exception:
            pass

        # 降级：对 .py 文件使用内置 ast.parse
        if ext == ".py":
            try:
                ast.parse(content, filename=file_path)
            except SyntaxError as e:
                error_line = e.lineno or 1
                return cls._format_syntax_warning(content, error_line)

        # 降级：对 .json 文件使用内置 json.loads
        if ext == ".json":
            try:
                import json
                json.loads(content)
            except json.JSONDecodeError as e:
                error_line = e.lineno or 1
                return cls._format_syntax_warning(content, error_line)

        return None

    @classmethod
    def _format_syntax_warning(cls, content: str, error_line: int) -> str:
        lines = content.splitlines()
        start_idx = max(0, error_line - 1 - 4)
        end_idx = min(len(lines), error_line - 1 + 5)
        snippet_lines = []
        for k in range(start_idx, end_idx):
            snippet_lines.append(f"{k + 1:4d} | {lines[k]}")
        snippet = "\n".join(snippet_lines)
        return (
            f"[AST 语法自愈警告] 修改已应用，但检测到第 {error_line} 行附近存在语法错误，请立即修复：\n"
            f"{snippet}"
        )

    @classmethod
    def write_file(
        cls,
        workspace_root: str,
        path: str,
        content: str,
        overwrite: bool = True,
    ) -> dict[str, Any]:
        """向工作区写入或创建文件，自动补齐中间父目录并生成 Unified Diff"""
        target = cls.resolve_safe_path(workspace_root, path)
        if target.exists() and not overwrite:
            return {"success": False, "error": f"文件已存在且未开启覆写: {path}"}

        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            old_content = ""
            if target.exists():
                old_content = target.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
            norm_content = content.replace("\r\n", "\n")
            if target.name.lower() == "index.html" or (path.lower().endswith(".html") and ("<html" in norm_content.lower() or "<head" in norm_content.lower())):
                from services.preview_service import inject_preview_bridge
                norm_content = inject_preview_bridge(norm_content)

            diff_lines = list(
                difflib.unified_diff(
                    old_content.splitlines(keepends=True) if old_content else [],
                    norm_content.splitlines(keepends=True),
                    fromfile=f"a/{path}" if old_content else "/dev/null",
                    tofile=f"b/{path}",
                )
            )
            diff_str = "".join(diff_lines)
            additions = sum(1 for line in diff_lines if line.startswith("+") and not line.startswith("+++"))
            deletions = sum(1 for line in diff_lines if line.startswith("-") and not line.startswith("---"))

            target.write_text(norm_content, encoding="utf-8")
            return {
                "success": True,
                "path": path,
                "name": target.name,
                "size": target.stat().st_size,
                "message": f"文件 '{path}' 写入成功",
                "diff": diff_str,
                "additions": additions,
                "deletions": deletions,
                "original_content": old_content,
                "modified_content": norm_content,
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    @classmethod
    def edit_file(
        cls,
        workspace_root: str,
        path: str,
        old_string: str,
        new_string: str,
    ) -> dict[str, Any]:
        """四级降级模糊匹配局部替换 + AST 语法自愈预检 + 结构化 Unified Diff"""
        target = cls.resolve_safe_path(workspace_root, path)
        if not target.exists():
            return {"success": False, "error": f"文件不存在: {path}"}
        if not target.is_file():
            return {"success": False, "error": f"指定路径不是文件: {path}"}

        try:
            content = target.read_text(encoding="utf-8", errors="replace")
            norm_content = content.replace("\r\n", "\n")
            norm_old = old_string.replace("\r\n", "\n")
            norm_new = new_string.replace("\r\n", "\n")

            ok, new_content, msg_or_err = cls.apply_smart_edit(
                norm_content, norm_old, norm_new, path=path
            )
            if not ok and "__genesis_preview_bridge__" in norm_content and "__genesis_preview_bridge__" not in norm_old:
                stripped_content = re.sub(
                    r"\n?<script id=[\"']__genesis_preview_bridge__[\"'][^>]*>[\s\S]*?</script>\n?",
                    "",
                    norm_content,
                )
                ok_retry, retry_content, retry_msg = cls.apply_smart_edit(
                    stripped_content, norm_old, norm_new, path=path
                )
                if ok_retry:
                    ok = True
                    new_content = retry_content
                    msg_or_err = retry_msg

            if not ok:
                return {"success": False, "error": msg_or_err}

            if target.name.lower() == "index.html" or (path.lower().endswith(".html") and ("<html" in new_content.lower() or "<head" in new_content.lower())):
                from services.preview_service import inject_preview_bridge
                new_content = inject_preview_bridge(new_content)

            diff_lines = list(
                difflib.unified_diff(
                    norm_content.splitlines(keepends=True),
                    new_content.splitlines(keepends=True),
                    fromfile=f"a/{path}",
                    tofile=f"b/{path}",
                )
            )
            diff_str = "".join(diff_lines)
            additions = sum(1 for line in diff_lines if line.startswith("+") and not line.startswith("+++"))
            deletions = sum(1 for line in diff_lines if line.startswith("-") and not line.startswith("---"))

            # 落地写入
            target.write_text(new_content, encoding="utf-8")

            # AST 语法自愈预检
            syntax_warn = cls.check_syntax_errors(path, new_content)
            final_message = f"成功局部替换文件 '{path}' 中的代码块（{msg_or_err}）"
            if syntax_warn:
                final_message = f"{final_message}\n\n{syntax_warn}"

            res: dict[str, Any] = {
                "success": True,
                "path": path,
                "name": target.name,
                "message": final_message,
                "tier_message": msg_or_err,
                "old_len": len(old_string),
                "new_len": len(new_string),
                "diff": diff_str,
                "additions": additions,
                "deletions": deletions,
                "original_content": norm_content,
                "modified_content": new_content,
            }
            if syntax_warn:
                res["syntax_warning"] = syntax_warn
            return res
        except Exception as e:
            return {"success": False, "error": str(e)}

    @classmethod
    def compact_output(
        cls,
        workspace_root: str,
        payload: Any,
        max_chars: int = 2000,
    ) -> Any:
        """Claude Code (s08) 工业级输出压缩：超长输出自动转存磁盘文件，返回首尾切片与磁盘引用。"""
        if not payload:
            return payload

        # 处理 dict 结构中的关键文本字段（stdout, content, raw_output 等）
        if isinstance(payload, dict):
            compacted = dict(payload)
            for field in ["stdout", "content", "raw_output"]:
                val = compacted.get(field)
                if isinstance(val, str) and len(val) > max_chars:
                    compacted[field] = cls._spill_to_disk(workspace_root, val, max_chars)
            return compacted

        if isinstance(payload, str) and len(payload) > max_chars:
            return cls._spill_to_disk(workspace_root, payload, max_chars)

        return payload

    @classmethod
    def _spill_to_disk(cls, workspace_root: str, text: str, max_chars: int) -> str:
        """将长文本转储到 .genesis_outputs/tool-results/ 并生成折叠切片"""
        import uuid
        try:
            out_dir = Path(workspace_root) / ".genesis_outputs" / "tool-results"
            out_dir.mkdir(parents=True, exist_ok=True)
            file_id = uuid.uuid4().hex[:12]
            dump_file = out_dir / f"result_{file_id}.txt"
            dump_file.write_text(text, encoding="utf-8")

            lines = text.splitlines()
            head_lines = "\n".join(lines[:20])
            tail_lines = "\n".join(lines[-20:])
            rel_path = f".genesis_outputs/tool-results/result_{file_id}.txt"
            truncated_chars = len(text) - len(head_lines) - len(tail_lines)

            return (
                f"{head_lines}\n\n"
                f"[... 输出超限已自动截断，省略了 {max(0, truncated_chars)} 字符。完整日志已持久化至: '{rel_path}' ...]\n\n"
                f"{tail_lines}"
            )
        except Exception as exc:
            logger.warning("转储工具大输出异常: %s", exc)
            return text[:max_chars] + f"\n[... 已截断，剩余 {len(text) - max_chars} 字符 ...]"

    @classmethod
    def delete_file(cls, workspace_root: str, path: str) -> dict[str, Any]:
        """删除工作区中的指定文件、目录，或按通配符模式批量删除"""
        root = Path(workspace_root).resolve()
        cleaned_path = path.strip().lstrip("/\\")

        # 支持通配符模式匹配（如 *.asf 或 asf*）
        if any(char in cleaned_path for char in ["*", "?", "["]):
            pattern = str(root / cleaned_path)
            matched = glob.glob(pattern, recursive=True)
            deleted_list = []
            for item in matched:
                item_path = Path(item).resolve()
                if not (str(item_path) == str(root) or str(item_path).startswith(str(root) + os.sep)):
                    continue
                if item_path == root:
                    continue
                try:
                    if item_path.is_file():
                        item_path.unlink()
                        deleted_list.append(str(item_path.relative_to(root)))
                    elif item_path.is_dir():
                        shutil.rmtree(item_path)
                        deleted_list.append(str(item_path.relative_to(root)))
                except Exception as del_err:
                    logger.warning("删除匹配项 %s 失败: %s", item_path, del_err)

            if deleted_list:
                return {
                    "success": True,
                    "deleted_count": len(deleted_list),
                    "deleted": deleted_list,
                    "message": f"成功删除 {len(deleted_list)} 个匹配文件/目录",
                }
            return {
                "success": False,
                "error": f"未找到符合通配符 '{path}' 的文件",
            }

        target = cls.resolve_safe_path(workspace_root, path)
        if not target.exists():
            # 宽容处理：尝试在工作区查找是否为无后缀名匹配（例如用户输入 asf，实际是 asf.html）
            matched_candidates = list(root.glob(f"{target.name}.*"))
            if matched_candidates:
                candidate = matched_candidates[0]
                if candidate.is_file():
                    candidate.unlink()
                    return {
                        "success": True,
                        "path": str(candidate.relative_to(root)),
                        "message": f"成功找到并删除文件 '{candidate.name}'",
                    }

            return {"success": False, "error": f"文件或目录不存在: {path}"}

        if target == root:
            return {"success": False, "error": "安全限制：严禁直接删除工作区根目录"}

        try:
            if target.is_file():
                target.unlink()
                return {
                    "success": True,
                    "path": path,
                    "message": f"文件 '{path}' 已成功删除",
                }
            elif target.is_dir():
                shutil.rmtree(target)
                return {
                    "success": True,
                    "path": path,
                    "message": f"目录 '{path}' 及其所有子文件已成功删除",
                }
            else:
                return {"success": False, "error": f"未知的文件系统对象: {path}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @staticmethod
    def _kill_process_tree(pid: int) -> None:
        """连根拔起整个子进程组"""
        if sys.platform == "win32":
            import subprocess
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    capture_output=True,
                    check=False,
                )
            except Exception as exc:
                logger.warning("Windows清理进程组失败 pid=%d: %s", pid, exc)
            return

        try:
            pgid = os.getpgid(pid)
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except Exception as exc:
            logger.warning("清理进程组失败 pid=%d: %s", pid, exc)

    @classmethod
    async def _execute_command_async(
        cls,
        workspace_root: str,
        command: str,
        timeout: int = 30,
        is_background: Optional[bool] = None,
        callback: Optional[Any] = None,
        session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """异步零死锁终端命令执行器：
        1. 支持 is_background 及守护命令正则识别
        2. 异步进程组独立 session 启动
        3. 持续后台排空协程（防 64KB 管道阻塞挂死）+ 端口就绪探针
        4. 捕获 CancelledError 及超时熔断时整组拔起
        """
        root = Path(workspace_root).resolve()
        if not root.is_dir():
            return {"success": False, "error": f"工作区目录不存在: {workspace_root}"}

        # 判断是否为后台守护任务
        if is_background is None:
            is_bg = bool(cls.DAEMON_COMMAND_REGEX.search(command))
        else:
            is_bg = bool(is_background) or bool(cls.DAEMON_COMMAND_REGEX.search(command))

        # 环境变量增强：优先注入 /opt/homebrew/bin:/usr/local/bin:
        safe_env = dict(os.environ)
        original_path = safe_env.get("PATH", "/usr/local/bin:/usr/bin:/bin")
        safe_env["PATH"] = f"/opt/homebrew/bin:/usr/local/bin:{original_path}"
        safe_env["TERM"] = "xterm-256color"
        safe_env["LANG"] = "en_US.UTF-8"
        safe_env["PYTHONUNBUFFERED"] = "1"

        proc = None
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
                cwd=str(root),
                env=safe_env,
            )
        except Exception as start_err:
            return {"success": False, "error": f"启动进程失败: {start_err}"}

        buffer: collections.deque[str] = collections.deque(maxlen=500)
        ready_event = asyncio.Event()
        detected_url: Optional[str] = None

        def _extract_url(line: str) -> Optional[str]:
            m = cls.PORT_REGEX.search(line)
            if m:
                if m.groupdict().get("p4"):
                    u = m.group("p4")
                    return u.replace("://0.0.0.0", "://localhost")
                port = (
                    m.groupdict().get("p1")
                    or m.groupdict().get("p2")
                    or m.groupdict().get("p3")
                )
                if port:
                    return f"http://localhost:{port}"
            return None

        async def drain_stdout():
            nonlocal detected_url
            try:
                while True:
                    line_bytes = await proc.stdout.readline()
                    if not line_bytes:
                        break
                    raw_line = line_bytes.decode("utf-8", errors="replace")
                    clean_line = cls.ANSI_ESCAPE_REGEX.sub("", raw_line).rstrip("\r\n")
                    buffer.append(clean_line)
                    if not ready_event.is_set():
                        url = _extract_url(clean_line)
                        if url:
                            detected_url = url
                            ready_event.set()
            except Exception as exc:
                logger.debug("持续排空协程已结束: %s", exc)
            finally:
                if is_bg and proc and proc.pid:
                    cls._background_tasks.pop(proc.pid, None)

        drain_task = asyncio.create_task(drain_stdout())

        if is_bg:
            cls._background_tasks[proc.pid] = {
                "proc": proc,
                "drain_task": drain_task,
                "buffer": buffer,
                "command": command,
                "session_id": str(session_id) if session_id else None,
            }
            try:
                wait_targets = [
                    asyncio.create_task(ready_event.wait()),
                    asyncio.create_task(proc.wait()),
                ]
                done, pending = await asyncio.wait(
                    wait_targets,
                    timeout=4.5,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for t in pending:
                    t.cancel()
            except asyncio.CancelledError:
                if proc.pid:
                    cls._kill_process_tree(proc.pid)
                raise
            except Exception:
                pass

            # 若进程在 4.5 秒内提前退出
            if proc.returncode is not None:
                cls._background_tasks.pop(proc.pid, None)
                await drain_task
                stdout = "\n".join(buffer)
                return {
                    "success": proc.returncode == 0,
                    "returncode": proc.returncode,
                    "stdout": stdout,
                    "stderr": "",
                    "command": command,
                    "pid": proc.pid,
                }

            # 进程平稳进入后台运行
            if not detected_url:
                cmd_url = _extract_url(command)
                if cmd_url:
                    detected_url = cmd_url
                else:
                    port_m = re.search(r"(?:--port|-p|\s)(\d{4,5})(?:\s|$)", command)
                    if port_m:
                        p_val = int(port_m.group(1))
                        if 1024 <= p_val <= 65535:
                            detected_url = f"http://localhost:{p_val}"

            recent_50 = list(buffer)[-50:]
            stdout_preview = "\n".join(recent_50)
            res_payload = {
                "success": True,
                "status": "running_in_background",
                "pid": proc.pid,
                "url": detected_url,
                "stdout": stdout_preview,
                "recent_logs": recent_50,
                "command": command,
                "message": f"进程已在后台平稳运行 (PID: {proc.pid})"
                + (f"，探测到服务地址: {detected_url}" if detected_url else ""),
            }
            if callback:
                try:
                    if asyncio.iscoroutinefunction(callback):
                        await callback(res_payload)
                    else:
                        callback(res_payload)
                except Exception as cb_err:
                    logger.warning("后台进程就绪回调异常: %s", cb_err)
            return res_payload

        # 前台常规执行
        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout)
            await drain_task
            stdout = "\n".join(buffer)
            return {
                "success": proc.returncode == 0,
                "returncode": proc.returncode,
                "stdout": stdout,
                "stderr": "",
                "command": command,
                "pid": proc.pid,
                "url": detected_url,
            }
        except asyncio.TimeoutError:
            if proc.pid:
                cls._kill_process_tree(proc.pid)
            await drain_task
            return {
                "success": False,
                "returncode": -1,
                "error": f"命令执行超时 (超过 {timeout} 秒) 已自动熔断",
                "stdout": "\n".join(buffer),
                "command": command,
            }
        except asyncio.CancelledError:
            if proc.pid:
                cls._kill_process_tree(proc.pid)
            raise

    @classmethod
    def execute_command(
        cls,
        workspace_root: str,
        command: str,
        timeout: int = 30,
        is_background: Optional[bool] = None,
        callback: Optional[Any] = None,
        session_id: Optional[str] = None,
    ) -> Any:
        """在项目工作区根目录下执行 Shell 指令。

        内部无缝兼顾同步测试调用（无 EventLoop 时自动通过 asyncio.run 执行）
        与异步调用（通过 await 调用）。
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            return cls._execute_command_async(
                workspace_root=workspace_root,
                command=command,
                timeout=timeout,
                is_background=is_background,
                callback=callback,
                session_id=session_id,
            )
        else:
            return asyncio.run(
                cls._execute_command_async(
                    workspace_root=workspace_root,
                    command=command,
                    timeout=timeout,
                    is_background=is_background,
                    callback=callback,
                    session_id=session_id,
                )
            )

    @classmethod
    def stop_background_process(cls, pid: int) -> bool:
        """根据 PID 连根拔起并注销后台守护进程组"""
        task_info = cls._background_tasks.pop(pid, None)
        cls._kill_process_tree(pid)
        if task_info:
            drain = task_info.get("drain_task")
            if drain and not drain.done():
                drain.cancel()
        return True

    @classmethod
    def list_background_processes(cls, session_id: Optional[str] = None) -> list[dict[str, Any]]:
        """列出当前存活的所有后台守护进程，支持按 session_id 过滤"""
        alive = []
        to_remove = []
        for pid, info in cls._background_tasks.items():
            proc = info.get("proc")
            if proc and proc.returncode is None:
                task_sid = info.get("session_id")
                if session_id and task_sid and str(task_sid) != str(session_id):
                    continue
                alive.append({
                    "pid": pid,
                    "command": info.get("command", ""),
                    "session_id": task_sid,
                    "buffer_len": len(info.get("buffer", [])),
                })
            else:
                to_remove.append(pid)
        for pid in to_remove:
            cls._background_tasks.pop(pid, None)
        return alive

    @classmethod
    def get_background_process_logs(cls, pid: int, lines: int = 100) -> list[str]:
        """获取指定后台进程最近的输出日志"""
        task_info = cls._background_tasks.get(pid)
        if not task_info:
            return []
        buf = list(task_info.get("buffer", []))
        return buf[-lines:]

    @classmethod
    def grep_search(
        cls,
        workspace_root: str,
        query: str,
        path: str = ".",
        case_sensitive: bool = False,
        is_regex: bool = False,
        max_results: int = 50,
    ) -> dict[str, Any]:
        """在工作区文件文本内容中检索关键词或正则（自动排除无关目录，限制前 50 条匹配）。"""
        if not query:
            return {"success": False, "error": "检索关键词 query 不能为空"}

        try:
            target = cls.resolve_safe_path(workspace_root, path)
        except Exception as e:
            return {"success": False, "error": str(e)}

        if not target.exists():
            return {"success": False, "error": f"检索路径不存在: {path}"}

        root = Path(workspace_root).resolve()
        flags = 0 if case_sensitive else re.IGNORECASE
        regex = None
        if is_regex:
            try:
                regex = re.compile(query, flags)
            except re.error as err:
                return {"success": False, "error": f"无效的正则表达式: {err}"}

        matches: list[dict[str, Any]] = []

        def _search_in_file(file_path: Path):
            nonlocal matches
            if len(matches) >= max_results:
                return
            try:
                if file_path.stat().st_size > 2 * 1024 * 1024:
                    return
                text = file_path.read_text(encoding="utf-8", errors="ignore")
                lines = text.splitlines()
                rel_file = str(file_path.relative_to(root))
                for idx, line in enumerate(lines, start=1):
                    is_match = False
                    if is_regex and regex:
                        is_match = bool(regex.search(line))
                    elif not case_sensitive:
                        is_match = query.lower() in line.lower()
                    else:
                        is_match = query in line

                    if is_match:
                        matches.append(
                            {
                                "file": rel_file,
                                "line_number": idx,
                                "line_content": line[:300].strip(),
                            }
                        )
                        if len(matches) >= max_results:
                            return
            except Exception:
                pass

        files_scanned = 0
        max_files_scanned = 2000
        max_depth = 8

        if target.is_file():
            _search_in_file(target)
        else:
            for dirpath, dirnames, filenames in os.walk(str(target)):
                try:
                    rel_dir = Path(dirpath).relative_to(target)
                    depth = len(rel_dir.parts)
                except Exception:
                    depth = 0
                if depth >= max_depth:
                    dirnames.clear()

                dirnames[:] = [d for d in dirnames if d not in cls.EXCLUDED_SEARCH_DIRS]
                for f in filenames:
                    if f in (".DS_Store",):
                        continue
                    fp = Path(dirpath) / f
                    files_scanned += 1
                    _search_in_file(fp)
                    if len(matches) >= max_results or files_scanned >= max_files_scanned:
                        break
                if len(matches) >= max_results or files_scanned >= max_files_scanned:
                    break

        return {
            "success": True,
            "query": query,
            "total_matches": len(matches),
            "matches": matches,
            "truncated": len(matches) >= max_results or files_scanned >= max_files_scanned,
        }

    @classmethod
    def find_by_name(
        cls,
        workspace_root: str,
        pattern: str,
        path: str = ".",
        type: str = "any",
        max_results: int = 50,
    ) -> dict[str, Any]:
        """在工作区文件树中按文件名或通配符查找（自动排除无关目录，限制前 50 条匹配）。"""
        if not pattern:
            return {"success": False, "error": "搜索模式 pattern 不能为空"}

        try:
            target = cls.resolve_safe_path(workspace_root, path)
        except Exception as e:
            return {"success": False, "error": str(e)}

        if not target.exists():
            return {"success": False, "error": f"搜索路径不存在: {path}"}

        root = Path(workspace_root).resolve()
        matches: list[dict[str, Any]] = []

        if target.is_file():
            if fnmatch.fnmatch(target.name, pattern) and type in ("file", "any"):
                matches.append(
                    {
                        "name": target.name,
                        "path": str(target.relative_to(root)),
                        "is_dir": False,
                        "size": target.stat().st_size,
                    }
                )
            return {
                "success": True,
                "pattern": pattern,
                "total_matches": len(matches),
                "matches": matches,
                "truncated": False,
            }

        files_scanned = 0
        max_files_scanned = 2000
        max_depth = 8

        for dirpath, dirnames, filenames in os.walk(str(target)):
            try:
                rel_dir = Path(dirpath).relative_to(target)
                depth = len(rel_dir.parts)
            except Exception:
                depth = 0
            if depth >= max_depth:
                dirnames.clear()

            dirnames[:] = [d for d in dirnames if d not in cls.EXCLUDED_SEARCH_DIRS]

            # 搜索目录
            if type in ("directory", "any"):
                for d in dirnames:
                    files_scanned += 1
                    if fnmatch.fnmatch(d, pattern):
                        dp = Path(dirpath) / d
                        rel_path = str(dp.relative_to(root))
                        matches.append(
                            {
                                "name": d,
                                "path": rel_path,
                                "is_dir": True,
                                "size": None,
                            }
                        )
                        if len(matches) >= max_results:
                            break
                if len(matches) >= max_results or files_scanned >= max_files_scanned:
                    break

            # 搜索文件
            if type in ("file", "any"):
                for f in filenames:
                    files_scanned += 1
                    if fnmatch.fnmatch(f, pattern):
                        fp = Path(dirpath) / f
                        rel_path = str(fp.relative_to(root))
                        size = None
                        try:
                            size = fp.stat().st_size
                        except Exception:
                            pass
                        matches.append(
                            {
                                "name": f,
                                "path": rel_path,
                                "is_dir": False,
                                "size": size,
                            }
                        )
                        if len(matches) >= max_results or files_scanned >= max_files_scanned:
                            break
                if len(matches) >= max_results or files_scanned >= max_files_scanned:
                    break

        return {
            "success": True,
            "pattern": pattern,
            "total_matches": len(matches),
            "matches": matches,
            "truncated": len(matches) >= max_results or files_scanned >= max_files_scanned,
        }

    @classmethod
    def create_checkpoint(cls, workspace_root: str, message: str = "snapshot") -> str:
        """为工作区创建影子 Git 快照"""
        sg = ShadowGitCheckpoint(workspace_root)
        return sg.create_checkpoint(message)

    @classmethod
    def restore_checkpoint(cls, workspace_root: str, commit_hash: str) -> bool:
        """回滚工作区至指定的影子快照"""
        sg = ShadowGitCheckpoint(workspace_root)
        return sg.restore_checkpoint(commit_hash)
