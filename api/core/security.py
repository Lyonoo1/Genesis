from uuid import UUID
from fastapi import Depends, Header, status
from typing import Optional
import jwt
from core.config import settings
from core.exceptions import AppException, ErrorCode


class AuthenticatedUser:
    def __init__(self, user_id: str, email: Optional[str] = None):
        self.id = user_id
        self.email = email


async def get_current_user(
    authorization: Optional[str] = Header(default=None),
) -> AuthenticatedUser:
    """提取并校验 Supabase JWT Token，注入当前登录用户实体"""
    if not authorization or not authorization.startswith("Bearer "):
        raise AppException(
            code=ErrorCode.UNAUTHORIZED,
            message="未提供有效的认证凭证 (Bearer Token)",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    token = authorization.split(" ", 1)[1].strip()

    try:
        # 若配置了 JWT_SECRET 则使用本地快速校验，否则解开 payload 读取 sub
        if settings.SUPABASE_JWT_SECRET:
            payload = jwt.decode(
                token,
                settings.SUPABASE_JWT_SECRET,
                algorithms=["HS256"],
                audience="authenticated",
            )
        else:
            # 开发或未配 secret 模式下解析未经验证的 header/claims (或依赖 Supabase client 远程校验)
            payload = jwt.decode(token, options={"verify_signature": False})

        user_id = payload.get("sub")
        if not user_id:
            raise AppException(
                code=ErrorCode.UNAUTHORIZED,
                message="Token payload 缺少用户唯一标识 (sub)",
                status_code=status.HTTP_401_UNAUTHORIZED,
            )

        return AuthenticatedUser(
            user_id=user_id,
            email=payload.get("email"),
        )
    except jwt.PyJWTError as e:
        raise AppException(
            code=ErrorCode.UNAUTHORIZED,
            message=f"JWT 凭证校验失效: {str(e)}",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
