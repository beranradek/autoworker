FROM node:22-bookworm

ARG DEBIAN_FRONTEND=noninteractive

ARG JAVA_VERSION=25
ARG GRADLE_VERSION=8.14.5

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

RUN mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) ADOPTIUM_ARCH="x64" ;; \
      arm64) ADOPTIUM_ARCH="aarch64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && mkdir -p /opt/java \
  && curl -fsSL "https://api.adoptium.net/v3/binary/latest/${JAVA_VERSION}/ga/linux/${ADOPTIUM_ARCH}/jdk/hotspot/normal/eclipse" \
    -o /tmp/temurin.tgz \
  && tar -xzf /tmp/temurin.tgz -C /opt/java \
  && rm -f /tmp/temurin.tgz \
  && JAVA_DIR="$(ls -1d /opt/java/jdk-* | head -n 1)" \
  && mv "${JAVA_DIR}" "/opt/java/temurin-${JAVA_VERSION}" \
  && ln -s "/opt/java/temurin-${JAVA_VERSION}" /opt/java/current

ENV JAVA_HOME=/opt/java/current
ENV PATH="${JAVA_HOME}/bin:${PATH}"
RUN ln -sf "${JAVA_HOME}/bin/java" /usr/local/bin/java \
  && ln -sf "${JAVA_HOME}/bin/javac" /usr/local/bin/javac

RUN mkdir -p /opt/gradle \
  && curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
  && unzip -q /tmp/gradle.zip -d /opt/gradle \
  && rm -f /tmp/gradle.zip \
  && ln -s "/opt/gradle/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle

RUN npm install -g pnpm typescript @anthropic-ai/claude-code \
  && npm cache clean --force

COPY --chmod=755 docker/worker-run-issue-claude.sh /usr/local/bin/autoworker-claude-issue

RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node

ENV CHROME_BIN=/usr/bin/chromium
WORKDIR /workspace
RUN mkdir -p /workspace && chown -R node:node /workspace

USER node
ENTRYPOINT ["/usr/local/bin/autoworker-claude-issue"]

