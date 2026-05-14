FROM node:20-bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install bun (for fast installs)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install opencode CLI
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:$PATH"

# Copy plugin source into the image
COPY . /plugin
WORKDIR /plugin

# Build the plugin and deploy agents/commands into opencode config
RUN ./install.sh

# Workspace mount point for user projects
RUN mkdir -p /workspace
WORKDIR /workspace

CMD ["opencode"]
