FROM node:22-bookworm-slim AS builder
WORKDIR /build
RUN corepack enable pnpm && corepack prepare pnpm@10.14.0 --activate
COPY packages/dsh-telegram/package.json packages/dsh-telegram/pnpm-lock.yaml packages/dsh-telegram/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY packages/dsh-telegram/ ./
RUN pnpm run build \
 && rm -rf node_modules \
 && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-bookworm-slim
ARG DSH_VERSION=0.1.5-rc.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @deepseek-ai/dsh@${DSH_VERSION}
ENV DSH_HOME=/dsh-home
# The profile template lives outside the volume so image rebuilds refresh it.
COPY profile/telegram/ /opt/dsh-telegram/profile/
COPY --from=builder /build/package.json /build/cordis.patch.yml /opt/dsh-telegram/profile/node_modules/dsh-telegram/
COPY --from=builder /build/lib /opt/dsh-telegram/profile/node_modules/dsh-telegram/lib
COPY --from=builder /build/node_modules /opt/dsh-telegram/profile/node_modules/dsh-telegram/node_modules
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /dsh-home /workspace /data \
 && chown -R node:node /dsh-home /workspace /data /opt/dsh-telegram
USER node
WORKDIR /workspace
ENTRYPOINT ["entrypoint.sh"]
CMD ["dsh", "--profile", "telegram"]
