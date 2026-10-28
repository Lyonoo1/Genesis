#!/usr/bin/env bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[Genesis Setup]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[Genesis WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[Genesis ERROR]${NC} $1"; }

SUDO=""
if [ "$EUID" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
    else
        log_error "请使用 root 用户或确保具有 sudo 权限！"
        exit 1
    fi
fi

# 1. 备份现有的 Nginx 配置 (安全防线)
BACKUP_DIR="/root/nginx_backup/nginx_$(date +%Y%m%d_%H%M%S)"
log_info "1. 创建 Nginx 完整备份到: ${BACKUP_DIR} ..."
$SUDO mkdir -p "${BACKUP_DIR}"
$SUDO cp -r /etc/nginx/ "${BACKUP_DIR}/"
log_info "备份完成！如果后续需要回滚，可随时执行恢复。"

# 2. 定位包含 petpalapp.cn 或默认配置的 server 块文件
TARGET_CONF=""
for f in $(grep -rl "server_name.*petpalapp.cn" /etc/nginx/ 2>/dev/null); do
    if [ -f "$f" ]; then
        TARGET_CONF="$f"
        break
    fi
done

if [ -z "$TARGET_CONF" ]; then
    if [ -f /etc/nginx/sites-available/default ]; then
        TARGET_CONF="/etc/nginx/sites-available/default"
    elif [ -f /etc/nginx/conf.d/default.conf ]; then
        TARGET_CONF="/etc/nginx/conf.d/default.conf"
    fi
fi

if [ -z "$TARGET_CONF" ]; then
    log_error "未找到现有 Nginx 站点配置文件，请手动确认 /etc/nginx 路径！"
    exit 1
fi

log_info "2. 检测到宿主机 Nginx 配置文件: ${TARGET_CONF}"

# 3. 检查是否已经配置过 /genesis
if grep -q "location /genesis/" "$TARGET_CONF"; then
    log_warn "检测到 ${TARGET_CONF} 中已有 /genesis 路由配置，跳过重复写入。"
else
    log_info "3. 正在向 ${TARGET_CONF} 安全注入 /genesis 反向代理路由..."
    
    SNIPPET='
    # ==========================================
    # Genesis AI 智能体工作台专属路由 (独立隔离)
    # ==========================================
    location /genesis/ {
        proxy_pass http://127.0.0.1:8888;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location = /genesis {
        return 301 /genesis/;
    }
'

    # 使用 python 安全地在最后一个 server 块大括号前插入
    $SUDO python3 -c '
import sys

conf_path = sys.argv[1]
snippet = sys.argv[2]

with open(conf_path, "r", encoding="utf-8") as f:
    content = f.read()

last_brace = content.rfind("}")
if last_brace != -1:
    new_content = content[:last_brace] + snippet + "\n" + content[last_brace:]
    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    print("SUCCESS")
else:
    print("NO_BRACE")
' "$TARGET_CONF" "$SNIPPET"
fi

# 4. 测试语法并热重载
log_info "4. 校验 Nginx 配置语法..."
if $SUDO nginx -t; then
    log_info "Nginx 配置语法测试通过！执行平滑热重载 (不影响现有用户访问)..."
    $SUDO nginx -s reload
    log_info "🎉 宿主机 Nginx 已成功挂载 /genesis 反向代理路由！"
else
    log_error "Nginx 语法检查未通过，正在自动恢复初始备份..."
    $SUDO cp -r "${BACKUP_DIR}/nginx/"* /etc/nginx/
    $SUDO nginx -t
    log_warn "已恢复至初始配置，原有项目不受影响。"
    exit 1
fi
