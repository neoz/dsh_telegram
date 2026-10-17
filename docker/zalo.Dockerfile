FROM node:22-bookworm-slim AS builder
WORKDIR /build
RUN corepack enable pnpm && corepack prepare pnpm@10.14.0 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/dsh-chat/package.json packages/dsh-chat/
COPY packages/dsh-telegram/package.json packages/dsh-telegram/
COPY packages/dsh-zalo/package.json packages/dsh-zalo/
RUN pnpm install --frozen-lockfile
COPY packages/ packages/
# Production copies without peers: dsh packages and dsh-chat resolve from the profile at runtime.
RUN pnpm --filter dsh-chat --filter dsh-zalo run build \
 && pnpm --filter dsh-chat deploy --legacy --prod --config.auto-install-peers=false /out/dsh-chat \
 && pnpm --filter dsh-zalo deploy --legacy --prod --config.auto-install-peers=false /out/dsh-zalo

FROM node:22-bookworm-slim
ARG DSH_VERSION=0.2.0-rc.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @deepseek-ai/dsh@${DSH_VERSION}
ENV DSH_HOME=/dsh-home
# User skills live in the volume so they survive container recreation.
ENV DSH_AGENTS_HOME=/dsh-home/.agents
# Skill scripts run on the venv the entrypoint keeps in the volume, so packages pip installs survive image rebuilds.
ENV PATH=/dsh-home/.venv/bin:$PATH
ENV DSH_PROFILE=zalo
# The profile template lives outside the volume so image rebuilds refresh it.
COPY profile/zalo/ /opt/dsh-zalo/profile/
COPY --from=builder /out/dsh-chat /opt/dsh-zalo/profile/node_modules/dsh-chat
COPY --from=builder /out/dsh-zalo /opt/dsh-zalo/profile/node_modules/dsh-zalo
# Extra profile bundles: pinned registry tarballs whose only dependencies are already in the dsh closure.
ARG SEARXNG_PLUGIN_VERSION=0.5.1
RUN mkdir -p /tmp/bundles /opt/dsh-zalo/profile/node_modules/dsh-web-search-searxng  && cd /tmp/bundles  && npm pack dsh-web-search-searxng@${SEARXNG_PLUGIN_VERSION} --silent  && tar -xzf dsh-web-search-searxng-*.tgz -C /opt/dsh-zalo/profile/node_modules/dsh-web-search-searxng --strip-components=1  && rm -rf /tmp/bundles
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /dsh-home /workspace /data \
 && chown -R node:node /dsh-home /workspace /data /opt/dsh-zalo
# Starts as root so the entrypoint can fix bind-mount ownership; it drops to node before exec.
WORKDIR /workspace
ENTRYPOINT ["entrypoint.sh"]
CMD ["dsh", "--profile", "zalo"]
