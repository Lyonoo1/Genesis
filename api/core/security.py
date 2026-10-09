from uuid import UUID
from fastapi import Depends, Header, status
from typing import Optional
import jwt
from jwt import PyJWKClient
from core.config import settings
from core.exceptions import AppException, ErrorCode


class AuthenticatedUser:
    def __init__(self, user_id: str, email: Optional[str] = None):
        self.id = user_id
        self.email = email


_jwks_client: Optional[PyJWKClient] = None


def get_jwks_client() -> Optional[PyJWKClient]:
    global _jwks_client
    if _jwks_client is None and settings.SUPABASE_URL and "placeholder" not in settings.SUPABASE_URL:
        jwks_url = f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1/.well-known/jwks.json"
        try:
            _jwks_client = PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=3600)
        except Exception:
            _jwks_client = None
    return _jwks_client


async def get_current_user(
    authorization: Optional[str] = Header(default=None),
) -> AuthenticatedUser:
    """提取并校验 Supabase JWT Token，注入当前登录用户实体"""
    default_dev_user = AuthenticatedUser(
        user_id="00000000-0000-0000-0000-000000000001",
        email="developer@genesis.local",
    )
    if not authorization or not authorization.startswith("Bearer "):
        raise AppException(
            code=ErrorCode.UNAUTHORIZED,
            message="未提供有效的认证凭证 (Bearer Token)",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    token = authorization.split(" ", 1)[1].strip()

    # 基础格式校验 (防格式畸形注入)
    if len(token.split(".")) != 3:
        raise AppException(
            code=ErrorCode.UNAUTHORIZED,
            message="JWT 凭证结构非法",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    try:
        unverified_header = jwt.get_unverified_header(token)
        alg = unverified_header.get("alg", "HS256")
        payload = None

        if alg == "ES256":
            jwks = get_jwks_client()
            if jwks:
                try:
                    signing_key = jwks.get_signing_key_from_jwt(token)
                    payload = jwt.decode(
                        token,
                        signing_key.key,
                        algorithms=["ES256"],
                        audience="authenticated",
                        options={"verify_exp": True},
                    )
                except Exception:
                    payload = None
        elif alg == "HS256" and settings.SUPABASE_JWT_SECRET and "placeholder" not in settings.SUPABASE_JWT_SECRET:
            try:
                payload = jwt.decode(
                    token,
                    settings.SUPABASE_JWT_SECRET,
                    algorithms=["HS256"],
                    audience="authenticated",
                    options={"verify_exp": True},
                )
            except Exception:
                payload = None

        if payload is None:
            # 开发环境或备用容错，校验 exp 和 payload 结构
            if settings.ENVIRONMENT == "development":
                payload = jwt.decode(
                    token,
                    options={"verify_signature": False, "verify_exp": True},
                )
            else:
                raise AppException(
                    code=ErrorCode.UNAUTHORIZED,
                    message="JWT 凭证校验失效或被篡改",
                    status_code=status.HTTP_401_UNAUTHORIZED,
                )

        user_id = payload.get("sub")
        if not user_id:
            raise ValueError("Token missing 'sub' claim")

        return AuthenticatedUser(
            user_id=str(user_id),
            email=payload.get("email"),
        )
    except jwt.ExpiredSignatureError:
        raise AppException(
            code=ErrorCode.UNAUTHORIZED,
            message="认证凭证已过期，请重新登录",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    except AppException:
        raise
    except Exception as e:
        if settings.ENVIRONMENT == "development" and token == "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJhdWQiOiJhdXRoZW50aWNhdGVkIn0.lGXBlw88KDDIwcFCUxL0_qvZdrgDQCCqFH044XZ3_9o":
            return default_dev_user
        raise AppException(
            code=ErrorCode.UNAUTHORIZED,
            message="JWT 凭证校验失效或被篡改",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
