#!/usr/bin/env bash
set -e

# ==============================================================================
# Genesis 项目生产环境一键发布脚本 (腾讯云 Lighthouse 适用)
# ==============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[Genesis DEPLOY]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[Genesis WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[Genesis ERROR]${NC} $1"
}

# 0. 权限自适应 (适配 root 或 ubuntu/lighthouse 用户)
SUDO=""
if [ "$EUID" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
    else
        log_error "请使用 root 用户或确保当前用户具有 sudo 权限！"
        exit 1
    fi
fi

# 1. 检查 Docker 及 Docker Compose
if ! command -v docker >/dev/null 2>&1; then
    log_warn "未检测到 Docker，正在自动安装 (使用国内加速源)..."
    curl -fsSL https://get.docker.com | $SUDO bash -s docker --mirror Aliyun
    $SUDO systemctl enable docker
    $SUDO systemctl start docker
    # 将当前用户加入 docker 组
    if [ "$EUID" -ne 0 ]; then
        $SUDO usermod -aG docker "$USER" || true
    fi
fi

if ! docker compose version >/dev/null 2>&1; then
    log_warn "未检测到 docker compose plugin，正在安装..."
    if command -v apt-get >/dev/null 2>&1; then
        $SUDO apt-get update && $SUDO apt-get install -y docker-compose-plugin
    elif command -v yum >/dev/null 2>&1; then
        $SUDO yum install -y docker-compose-plugin
    fi
fi

# 2. 检查国内镜像加速配置
if [ ! -f /etc/docker/daemon.json ]; then
    log_info "配置 Docker 国内加速镜像源..."
    $SUDO mkdir -p /etc/docker
    cat <<EOF | $SUDO tee /etc/docker/daemon.json >/dev/null
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.com",
    "https://mirror.ccs.tencentyun.com"
  ]
}
EOF
    $SUDO systemctl daemon-reload && $SUDO systemctl restart docker || true
fi

# 3. 环境变量准备
if [ ! -f "${ROOT_DIR}/api/.env" ]; then
    if [ -f "${ROOT_DIR}/api/.env.example" ]; then
        log_warn "未检测到 api/.env，已自动基于 .env.example 创建，请在上线后核验大模型 API Key！"
        cp "${ROOT_DIR}/api/.env.example" "${ROOT_DIR}/api/.env"
    else
        touch "${ROOT_DIR}/api/.env"
    fi
fi

# 确保生产环境标记生效
if grep -q "ENVIRONMENT=" "${ROOT_DIR}/api/.env"; then
    sed -i.bak 's/ENVIRONMENT=development/ENVIRONMENT=production/g' "${ROOT_DIR}/api/.env" && rm -f "${ROOT_DIR}/api/.env.bak"
else
    echo "ENVIRONMENT=production" >> "${ROOT_DIR}/api/.env"
fi

# 4. 执行全量容器构建与无缝拉起
DOCKER_COMPOSE="docker compose"
if ! docker ps >/dev/null 2>&1; then
    DOCKER_COMPOSE="$SUDO docker compose"
fi

log_info "开始构建生产镜像并启动编排容器..."
$DOCKER_COMPOSE -f docker-compose.prod.yml down --remove-orphans || true
$DOCKER_COMPOSE -f docker-compose.prod.yml up --build -d

# 5. 健康检查探针
log_info "等待服务就绪 (最大等待 30 秒)..."
READY=0
for i in {1..15}; do
    sleep 2
    if curl -s http://127.0.0.1/api/health | grep -q "genesis-core-api"; then
        READY=1
        break
    fi
    echo -n "."
done

echo ""
if [ $READY -eq 1 ]; then
    PUBLIC_IP=$(curl -s ifconfig.me || hostname -I | awk '{print $1}')
    log_info "🎉 Genesis 生产服务部署成功！"
    echo -e "${CYAN}======================================================${NC}"
    echo -e "访问控制台:  http://${PUBLIC_IP}"
    echo -e "后端健康接口: http://${PUBLIC_IP}/api/health"
    echo -e "容器状态查看: docker compose -f docker-compose.prod.yml ps"
    echo -e "实时日志追踪: make prod-logs"
    echo -e "${CYAN}======================================================${NC}"
    log_info "注意：请确保腾讯云 Lighthouse 控制台已放通 80 端口防火墙规则！"
else
    log_error "健康检查未通过，正在输出近期容器日志排查："
    $DOCKER_COMPOSE -f docker-compose.prod.yml logs --tail=50
    exit 1
fi
