FROM node:22-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

ARG GRADLE_VERSION=8.14.5
ARG OPENCODE_VERSION=1.15.10

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    bash \
    jq \
    ripgrep \
    zip \
    unzip \
    sudo \
    python3 \
    python3-pip \
    python3-venv \
    chromium \
    gnupg \
    dirmngr \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) via official apt repo
RUN mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Temurin 21 JDK via Adoptium apt repo (reliable; avoids the binary API download)
RUN wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public \
    | gpg --dearmor > /etc/apt/trusted.gpg.d/adoptium.gpg \
  && echo "deb https://packages.adoptium.net/artifactory/deb bookworm main" \
    > /etc/apt/sources.list.d/adoptium.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends temurin-21-jdk \
  && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/temurin-21
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Gradle binary distribution (avoid stale distro packages)
RUN mkdir -p /opt/gradle \
  && curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
  && unzip -q /tmp/gradle.zip -d /opt/gradle \
  && rm -f /tmp/gradle.zip \
  && ln -s "/opt/gradle/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate \
  && npm install -g typescript@6.0.3 opencode-ai@${OPENCODE_VERSION} \
  && npm cache clean --force

RUN mkdir -p /usr/local/lib/autoworker
COPY docker/worker-harness.mjs /usr/local/lib/autoworker/worker-harness.mjs
COPY docker/worker-run-issue.sh /usr/local/bin/autoworker-issue
RUN chmod 755 /usr/local/lib/autoworker/worker-harness.mjs /usr/local/bin/autoworker-issue

RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node

ENV CHROME_BIN=/usr/bin/chromium
WORKDIR /workspace
RUN chown -R node:node /workspace

USER node
ENTRYPOINT ["/usr/local/bin/autoworker-issue"]
