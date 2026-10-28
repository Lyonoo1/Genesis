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

# 2. 定位正在生效的站点配置文件 (必须在 sites-enabled 或 conf.d 下，避开 .bak 备份文件)
$SUDO python3 -c '
import glob, re, sys

snippet = """
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
"""

def insert_into_servers(content, snippet):
    result = []
    i = 0
    n = len(content)
    while i < n:
        m = re.search(r"server\s*\{", content[i:])
        if not m:
            result.append(content[i:])
            break
        brace_start = i + m.end() - 1
        result.append(content[i:brace_start + 1])
        depth = 1
        j = brace_start + 1
        while j < n and depth > 0:
            if content[j] == "{":
                depth += 1
            elif content[j] == "}":
                depth -= 1
            j += 1
        server_body = content[brace_start + 1 : j - 1]
        if "location /genesis/" not in server_body:
            server_body = server_body + "\n" + snippet + "\n"
        result.append(server_body)
        result.append("}")
        i = j
    return "".join(result)

patterns = ["/etc/nginx/sites-enabled/*", "/etc/nginx/conf.d/*.conf"]
target_files = []
for p in patterns:
    for f in glob.glob(p):
        if not re.search(r"\.(bak|old|swp|dpkg-.*)$", f):
            target_files.append(f)

if not target_files:
    print("NO_FILES_FOUND")
    sys.exit(0)

for f in target_files:
    with open(f, "r", encoding="utf-8") as fp:
        orig = fp.read()
    patched = insert_into_servers(orig, snippet)
    if patched != orig:
        with open(f, "w", encoding="utf-8") as fp:
            fp.write(patched)
        print(f"成功注入 /genesis 路由至激活配置: {f}")
    else:
        print(f"配置已包含 /genesis 路由，无需改动: {f}")
'

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
