from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Environment & Server
    ENVIRONMENT: str = Field(default="development", description="运行环境")
    PORT: int = Field(default=8000, description="服务监听端口")
    FRONTEND_URL: str = Field(
        default="http://localhost:3000",
        description="前端生产域名或本地开发地址",
    )

    # Supabase Credentials
    SUPABASE_URL: str = Field(
        default="https://your-project.supabase.co",
        description="Supabase 项目 URL",
    )
    SUPABASE_KEY: str = Field(
        default="your-supabase-service-or-anon-key",
        description="Supabase API 密钥",
    )
    SUPABASE_JWT_SECRET: Optional[str] = Field(
        default=None,
        description="Supabase JWT 签名 Secret，用于本地脱机高速验签",
    )

    # LLM API Keys & Base URLs
    OPENAI_API_KEY: Optional[str] = Field(
        default=None, description="OpenAI API 密钥"
    )
    OPENAI_BASE_URL: str = Field(
        default="https://api.openai.com/v1",
        description="OpenAI API Base URL (支持中转与第三方如 DeepSeek/Qwen)",
    )
    ANTHROPIC_API_KEY: Optional[str] = Field(
        default=None, description="Anthropic API 密钥"
    )
    ANTHROPIC_BASE_URL: str = Field(
        default="https://api.anthropic.com/v1",
        description="Anthropic API Base URL",
    )

    # Sandbox Config
    SANDBOX_TMP_DIR: str = Field(
        default="/tmp/genesis/sandboxes",
        description="本地容器 Skill 沙箱解压根目录",
    )
    SANDBOX_TIMEOUT_SECONDS: int = Field(
        default=30, description="沙箱单次运行超时硬上限 (秒)"
    )


settings = Settings()
