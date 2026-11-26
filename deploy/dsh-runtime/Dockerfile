# 小信运维助手 DeepSeek Harness (DSH) runtime image.
#
# In-process DSH Cordis runtime + thin HTTP/SSE bridge on port 4096.
# Only the platform API accesses this container over the private Docker network.
# Build:
#   docker build -t opshelper/dsh-runtime:0.2.2-rc.5-r1 deploy/dsh-runtime
FROM node:22-bookworm-slim

# git 用于工作区操作，ripgrep 加速文件检索，ca-certificates 用于模型 HTTPS 调用，
# python3 + pip 供离线 Python 技能运行（如 python-docx / openpyxl / pdf）。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i \
            's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g; \
             s|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g; \
             s|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
            /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates dumb-init python3 python3-pip

# 预装技能所需的 Python 依赖（与离线交付约束保持一致）。
COPY requirements.txt /opt/opshelper-skill-requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    pip3 install --index-url https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple \
    --break-system-packages -r /opt/opshelper-skill-requirements.txt

# 离线可视化：pele 把 Mermaid 渲染为 SVG，构建期预装；智能体通过
# `pele-render in.mmd out.svg` 调用，运行时无需联网。
RUN --mount=type=cache,target=/root/.npm \
    npm install -g pele@1.13.0 \
    --registry=https://registry.npmmirror.com \
    --no-audit \
    --no-fund
COPY pele-render.mjs /usr/local/bin/pele-render
COPY diagram-theme.mjs /usr/local/bin/diagram-theme.mjs
RUN chmod 0755 /usr/local/bin/pele-render

# 安装锁版本的 DeepSeek Harness 与同进程 HTTP+SSE 桥接层。
# 离线环境所有 Cordis 插件与 OpenAI 兼容 provider (@deepseek-ai/dsh-llm-pi-ai)
# 均在构建期固化到 /opt/dsh-runtime/node_modules，运行时零联网依赖。
WORKDIR /opt/dsh-runtime
COPY package.json /opt/dsh-runtime/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev \
    --registry=https://registry.npmmirror.com \
    --no-audit \
    --no-fund
COPY cordis.yml /opt/dsh-runtime/cordis.yml
COPY src /opt/dsh-runtime/src

# Per-user writable workspace and persistent DSH state. Managed configuration
# is mounted read-only at /opt/opshelper.
RUN mkdir -p /workspace /state /opt/opshelper/config/dsh \
  && chown node:node /workspace /state
WORKDIR /workspace
USER node

ENV RUNTIME_PORT=4096 \
    RUNTIME_WORKING_DIR=/workspace \
    HOME=/home/node \
    DSH_HOME=/state/dsh-v1 \
    DSH_TELEMETRY_DISABLED=1 \
    OPSHELPER_MANAGED_DIR=/opt/opshelper

EXPOSE 4096

CMD ["dumb-init", "--", "node", "/opt/dsh-runtime/src/server.mjs"]
