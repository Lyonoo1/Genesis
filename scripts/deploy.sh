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

# 0.1 内存防护：自动检测并配置 2GB Swap 虚拟内存 (防止 2G 内存机型构建 Next.js 时被 OOM 强杀)
if command -v free >/dev/null 2>&1; then
    SWAP_TOTAL=$(free -m | awk '/Swap:/ {print $2}')
    if [ "${SWAP_TOTAL:-0}" -lt 1024 ]; then
        log_info "检测到服务器 Swap 虚拟内存不足 1GB，正在自动创建 2GB 交换分区 (防构建 OOM)..."
        $SUDO fallocate -l 2G /swapfile 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 2>/dev/null
        $SUDO chmod 600 /swapfile
        $SUDO mkswap /swapfile 2>/dev/null
        $SUDO swapon /swapfile 2>/dev/null || true
        if ! grep -q "/swapfile" /etc/fstab 2>/dev/null; then
            echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
        fi
        log_info "Swap 虚拟内存已成功挂载！"
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

# 3.1 端口检测：检查宿主机是否已有原生 Nginx 占用 80 端口
TARGET_PORT="${GENESIS_PORT:-80}"
if [ -z "$GENESIS_PORT" ]; then
    if ss -lntp 2>/dev/null | grep -q ':80 ' || netstat -lntp 2>/dev/null | grep -q ':80 '; then
        log_warn "检测到宿主机 80 端口已有服务（如系统原生 Nginx）在监听！"
        log_info "为防端口冲突，Genesis 自动映射至端口 8888 (支持由宿主机 Nginx 转发并复用 SSL 证书)"
        TARGET_PORT=8888
        export GENESIS_PORT=8888

        # 自动安全挂载宿主机 Nginx 路由 (免去手动运行 setup_host_nginx.sh)
        if [ -f "${ROOT_DIR}/scripts/setup_host_nginx.sh" ]; then
            log_info "正在自动执行宿主机 Nginx 备份与 /genesis 路由挂载..."
            bash "${ROOT_DIR}/scripts/setup_host_nginx.sh" || true
        fi
    fi
fi

# 4. 执行全量容器构建与无缝拉起
DOCKER_COMPOSE="docker compose"
if ! docker ps >/dev/null 2>&1; then
    DOCKER_COMPOSE="$SUDO docker compose"
fi

log_info "开始构建生产镜像并启动编排容器 (监听端口: ${TARGET_PORT})..."
$DOCKER_COMPOSE -f docker-compose.prod.yml down --remove-orphans || true
$DOCKER_COMPOSE -f docker-compose.prod.yml up --build -d

# 5. 健康检查探针
log_info "等待服务就绪 (最大等待 30 秒)..."
READY=0
for i in {1..15}; do
    sleep 2
    if curl -s "http://127.0.0.1:${TARGET_PORT}/api/health" | grep -q "genesis-core-api"; then
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
    if [ "$TARGET_PORT" = "80" ]; then
        echo -e "访问控制台:   http://${PUBLIC_IP}"
        echo -e "域名访问:     http://petpalapp.cn"
    else
        echo -e "本地服务地址: http://127.0.0.1:${TARGET_PORT}"
        echo -e "说明: 宿主机已有原生 Nginx 占用 80 端口，可通过宿主机 Nginx 配置反代！"
    fi
    echo -e "后端健康接口: http://127.0.0.1:${TARGET_PORT}/api/health"
    echo -e "容器状态查看: docker compose -f docker-compose.prod.yml ps"
    echo -e "实时日志追踪: make prod-logs"
    echo -e "${CYAN}======================================================${NC}"
else
    log_error "健康检查未通过，正在输出近期容器日志排查："
    $DOCKER_COMPOSE -f docker-compose.prod.yml logs --tail=50
    exit 1
fi
