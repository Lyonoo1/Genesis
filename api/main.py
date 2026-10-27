from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
import os

from core.config import settings
from core.exceptions import AppException, ErrorCode
from core.security import get_current_user, AuthenticatedUser
from fastapi import Depends
from routers.sessions import router as sessions_router
from routers.projects import router as projects_router
from routers.mcp import router as mcp_router
from routers.skills import router as skills_router
from routers.chat import router as chat_router
from routers.marketplace import router as marketplace_router
from routers.usage import router as usage_router
from routers.models import router as models_router
from routers.terminal import router as terminal_router
from routers.preview import router as preview_router
from contextlib import asynccontextmanager
from routers.bridge import router as bridge_router
from routers.db_viewer import router as db_viewer_router
from core.sqlite_db import init_sqlite_db

# 初始化本地持久化 SQLite 数据库体系
init_sqlite_db()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    from services.terminal_manager import TerminalManager
    TerminalManager.get_instance().cleanup_all()


is_dev = settings.ENVIRONMENT == "development"

app = FastAPI(
    title="Genesis AI 智能体工作台 Core API",
    version="0.1.0",
    docs_url="/docs" if is_dev else None,
    redoc_url="/redoc" if is_dev else None,
    lifespan=lifespan,
)

# 挂载业务路由
app.include_router(sessions_router, prefix="/api")
app.include_router(projects_router, prefix="/api")
app.include_router(mcp_router, prefix="/api")
app.include_router(skills_router, prefix="/api")
app.include_router(chat_router, prefix="/api")
app.include_router(marketplace_router, prefix="/api")
app.include_router(usage_router, prefix="/api")
app.include_router(models_router, prefix="/api")
app.include_router(terminal_router, prefix="/api")
app.include_router(bridge_router, prefix="/api")
app.include_router(preview_router, prefix="/api")
app.include_router(preview_router)

# 仅开发环境允许通过 Web 查看和执行任意 SQL
if is_dev:
    app.include_router(db_viewer_router)


# CORS 配置
origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
if settings.FRONTEND_URL and settings.FRONTEND_URL not in origins:
    origins.append(settings.FRONTEND_URL)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$" if is_dev else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 全局业务异常拦截器
@app.exception_handler(AppException)
async def app_exception_handler(request: Request, exc: AppException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": exc.code.value,
                "message": exc.message,
                "details": exc.details,
            }
        },
    )


# 请求参数校验异常拦截器
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": {
                "code": ErrorCode.VALIDATION_ERROR.value,
                "message": "请求参数校验失败",
                "details": exc.errors(),
            }
        },
    )


# 未捕获系统异常拦截器
@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": {
                "code": ErrorCode.INTERNAL_SERVER_ERROR.value,
                "message": "服务器内部未知错误",
                "details": str(exc) if settings.ENVIRONMENT == "development" else None,
            }
        },
    )


# 1. 存活健康探针
@app.get("/api/health", tags=["System"])
async def health_check():
    return {
        "status": "ok",
        "service": "genesis-core-api",
        "version": "0.1.0",
        "environment": settings.ENVIRONMENT,
    }


# 2. 认证探针测试端点 (用于 BE-Step 1 验收标准: 不带 Token 访问返回 401 统一结构)
@app.get("/api/auth/me", tags=["Auth"])
async def get_current_user_profile(
    user: AuthenticatedUser = Depends(get_current_user),
):
    return {
        "id": user.id,
        "email": user.email,
    }




if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=settings.PORT, reload=True)
