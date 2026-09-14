from enum import Enum
from typing import Any, Optional
from fastapi import HTTPException, status


class ErrorCode(str, Enum):
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    NOT_FOUND = "NOT_FOUND"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    SKILL_NOT_FOUND = "SKILL_NOT_FOUND"
    SKILL_TIMEOUT = "SKILL_TIMEOUT"
    SANDBOX_ERROR = "SANDBOX_ERROR"
    MCP_CONNECTION_ERROR = "MCP_CONNECTION_ERROR"
    MCP_TOOL_ERROR = "MCP_TOOL_ERROR"
    INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR"


class AppException(HTTPException):
    """全局统一业务异常基类"""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        status_code: int = status.HTTP_400_BAD_REQUEST,
        details: Optional[Any] = None,
    ):
        super().__init__(
            status_code=status_code,
            detail={
                "error": {
                    "code": code.value,
                    "message": message,
                    "details": details,
                }
            },
        )
        self.code = code
        self.message = message
        self.details = details
