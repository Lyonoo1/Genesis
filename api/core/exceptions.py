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
        status_code: Optional[int] = None,
        details: Optional[Any] = None,
    ):
        if status_code is None:
            if code in (
                ErrorCode.NOT_FOUND,
                ErrorCode.SESSION_NOT_FOUND,
                ErrorCode.SKILL_NOT_FOUND,
            ):
                status_code = status.HTTP_404_NOT_FOUND
            elif code == ErrorCode.UNAUTHORIZED:
                status_code = status.HTTP_401_UNAUTHORIZED
            elif code == ErrorCode.FORBIDDEN:
                status_code = status.HTTP_403_FORBIDDEN
            elif code == ErrorCode.VALIDATION_ERROR:
                status_code = status.HTTP_400_BAD_REQUEST
            elif code == ErrorCode.INTERNAL_SERVER_ERROR:
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
            else:
                status_code = status.HTTP_400_BAD_REQUEST

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
