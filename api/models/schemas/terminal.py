from pydantic import BaseModel, Field
from typing import Optional


class TerminalSessionInfo(BaseModel):
    id: str = Field(description="终端会话唯一标识")
    title: str = Field(description="会话名称/标签")
    cwd: str = Field(description="工作目录")
    pid: Optional[int] = Field(default=None, description="子进程 PID")
    is_alive: bool = Field(description="进程是否存活")
    created_at: str = Field(description="创建时间 ISO 格式")


class TerminalCreateRequest(BaseModel):
    id: Optional[str] = Field(default=None, description="指定终端会话 ID，缺省则自动生成")
    title: Optional[str] = Field(default=None, description="终端会话名称")
    cwd: Optional[str] = Field(default=None, description="终端初始工作目录")
    rows: int = Field(default=24, ge=1, le=500, description="初始终端行数")
    cols: int = Field(default=80, ge=1, le=1000, description="初始终端列数")


class TerminalResizeRequest(BaseModel):
    rows: int = Field(ge=1, le=500, description="终端行数")
    cols: int = Field(ge=1, le=1000, description="终端列数")
