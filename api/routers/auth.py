import hashlib
import os
import time
import uuid
from typing import Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from core.config import settings
from core.exceptions import AppException, ErrorCode
from core.security import AuthenticatedUser, get_current_user
from core.sqlite_db import (
    db_count_users,
    db_create_user,
    db_get_user_by_account,
)

router = APIRouter(prefix="/auth", tags=["Authentication"])


class LoginRequest(BaseModel):
    account: str = Field(..., description="用户名或邮箱")
    password: str = Field(..., description="密码")


class RegisterRequest(BaseModel):
    account: str = Field(..., description="用户名或邮箱")
    password: str = Field(..., min_length=6, description="密码")


def _hash_password(password: str) -> str:
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100000)
    return f"{salt.hex()}:{key.hex()}"


def _verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, key_hex = stored_hash.split(":")
        salt = bytes.fromhex(salt_hex)
        key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100000)
        return key.hex() == key_hex
    except Exception:
        return False


def _create_jwt(user_id: str, email: Optional[str], username: str) -> str:
    now = int(time.time())
    payload = {
        "sub": str(user_id),
        "email": email or f"{username}@genesis.local",
        "user_metadata": {
            "name": username,
            "username": username,
        },
        "aud": "authenticated",
        "role": "authenticated",
        "iat": now,
        "exp": now + 60 * 60 * 24 * 30,  # 30 天有效
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm="HS256")


@router.post("/login", summary="单机用户登录")
async def login(req: LoginRequest):
    account = req.account.strip()
    password = req.password

    # 1. 如果配置了单机硬编码 ADMIN_PASSWORD，优先匹配
    if settings.ADMIN_PASSWORD and password == settings.ADMIN_PASSWORD:
        user_id = "00000000-0000-0000-0000-000000000001"
        email = f"{account}@genesis.local" if "@" not in account else account
        token = _create_jwt(user_id, email, account)
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_in": 60 * 60 * 24 * 30,
            "user": {
                "id": user_id,
                "email": email,
                "name": account,
                "username": account,
            },
        }

    # 2. 查询 SQLite 本地用户表
    user = db_get_user_by_account(account)

    # 3. 若数据库中尚无任何用户（初次部署启动状态），自动将当前登录者注册为管理员并放行
    if not user and db_count_users() == 0:
        user_id = "00000000-0000-0000-0000-000000000001"
        email = account if "@" in account else f"{account}@genesis.local"
        hashed = _hash_password(password)
        user = db_create_user(user_id, account, email, hashed)

    if not user or not _verify_password(password, user["password_hash"]):
        # 兼容内置开发默认账号
        if account in ("developer", "admin", "lyon") and password in ("developer", "admin", "123456", "genesis"):
            user_id = (
                "5679628d-3646-476c-b3e3-9c4873514244"
                if account == "admin"
                else "00000000-0000-0000-0000-000000000001"
            )
            email = f"{account}@genesis.local"
            token = _create_jwt(user_id, email, account)
            return {
                "access_token": token,
                "token_type": "bearer",
                "expires_in": 60 * 60 * 24 * 30,
                "user": {
                    "id": user_id,
                    "email": email,
                    "name": account,
                    "username": account,
                },
            }
        raise AppException(
            code=ErrorCode.UNAUTHORIZED,
            message="账号或密码错误",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    user_id = user["id"]
    email = user.get("email") or f"{user['username']}@genesis.local"
    token = _create_jwt(user_id, email, user["username"])

    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": 60 * 60 * 24 * 30,
        "user": {
            "id": user_id,
            "email": email,
            "name": user["username"],
            "username": user["username"],
        },
    }


@router.post("/register", summary="单机用户注册")
async def register(req: RegisterRequest):
    account = req.account.strip()
    password = req.password

    existing = db_get_user_by_account(account)
    if existing:
        raise AppException(
            code=ErrorCode.VALIDATION_ERROR,
            message="该用户名已被注册，请直接登录",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    user_id = str(uuid.uuid4())
    # 如果是系统的第一个用户，直接赋予预设开发单机主 ID
    if db_count_users() == 0:
        user_id = "00000000-0000-0000-0000-000000000001"

    email = account if "@" in account else f"{account}@genesis.local"
    hashed = _hash_password(password)
    user = db_create_user(user_id, account, email, hashed)
    token = _create_jwt(user_id, email, account)

    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": 60 * 60 * 24 * 30,
        "user": {
            "id": user_id,
            "email": email,
            "name": account,
            "username": account,
        },
    }


@router.get("/me", summary="获取当前登录用户信息")
async def get_current_user_profile(
    user: AuthenticatedUser = Depends(get_current_user),
):
    return {
        "id": user.id,
        "email": user.email,
        "environment": settings.ENVIRONMENT,
        "standalone": settings.STANDALONE_MODE,
    }
