import asyncio
import os
import signal
import json
from typing import Any

from core.exceptions import AppException, ErrorCode


class SandboxExecutor:
    """工业级安全子进程沙箱执行器：具备环境变量白名单脱敏、异步非阻塞管道与进程组树级强杀（防孤儿进程）。"""

    @staticmethod
    async def run_skill(
        entry_path: str,
        working_dir: str,
        input_args: dict[str, Any],
        timeout: int = 30,
    ) -> dict[str, Any]:
        # 1. 严格白名单安全环境变量：剥离 SUPABASE_KEY、JWT_SECRET 等敏感系统凭证
        safe_env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "PYTHONUNBUFFERED": "1",
            "LANG": "en_US.UTF-8",
        }

        payload = json.dumps(input_args).encode("utf-8")

        # 2. 异步创建子进程，并设置独立会话首进程/进程组 (os.setsid)
        process = await asyncio.create_subprocess_exec(
            "python3",
            entry_path,
            cwd=working_dir,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=safe_env,
            preexec_fn=os.setsid,
        )

        try:
            # 3. 异步非阻塞通信与超时熔断
            stdout_data, stderr_data = await asyncio.wait_for(
                process.communicate(input=payload),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            # 4. 超时向整个进程组广播 SIGKILL，杜绝脚本内部派生的子进程沦为孤儿进程
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            raise AppException(
                code=ErrorCode.SKILL_TIMEOUT,
                message=f"Skill 执行超时（超过 {timeout} 秒），已被安全熔断并强杀",
            )

        if process.returncode != 0:
            err_msg = stderr_data.decode("utf-8", errors="replace").strip()
            raise AppException(
                code=ErrorCode.SANDBOX_ERROR,
                message=f"Skill 执行错误 (退出码 {process.returncode}): {err_msg}",
                details={"returncode": process.returncode, "stderr": err_msg},
            )

        output_str = stdout_data.decode("utf-8", errors="replace").strip()
        if not output_str:
            return {}

        # 尝试提取最后一行或解析整个 JSON
        try:
            return json.loads(output_str)
        except json.JSONDecodeError:
            # 寻找最后一行 JSON
            for line in reversed(output_str.splitlines()):
                line = line.strip()
                if line.startswith("{") and line.endswith("}"):
                    try:
                        return json.loads(line)
                    except json.JSONDecodeError:
                        continue
            return {"raw_output": output_str}
