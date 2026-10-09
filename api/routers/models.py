from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from typing import Optional, Any
from core.security import get_current_user, AuthenticatedUser
from core.sqlite_db import db_list_models, db_upsert_model, db_delete_model

router = APIRouter(prefix="/models", tags=["Model Configurations"])


class ModelConfigPayload(BaseModel):
    id: str
    name: str
    modelId: str
    provider: str = "openai"
    baseUrl: Optional[str] = ""
    apiKey: Optional[str] = ""
    isDefault: Optional[bool] = False
    temperature: Optional[float] = 0.7
    maxTokens: Optional[int] = 32768
    contextWindow: Optional[int] = 1048576


@router.get("", summary="获取当前用户已保存的模型配置列表")
async def list_models(user: AuthenticatedUser = Depends(get_current_user)):
    return db_list_models(user.id)


@router.post("", summary="保存或更新模型配置")
async def save_model(
    payload: ModelConfigPayload,
    user: AuthenticatedUser = Depends(get_current_user),
):
    saved = db_upsert_model(user.id, payload.model_dump())
    # 云端 Supabase 双写同步
    try:
        from core.database import get_supabase_client
        supabase = get_supabase_client()
        supabase.table("model_configs").upsert({
            "id": saved["id"],
            "user_id": str(user.id),
            "name": saved["name"],
            "model_id": saved["modelId"],
            "provider": saved["provider"],
            "base_url": saved["baseUrl"],
            "api_key": saved["apiKey"],
            "is_default": saved["isDefault"],
            "temperature": saved["temperature"],
            "max_tokens": saved["maxTokens"],
            "created_at": saved["created_at"],
            "updated_at": saved["updated_at"],
        }).execute()
    except Exception:
        pass
    return saved


@router.delete("/{model_id}", summary="删除指定的模型配置")
async def delete_model(
    model_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
):
    success = db_delete_model(user.id, model_id)
    try:
        from core.database import get_supabase_client
        supabase = get_supabase_client()
        supabase.table("model_configs").delete().eq("id", model_id).eq("user_id", str(user.id)).execute()
    except Exception:
        pass
    return {"success": success, "id": model_id}
