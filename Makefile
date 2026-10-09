# ==============================================================================
# Genesis 项目统一工程调度 Makefile
# ==============================================================================

SHELL := /bin/bash
.PHONY: help dev dev-api dev-web install test test-api test-web build clean docker-up docker-down

help:
	@echo "Genesis 命令集:"
	@echo "  make dev          - 一键启动本地前后端 (带端口与环境检查)"
	@echo "  make dev-api      - 仅启动 FastAPI 后端 (:8000)"
	@echo "  make dev-web      - 仅启动 Next.js 前端 (:3000)"
	@echo "  make install      - 安装前后端所有依赖 (uv + pnpm)"
	@echo "  make test         - 执行前后端全量测试与校验"
	@echo "  make build        - 构建前端生产包"
	@echo "  make clean        - 清理缓存、日志与临时沙箱目录"
	@echo "  make docker-up    - 启动 Docker Compose 容器编排"
	@echo "  make docker-down  - 停止 Docker Compose 容器编排"

# 本地联调
dev:
	@chmod +x ./scripts/dev.sh
	@./scripts/dev.sh

dev-api:
	cd api && uv run uvicorn main:app --reload --port 8000

dev-web:
	cd web && pnpm dev

# 依赖安装
install:
	@echo "安装后端 Python 依赖 (uv)..."
	cd api && uv sync
	@echo "安装前端 Node.js 依赖 (pnpm)..."
	cd web && pnpm install

# 测试与校验
test: test-api test-web

test-api:
	@echo "运行后端单测..."
	cd api && uv run pytest

test-web:
	@echo "运行前端类型检查与 Lint..."
	cd web && pnpm lint

# 生产构建
build:
	cd web && pnpm build

# 缓存清理
clean:
	@echo "清理临时产物..."
	rm -rf web/.next
	rm -rf api/__pycache__ api/*/__pycache__ api/*/*/__pycache__
	rm -rf api/.pytest_cache
	rm -rf /tmp/genesis/sandboxes/*
	@echo "清理完成。"

# Docker 容器编排
docker-up:
	docker compose up --build -d

docker-down:
	docker compose down
