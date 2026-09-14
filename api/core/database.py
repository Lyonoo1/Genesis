from functools import lru_cache
from supabase import create_client, Client
from core.config import settings


@lru_cache()
def get_supabase_client() -> Client:
    """获取 Supabase Client 单例工厂"""
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
