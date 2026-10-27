import asyncio
import codecs
import fcntl
import json
import logging
import os
import pty
import select
import signal
import struct
import termios
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger("genesis.terminal")


def get_default_workspace() -> str:
    """获取终端默认工作目录，优先寻找 Genesis 项目根目录"""
    env_root = os.environ.get("WORKSPACE_ROOT")
    if env_root and os.path.isdir(env_root):
        return env_root

    current_file = os.path.abspath(__file__)
    # .../Genesis/api/services/terminal_manager.py -> .../Genesis
    genesis_root = os.path.abspath(os.path.join(current_file, "..", "..", ".."))
    if os.path.isdir(genesis_root) and (
        os.path.exists(os.path.join(genesis_root, "web"))
        or os.path.exists(os.path.join(genesis_root, ".git"))
    ):
        return genesis_root

    return os.getcwd()


class TerminalSession:
    """
    单实例终端会话 (PTY + 子进程组隔离 + 历史回放缓存 + 热重启保活)
    """

    MAX_HISTORY_BYTES = 512 * 1024  # 最大 512KB 环形历史缓存

    def __init__(
        self,
        session_id: str,
        title: Optional[str] = None,
        cwd: Optional[str] = None,
        rows: int = 24,
        cols: int = 80,
    ):
        self.id = session_id
        self.title = title or f"Terminal {session_id[:6]}"
        self.cwd = (
            cwd
            if (cwd and os.path.isdir(cwd))
            else get_default_workspace()
        )
        self.rows = max(1, min(rows, 1000))
        self.cols = max(1, min(cols, 1000))
        self.pid: Optional[int] = None
        self.master_fd: Optional[int] = None
        self._is_alive: bool = False
        self._exit_code: Optional[int] = None
        self.created_at: str = datetime.now(timezone.utc).isoformat()

        self._history: bytearray = bytearray()
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.subscribers: set[asyncio.Queue] = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._reader_added: bool = False

    def start(self):
        """创建 PTY 主从对，并在独立进程组中拉起 Shell"""
        if self._is_alive:
            return

        master_fd, slave_fd = pty.openpty()

        # 设置初始终端行列尺寸
        try:
            winsize = struct.pack("HHHH", self.rows, self.cols, 0, 0)
            fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)
        except (OSError, struct.error):
            pass

        pid = os.fork()

        if pid == 0:
            # === 子进程上下文 ===
            try:
                # 1. 独立进程组隔离：os.setsid() 让当前子进程成为全新会话与进程组 Leader
                os.setsid()

                # 2. 挂接控制终端 (Controlling TTY)
                try:
                    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
                except Exception:
                    pass

                # 3. 将 slave_fd 复制到标准输入、标准输出、标准错误
                os.dup2(slave_fd, 0)
                os.dup2(slave_fd, 1)
                os.dup2(slave_fd, 2)

                # 4. 关闭多余的文件描述符 (防止继承父进程 DB 连接、socket、其他 master_fd 等)
                try:
                    import resource
                    max_fd = resource.getrlimit(resource.RLIMIT_NOFILE)[1]
                    if max_fd == resource.RLIM_INFINITY or max_fd > 4096:
                        max_fd = 4096
                    os.closerange(3, max_fd)
                except Exception:
                    if slave_fd > 2:
                        try:
                            os.close(slave_fd)
                        except OSError:
                            pass
                    try:
                        os.close(master_fd)
                    except OSError:
                        pass

                # 5. 切换到项目工作目录
                target_dir = self.cwd if (self.cwd and os.path.isdir(self.cwd)) else os.getcwd()
                try:
                    os.chdir(target_dir)
                except Exception:
                    pass

                # 6. 配置环境变量
                env = os.environ.copy()
                env["TERM"] = "xterm-256color"
                env["COLORTERM"] = "truecolor"
                env["LANG"] = "en_US.UTF-8"
                env["LC_ALL"] = "en_US.UTF-8"
                env["TERM_PROGRAM"] = "Genesis"
                env["PWD"] = target_dir

                # 确保标准开发者路径 (Node, Homebrew, Git, pnpm) 注入
                existing_path = env.get("PATH", "")
                standard_paths = [
                    "/opt/homebrew/bin",
                    "/opt/homebrew/sbin",
                    "/usr/local/bin",
                    "/usr/bin",
                    "/bin",
                    "/usr/sbin",
                    "/sbin",
                ]
                path_parts = existing_path.split(":") if existing_path else []
                for p in standard_paths:
                    if p not in path_parts and os.path.isdir(p):
                        path_parts.append(p)
                env["PATH"] = ":".join(path_parts)

                # 7. 选择可用 Shell (优先用户的 $SHELL，其次 zsh，bash，最后 sh)
                shell = os.environ.get("SHELL")
                if not shell or not os.path.exists(shell):
                    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"]:
                        if os.path.exists(candidate):
                            shell = candidate
                            break
                shell = shell or "/bin/sh"

                # 启动交互式登录 Shell
                os.execvpe(shell, [shell, "-l"], env)
            except Exception:
                os._exit(1)
        else:
            # === 父进程上下文 ===
            try:
                os.close(slave_fd)
            except OSError:
                pass
            self.pid = pid
            self.master_fd = master_fd
            self._is_alive = True

            # 设置 master_fd 为非阻塞 I/O
            flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
            fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

            # 注册到 AsyncIO 事件循环进行异步事件驱动读取
            if self.loop is None or self.loop.is_closed():
                try:
                    self.loop = asyncio.get_running_loop()
                except RuntimeError:
                    try:
                        self.loop = asyncio.get_event_loop_policy().get_event_loop()
                    except Exception:
                        self.loop = asyncio.new_event_loop()

            try:
                curr_loop = asyncio.get_running_loop()
            except RuntimeError:
                curr_loop = None

            if curr_loop is self.loop:
                self.loop.add_reader(self.master_fd, self._on_pty_read)
            else:
                self.loop.call_soon_threadsafe(
                    self.loop.add_reader, self.master_fd, self._on_pty_read
                )
            self._reader_added = True

            logger.info(
                f"[TerminalSession] 启动成功 id={self.id}, pid={self.pid}, master_fd={self.master_fd}, cwd={self.cwd}"
            )

    def _on_pty_read(self):
        """PTY master_fd 读就绪回调，严防 EOF / EIO 导致的 100% CPU 忙循环"""
        if self.master_fd is None:
            return

        try:
            data = os.read(self.master_fd, 8192)
            if not data:
                # 收到空数据，表示对端 slave 已关闭 (EOF)
                self._handle_eof()
                return

            # 追加到会话回放历史
            self._append_history(data)

            # 广播给已订阅的前端 WebSocket 队列
            self._broadcast(data)

        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            # Linux / macOS 上 slave 退出通常触发 EIO，或收到 EBADF
            self._handle_eof()

    def _handle_eof(self):
        """
        核心防御点：子进程退出或 PTY 挂断时，必须立即移除 event loop 的 reader 监听，
        并关闭 master_fd，否则 selector 会在每一帧都无限触发就绪事件，导致 100% CPU 占用！
        """
        if (
            self._reader_added
            and self.master_fd is not None
            and self.loop is not None
            and not self.loop.is_closed()
        ):
            try:
                curr_loop = asyncio.get_running_loop()
            except RuntimeError:
                curr_loop = None

            if curr_loop is self.loop:
                try:
                    self.loop.remove_reader(self.master_fd)
                except Exception:
                    pass
            else:
                try:
                    self.loop.call_soon_threadsafe(
                        self.loop.remove_reader, self.master_fd
                    )
                except RuntimeError:
                    pass
        self._reader_added = False

        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None

        self._is_alive = False

        # 非阻塞回收僵尸进程状态
        if self.pid:
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
                if pid == self.pid:
                    if os.WIFEXITED(status):
                        self._exit_code = os.WEXITSTATUS(status)
                    elif os.WIFSIGNALED(status):
                        self._exit_code = -os.WTERMSIG(status)
            except ChildProcessError:
                pass

        logger.info(
            f"[TerminalSession] 会话已断开 id={self.id}, pid={self.pid}, exit_code={self._exit_code}"
        )
        self._broadcast_exit(self._exit_code or 0)

    def _append_history(self, data: bytes):
        """维护固定大小的环形历史流缓存，且滑动裁剪时自动对齐 UTF-8 字符首字节"""
        self._history.extend(data)
        if len(self._history) > self.MAX_HISTORY_BYTES:
            drop_count = len(self._history) - self.MAX_HISTORY_BYTES
            # 若裁剪点位于 UTF-8 多字节序列的 continuation 字节 (10xxxxxx)，向后微调避免乱码
            while drop_count < len(self._history) and (self._history[drop_count] & 0xC0) == 0x80:
                drop_count += 1
            self._history = self._history[drop_count:]

    def get_history_text(self) -> str:
        """返回已保存的历史字符流"""
        return bytes(self._history).decode("utf-8", errors="replace")

    def write(self, data: str | bytes):
        """前端字符流输入写入 PTY master，支持非阻塞缓冲分块写入与满载保护"""
        if not self.is_alive() or self.master_fd is None:
            return
        try:
            if isinstance(data, str):
                data = data.encode("utf-8")
            offset = 0
            while offset < len(data):
                try:
                    n = os.write(self.master_fd, data[offset:])
                    offset += n
                except (BlockingIOError, InterruptedError):
                    # PTY 写入缓冲区已满，使用 select 等待最多 0.2 秒
                    r, w, _ = select.select([], [self.master_fd], [], 0.2)
                    if not w:
                        logger.warning(
                            f"[TerminalSession] PTY 写入超时，丢弃剩余 {len(data) - offset} 字节"
                        )
                        break
        except OSError as e:
            logger.debug(f"[TerminalSession] write failed: {e}")

    def resize(self, rows: int, cols: int):
        """调整终端窗口大小 (TIOCSWINSZ)，内置数值越界与类型防御"""
        try:
            self.rows = max(1, min(int(rows), 1000))
            self.cols = max(1, min(int(cols), 1000))
        except (TypeError, ValueError):
            return

        if self.master_fd is None or not self.is_alive():
            return
        try:
            winsize = struct.pack("HHHH", self.rows, self.cols, 0, 0)
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
        except (OSError, struct.error) as e:
            logger.debug(f"[TerminalSession] resize failed: {e}")

    def subscribe(self) -> asyncio.Queue:
        """注册一个 WebSocket 输出队列"""
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        """注销 WebSocket 输出队列"""
        self.subscribers.discard(queue)

    def _broadcast(self, data: bytes):
        """广播输出数据到所有活动客户端，使用增量解码器避免多字节 UTF-8 截断乱码"""
        text = self._decoder.decode(data)
        if not text:
            return
        msg = {"type": "output", "data": text}
        for q in list(self.subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    q.put_nowait(msg)
                except Exception:
                    pass

    def _broadcast_exit(self, code: int):
        """广播会话退出事件"""
        msg = {"type": "exit", "code": code}
        for q in list(self.subscribers):
            try:
                q.put_nowait(msg)
            except Exception:
                pass

    def is_alive(self) -> bool:
        """检测子进程与 PTY 当前是否存活"""
        if not self._is_alive or not self.pid:
            return False
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid == self.pid:
                self._is_alive = False
                if os.WIFEXITED(status):
                    self._exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    self._exit_code = -os.WTERMSIG(status)
                self._handle_eof()
                return False
            return True
        except ChildProcessError:
            self._is_alive = False
            self._handle_eof()
            return False
        except Exception:
            return self._is_alive

    def _terminate_process_only(self):
        """仅终止子进程与 PTY，保留当前已连接的 WebSocket 订阅队列"""
        if (
            self._reader_added
            and self.master_fd is not None
            and self.loop is not None
            and not self.loop.is_closed()
        ):
            try:
                curr_loop = asyncio.get_running_loop()
            except RuntimeError:
                curr_loop = None

            if curr_loop is self.loop:
                try:
                    self.loop.remove_reader(self.master_fd)
                except Exception:
                    pass
            else:
                try:
                    self.loop.call_soon_threadsafe(
                        self.loop.remove_reader, self.master_fd
                    )
                except RuntimeError:
                    pass
        self._reader_added = False

        old_pid = self.pid
        if old_pid:
            try:
                os.killpg(old_pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            except Exception as e:
                logger.warning(f"Error terminating pg {old_pid}: {e}")

            self._reap_process_async(old_pid)
            self.pid = None

        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None

        self._is_alive = False

    def restart(
        self,
        cwd: Optional[str] = None,
        title: Optional[str] = None,
        rows: Optional[int] = None,
        cols: Optional[int] = None,
    ):
        """
        核心热重启能力：
        终结旧进程组，保留所有前端 WebSocket 订阅者连接，拉起全新 Shell 并无感续期
        """
        self._terminate_process_only()
        if title:
            self.title = title
        if cwd and os.path.isdir(cwd):
            self.cwd = cwd
        if rows:
            self.rows = max(1, min(int(rows), 1000))
        if cols:
            self.cols = max(1, min(int(cols), 1000))

        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        restart_notice = "\r\n\x1b[36m[终端会话已重新启动]\x1b[0m\r\n"
        self._append_history(restart_notice.encode("utf-8"))
        self._broadcast(restart_notice.encode("utf-8"))
        self.start()

    def terminate(self):
        """
        完全注销并全量杀死进程组，绝不残留孤儿进程 (如 node dev server)
        """
        self._terminate_process_only()
        self._broadcast_exit(self._exit_code or 0)
        logger.info(f"[TerminalSession] 已完全终止 id={self.id}")

    def _reap_process_async(self, pid: int):
        """非阻塞异步回收子进程，严防 time.sleep 阻塞主事件循环与僵尸进程驻留"""
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                if os.WIFEXITED(status):
                    self._exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    self._exit_code = -os.WTERMSIG(status)
                return
        except ChildProcessError:
            return

        async def _reap():
            try:
                # 轮询 6 次，总计 300ms 观察子进程是否响应 SIGTERM 自行退出
                for _ in range(6):
                    await asyncio.sleep(0.05)
                    try:
                        wpid, status = os.waitpid(pid, os.WNOHANG)
                        if wpid == pid:
                            return
                    except ChildProcessError:
                        return

                # 若仍未退出，升级为 SIGKILL 强杀进程组
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    return
                except Exception:
                    pass

                await asyncio.sleep(0.05)
                try:
                    os.waitpid(pid, os.WNOHANG)
                except Exception:
                    pass
            except Exception:
                pass

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_reap())
        except RuntimeError:
            try:
                time.sleep(0.05)
                wpid, _ = os.waitpid(pid, os.WNOHANG)
                if wpid != pid:
                    os.killpg(pid, signal.SIGKILL)
                    time.sleep(0.02)
                    os.waitpid(pid, os.WNOHANG)
            except Exception:
                pass

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "cwd": self.cwd,
            "pid": self.pid,
            "is_alive": self.is_alive(),
            "created_at": self.created_at,
        }


