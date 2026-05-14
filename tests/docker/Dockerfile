FROM node:20-bookworm-slim

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    tmux \
    jq \
    unzip \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install yq
RUN curl -sL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install opencode
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:$PATH"

# Create working directories
RUN mkdir -p /plugin /work

WORKDIR /plugin
