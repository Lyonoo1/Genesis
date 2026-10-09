from typing import Optional
from uuid import UUID
from fastapi import APIRouter, Depends, Query, status

from core.security import get_current_user, AuthenticatedUser
from core.exceptions import AppException, ErrorCode
from models.schemas.marketplace import (
    MarketplacePluginItem,
    PluginUploadDraft,
    PluginDraftResponse,
)
from models.schemas.skill import SkillInstallRequest, SkillManifest
from models.schemas.mcp import McpServerCreate
from repositories.skill_repository import SkillRepository
from repositories.mcp_repository import McpRepository
from repositories.plugin_repository import PluginRepository, plugin_repository

router = APIRouter(prefix="/marketplace", tags=["Marketplace & Plugins"])


def get_skill_repo() -> SkillRepository:
    return SkillRepository()


def get_mcp_repo() -> McpRepository:
    return McpRepository()


def get_plugin_repo() -> PluginRepository:
    return plugin_repository


# 官方预置精品插件库
OFFICIAL_MARKETPLACE_PLUGINS: list[dict] = [
    {
        "id": "frontend-skill",
        "name": "Frontend Skill",
        "category": "研发工作流",
        "type": "skill",
        "scope": "personal",
        "version": "1.3.0",
        "author": "Genesis Official",
        "description": "Design visually strong landing pages, web apps and components",
        "readme": "### Frontend Skill\n工业级前端构建与 Tailwind 视觉渲染技能...",
        "permissions": ["exec:sandbox", "read:file"],
        "downloads": 1420,
        "iconType": "cube",
        "storage_path": "official/frontend-skill.zip",
    },
    {
        "id": "code-review-pro",
        "name": "Code Review Pro",
        "category": "代码审查",
        "type": "skill",
        "scope": "system",
        "version": "2.0.1",
        "author": "Genesis Security Team",
        "description": "自动化静态代码检查、AST 复杂度分析与安全脆弱点扫描",
        "readme": "### Code Review Pro\n具备深度语法分析与潜在内存溢出排查能力...",
        "permissions": ["read:file"],
        "downloads": 2890,
        "iconType": "code",
        "storage_path": "official/code-review-pro.zip",
    },
    {
        "id": "github-mcp",
        "name": "GitHub Connector",
        "category": "系统集成",
        "type": "mcp",
        "scope": "personal",
        "version": "1.0.0",
        "author": "Model Context Protocol",
        "description": "无缝管理 GitHub 仓库、PR、Issue 与 Git 提交历史",
        "readme": "### GitHub MCP Server\n基于官方 MCP 规范标准实现的远程 GitHub 适配器...",
        "permissions": ["net:egress", "mcp:remote"],
        "downloads": 5310,
        "iconType": "git",
        "endpoint": "https://mcp.github.internal/sse",
    },
    {
        "id": "postgres-mcp",
        "name": "PostgreSQL Explorer",
        "category": "系统集成",
        "type": "mcp",
        "scope": "system",
        "version": "1.1.0",
        "author": "Genesis DB Team",
        "description": "安全执行 SQL 查询、元数据 DDL 探测与慢查询分析",
        "readme": "### PostgreSQL MCP\n连接并分析 PostgreSQL 实例...",
        "permissions": ["db:query", "mcp:remote"],
        "downloads": 980,
        "iconType": "database",
        "endpoint": "https://mcp.postgres.internal/sse",
    },
]


@router.get(
    "/plugins",
    response_model=list[MarketplacePluginItem],
    summary="查询应用市场插件与技能列表 (融合已安装状态)",
)
async def list_marketplace_plugins(
    search: Optional[str] = Query(None, description="关键词搜索"),
    category: Optional[str] = Query(None, description="分类标签过滤"),
    type: Optional[str] = Query(None, description="类别过滤: skill | mcp"),
    scope: Optional[str] = Query(None, description="作用域过滤: personal | system"),
    user: AuthenticatedUser = Depends(get_current_user),
    skill_repo: SkillRepository = Depends(get_skill_repo),
    mcp_repo: McpRepository = Depends(get_mcp_repo),
):
    # 查询当前用户的安装清单
    installed_skills = {s["name"] for s in await skill_repo.list_by_user(user.id)}
    installed_mcps = {m["name"] for m in await mcp_repo.list_by_user(user.id)}

    results: list[MarketplacePluginItem] = []
    for item in OFFICIAL_MARKETPLACE_PLUGINS:
        # 条件过滤
        if search and (
            search.lower() not in item["name"].lower()
            and search.lower() not in item["description"].lower()
        ):
            continue
        if category and item["category"] != category:
            continue
        if type and item["type"] != type:
            continue
        if scope and item["scope"] != scope:
            continue

        is_installed = (
            item["id"] in installed_skills or item["id"] in installed_mcps
        )

        results.append(
            MarketplacePluginItem(
                id=item["id"],
                name=item["name"],
                category=item["category"],
                type=item["type"],
                scope=item["scope"],
                version=item["version"],
                author=item["author"],
                description=item["description"],
                readme=item["readme"],
                permissions=item["permissions"],
                downloads=item["downloads"],
                iconType=item.get("iconType", "cube"),
                storage_path=item.get("storage_path"),
                installed=is_installed,
                auto_trigger=True,
            )
        )

    return results