class TerminalManager:
    """
    终端单例管理器，维护跨请求 / 跨连接的终端持久会话
    """

    _instance: Optional["TerminalManager"] = None

    def __init__(self):
        self.sessions: dict[str, TerminalSession] = {}
        self._lock = asyncio.Lock()

    @classmethod
    def get_instance(cls) -> "TerminalManager":
        if cls._instance is None:
            cls._instance = TerminalManager()
        return cls._instance

    def get_session(self, session_id: str) -> Optional[TerminalSession]:
        return self.sessions.get(session_id)

    def create_session(
        self,
        session_id: Optional[str] = None,
        title: Optional[str] = None,
        cwd: Optional[str] = None,
        rows: int = 24,
        cols: int = 80,
    ) -> TerminalSession:
        sid = session_id or str(uuid.uuid4())
        # 若已存在同名会话且存活，先安全关闭
        if sid in self.sessions:
            old = self.sessions[sid]
            old.terminate()

        session = TerminalSession(
            session_id=sid,
            title=title,
            cwd=cwd,
            rows=rows,
            cols=cols,
        )
        session.start()
        self.sessions[sid] = session
        return session

    def restart_session(
        self,
        session_id: str,
        title: Optional[str] = None,
        cwd: Optional[str] = None,
        rows: Optional[int] = None,
        cols: Optional[int] = None,
    ) -> TerminalSession:
        """热重启会话：保留所有活动的前端 WebSocket 连接与订阅流，直接拉起全新 Shell"""
        existing = self.sessions.get(session_id)
        if existing:
            existing.restart(title=title, cwd=cwd, rows=rows, cols=cols)
            return existing
        return self.create_session(
            session_id=session_id,
            title=title,
            cwd=cwd,
            rows=rows or 24,
            cols=cols or 80,
        )

    def get_or_create_session(
        self,
        session_id: str,
        title: Optional[str] = None,
        cwd: Optional[str] = None,
        rows: int = 24,
        cols: int = 80,
    ) -> TerminalSession:
        existing = self.sessions.get(session_id)
        if existing and existing.is_alive():
            return existing

        if existing and not existing.is_alive():
            existing.restart(title=title, cwd=cwd, rows=rows, cols=cols)
            return existing

        # 如果会话不存在，则重新拉起
        return self.create_session(
            session_id=session_id,
            title=title,
            cwd=cwd,
            rows=rows,
            cols=cols,
        )

    def terminate_session(self, session_id: str) -> bool:
        session = self.sessions.pop(session_id, None)
        if session:
            session.terminate()
            return True
        return False

    def list_sessions(self) -> list[dict]:
        return [s.to_dict() for s in self.sessions.values()]

    def cleanup_all(self):
        """服务器停机或测试重置时清理全部终端进程"""
        for sid, session in list(self.sessions.items()):
            try:
                session.terminate()
            except Exception as e:
                logger.warning(f"Error terminating terminal {sid}: {e}")
        self.sessions.clear()
