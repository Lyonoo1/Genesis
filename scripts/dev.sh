#!/usr/bin/env bash
set -e

# ==============================================================================
# Genesis 项目本地统一联调调度脚本
# - 检查依赖环境 (uv, pnpm)
# - 检查/初始化环境变量 (.env, .env.local)
# - 端口冲突检测与提示 (8000, 3000)
# - 并行拉起 API 与 Web
# - 优雅拦截 SIGINT / SIGTERM，彻底清理子进程避免端口残留
# ==============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="${ROOT_DIR}/api"
WEB_DIR="${ROOT_DIR}/web"

# 颜色输出
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[Genesis]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[Genesis WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[Genesis ERROR]${NC} $1"
}

# 1. 检查必要 CLI 工具
command -v uv >/dev/null 2>&1 || { log_error "'uv' 未安装，请先安装: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { log_error "'pnpm' 未安装，请先安装: npm install -g pnpm"; exit 1; }

# 2. 检查并补齐环境变量文件
if [ ! -f "${API_DIR}/.env" ]; then
    if [ -f "${API_DIR}/.env.example" ]; then
        log_warn "api/.env 不存在，已从 api/.env.example 自动生成副本，请按需填入 API Key"
        cp "${API_DIR}/.env.example" "${API_DIR}/.env"
    else
        log_error "api/.env 与 .env.example 均不存在！"
        exit 1
    fi
fi

if [ ! -f "${WEB_DIR}/.env.local" ]; then
    if [ -f "${WEB_DIR}/.env.example" ]; then
        log_warn "web/.env.local 不存在，已从 web/.env.example 自动生成副本"
        cp "${WEB_DIR}/.env.example" "${WEB_DIR}/.env.local"
    fi
fi

# 3. 检查端口占用
check_port() {
    local port=$1
    local name=$2
    local pid=$(lsof -ti :${port} 2>/dev/null || true)
    if [ -n "$pid" ]; then
        log_warn "检测到端口 :${port} (${name}) 已被进程 PID: ${pid} 占用！"
        read -p "是否强制释放端口 ${port} (kill -9 ${pid})? [y/N]: " confirm
        if [[ "$confirm" =~ ^[yY]$ ]]; then
            kill -9 ${pid} 2>/dev/null || true
            log_info "已释放端口 :${port}"
        else
            log_error "端口冲突，启动终止。"
            exit 1
        fi
    fi
}

check_port 8000 "FastAPI"
check_port 3000 "Next.js"

# 4. 进程管理与清理
API_PID=""
WEB_PID=""

cleanup() {
    echo ""
    log_info "收到终止信号，正在清理后台进程..."
    if [ -n "${API_PID}" ]; then
        kill -TERM "${API_PID}" 2>/dev/null || true
    fi
    if [ -n "${WEB_PID}" ]; then
        kill -TERM "${WEB_PID}" 2>/dev/null || true
    fi
    wait 2>/dev/null || true
    log_info "所有服务已平稳停止。"
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# 5. 启动服务
log_info "启动 FastAPI 后端 (http://127.0.0.1:8000)..."
(cd "${API_DIR}" && uv run uvicorn main:app --reload --port 8000 2>&1 | sed -e "s/^/${CYAN}[API]${NC} /") &
API_PID=$!

log_info "启动 Next.js 前端 (http://localhost:3000)..."
(cd "${WEB_DIR}" && pnpm dev 2>&1 | sed -e "s/^/\033[0;35m[WEB]${NC} /") &
WEB_PID=$!

log_info "🚀 Genesis 正在运行: 前端 -> http://localhost:3000 | 后端 -> http://localhost:8000/docs"
log_info "按下 Ctrl+C 停止所有服务。"

# 挂起等待任一子进程退出
wait -n ${API_PID} ${WEB_PID}
