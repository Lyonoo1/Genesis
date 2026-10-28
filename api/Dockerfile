FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    UV_LINK_MODE=copy

# 补充基础依赖、Node.js 运行时与安装 uv (配置国内镜像源加速)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    procps \
    nodejs \
    npm \
    && npm install -g pnpm --registry=https://registry.npmmirror.com \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple uv

WORKDIR /app

# 先复制依赖定义，利用 Docker 缓存层
COPY pyproject.toml uv.lock ./

# 使用国内 PyPI 源安装依赖
RUN uv sync --frozen --no-dev --default-index https://pypi.tuna.tsinghua.edu.cn/simple

# 复制源码
COPY . .

ENV PATH="/app/.venv/bin:$PATH"
ENV PORT=8000

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
