# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json ./
COPY apps/egressd/package.json apps/egressd/package.json
RUN pnpm install --frozen-lockfile
COPY apps/egressd apps/egressd
RUN pnpm --filter @egresskit/egressd build \
    && pnpm --filter @egresskit/egressd deploy --prod --legacy /opt/egresskit

FROM node:22-bookworm-slim AS runtime
ARG TARGETARCH
ARG MIHOMO_VERSION=v1.19.30
ARG MIHOMO_AMD64_SHA256=db214c7a2517e63c150d123178d16d102e03a241ccdae4e5e07ffbe9cf56c6f9
ARG MIHOMO_ARM64_SHA256=58896873736d28628f66de3677c8654fa0f180662523148e136cff4f6e890069
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz"; checksum="$MIHOMO_AMD64_SHA256" ;; \
      arm64) asset="mihomo-linux-arm64-${MIHOMO_VERSION}.gz"; checksum="$MIHOMO_ARM64_SHA256" ;; \
      *) echo "unsupported Docker architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install --no-install-recommends --yes ca-certificates curl; \
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output /tmp/mihomo.gz \
      "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${asset}"; \
    printf '%s  %s\n' "$checksum" /tmp/mihomo.gz | sha256sum -c -; \
    gzip --decompress /tmp/mihomo.gz; \
    install --mode=0755 /tmp/mihomo /usr/local/bin/mihomo; \
    rm /tmp/mihomo; \
    apt-get purge --auto-remove --yes curl; \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/egresskit /opt/egresskit
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/egresskit/
COPY licenses/Mihomo-GPL-3.0.txt /usr/share/licenses/egresskit/Mihomo-GPL-3.0.txt
RUN mkdir --parents /var/lib/egresskit \
    && chown node:node /var/lib/egresskit
ENV EGRESSKIT_STATE_DIRECTORY=/var/lib/egresskit
ENV EGRESSKIT_MIHOMO_BINARY=/usr/local/bin/mihomo
USER node
ENTRYPOINT ["node", "/opt/egresskit/dist/cli.js"]
