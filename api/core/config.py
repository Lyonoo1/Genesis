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

    # Supabase Credentials (可选：已开启纯单机模式支持脱机)
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

    # Standalone Mode & Local Auth (单机自用架构)
    STANDALONE_MODE: bool = Field(
        default=True,
        description="是否开启单机自用模式（脱离外部 Supabase 依赖）",
    )
    JWT_SECRET: str = Field(
        default="genesis-standalone-secret-key-at-least-32chars",
        description="本地内置 JWT 签名密钥",
    )
    ADMIN_PASSWORD: Optional[str] = Field(
        default=None,
        description="单机管理员访问密码（为空时默认允许首位用户或免密/默认密码进入）",
    )

    @property
    def has_active_supabase(self) -> bool:
        """检查当前是否处于有效 Supabase 云端同步模式（单机模式或占位地址时直接短路）"""
        if self.STANDALONE_MODE:
            return False
        if not self.SUPABASE_URL:
            return False
        lower_url = self.SUPABASE_URL.lower()
        if "placeholder" in lower_url or "your-project" in lower_url:
            return False
        return True

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
