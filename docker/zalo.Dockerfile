FROM node:22-bookworm-slim AS builder
WORKDIR /build
RUN corepack enable pnpm && corepack prepare pnpm@10.14.0 --activate
COPY packages/dsh-zalo/package.json packages/dsh-zalo/pnpm-lock.yaml packages/dsh-zalo/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY packages/dsh-zalo/ ./
# Production install without peers: dsh packages resolve from the dsh installation at runtime.
RUN pnpm run build \
 && rm -rf node_modules \
 && pnpm install --prod --no-frozen-lockfile --ignore-scripts --config.auto-install-peers=false

FROM node:22-bookworm-slim
ARG DSH_VERSION=0.2.0-rc.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @deepseek-ai/dsh@${DSH_VERSION}
ENV DSH_HOME=/dsh-home
# User skills live in the volume so they survive container recreation.
ENV DSH_AGENTS_HOME=/dsh-home/.agents
ENV DSH_PROFILE=zalo
# The profile template lives outside the volume so image rebuilds refresh it.
COPY profile/zalo/ /opt/dsh-zalo/profile/
COPY --from=builder /build/package.json /build/cordis.patch.yml /opt/dsh-zalo/profile/node_modules/dsh-zalo/
COPY --from=builder /build/lib /opt/dsh-zalo/profile/node_modules/dsh-zalo/lib
COPY --from=builder /build/node_modules /opt/dsh-zalo/profile/node_modules/dsh-zalo/node_modules
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