@router.post(
    "/install/{plugin_id}",
    summary="从市场一键安装指定技能/插件",
)
async def install_plugin_from_market(
    plugin_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
    skill_repo: SkillRepository = Depends(get_skill_repo),
    mcp_repo: McpRepository = Depends(get_mcp_repo),
):
    # 查找插件定义
    plugin_meta = next(
        (p for p in OFFICIAL_MARKETPLACE_PLUGINS if p["id"] == plugin_id), None
    )
    if not plugin_meta:
        raise AppException(
            code=ErrorCode.NOT_FOUND,
            message=f"市场中未找到 ID 为 [{plugin_id}] 的插件",
        )

    p_type = plugin_meta["type"]
    if p_type == "skill":
        # 安装为 Skill
        install_in = SkillInstallRequest(
            name=plugin_meta["id"],
            version=plugin_meta["version"],
            storage_path=plugin_meta.get("storage_path") or f"skills/{plugin_id}.zip",
            manifest=SkillManifest(
                name=plugin_meta["id"],
                version=plugin_meta["version"],
                description=plugin_meta["description"],
                entrypoint="main.py",
                permissions=plugin_meta["permissions"],
            ),
            auto_trigger=True,
        )
        await skill_repo.install(user.id, install_in)
    else:
        # 安装为 MCP 连接
        mcp_in = McpServerCreate(
            name=plugin_meta["id"],
            connection_type="remote_url",
            endpoint=plugin_meta.get("endpoint", "https://localhost:8080/sse"),
            enabled=True,
        )
        await mcp_repo.create(user.id, mcp_in)

    return {"success": True, "message": f"插件 [{plugin_meta['name']}] 安装成功"}


@router.delete(
    "/uninstall/{plugin_id}",
    summary="一键卸载指定技能/插件",
)
async def uninstall_plugin_from_market(
    plugin_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
    skill_repo: SkillRepository = Depends(get_skill_repo),
    mcp_repo: McpRepository = Depends(get_mcp_repo),
):
    # 优先尝试在 skill 中删除
    skill = await skill_repo.get_by_name(user.id, plugin_id)
    if skill:
        await skill_repo.delete(user.id, UUID(skill["id"]))
        return {"success": True, "message": f"技能 [{plugin_id}] 已成功卸载"}

    # 尝试在 MCP 中删除
    mcp = await mcp_repo.get_by_name(user.id, plugin_id)
    if mcp:
        await mcp_repo.delete(user.id, UUID(mcp["id"]))
        return {"success": True, "message": f"MCP 节点 [{plugin_id}] 已成功卸载"}

    raise AppException(
        code=ErrorCode.NOT_FOUND,
        message=f"未找到用户已安装的插件 [{plugin_id}]",
    )


# ----------------------------------------------------------------------
# 自研插件草稿接口
# ----------------------------------------------------------------------


@router.post(
    "/my-plugins/upload",
    response_model=PluginDraftResponse,
    status_code=status.HTTP_201_CREATED,
    summary="保存或上传自研插件草稿",
)
async def upload_plugin_draft(
    draft_in: PluginUploadDraft,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: PluginRepository = Depends(get_plugin_repo),
):
    created = await repo.create_draft(user.id, draft_in)
    return created


@router.get(
    "/my-plugins",
    response_model=list[PluginDraftResponse],
    summary="获取当前用户的自研插件列表",
)
async def list_my_plugins(
    user: AuthenticatedUser = Depends(get_current_user),
    repo: PluginRepository = Depends(get_plugin_repo),
):
    return await repo.list_by_user(user.id)
