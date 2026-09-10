# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json ./
COPY apps/egressd/package.json apps/egressd/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/egressd apps/egressd
COPY apps/web apps/web
RUN pnpm --filter @egresskit/app-web build \
    && pnpm --filter @egresskit/app-egressd build \
    && pnpm --filter @egresskit/app-egressd deploy --prod --legacy /opt/egresskit

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*
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
    url="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${asset}"; \
    node -e 'const fs = require("node:fs"); const url = process.argv[1]; fetch(url).then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.arrayBuffer(); }).then((body) => fs.writeFileSync("/tmp/mihomo.gz", Buffer.from(body)));' "$url"; \
    printf '%s  %s\n' "$checksum" /tmp/mihomo.gz | sha256sum -c -; \
    gzip --decompress /tmp/mihomo.gz; \
    install --mode=0755 /tmp/mihomo /usr/local/bin/mihomo; \
    rm /tmp/mihomo
COPY --from=build /opt/egresskit /opt/egresskit
COPY --from=build /workspace/apps/web/dist /opt/egresskit/web
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/egresskit/
COPY licenses/Mihomo-GPL-3.0.txt /usr/share/licenses/egresskit/Mihomo-GPL-3.0.txt
RUN mkdir --parents /var/lib/egresskit \
    && chown node:node /var/lib/egresskit
EXPOSE 8787
USER node
ENTRYPOINT ["node", "/opt/egresskit/dist/cli.js"]
