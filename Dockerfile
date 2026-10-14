# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
# Manifests + lockfile first so the dependency layer is cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Self-contained, prod-only copy of the server package (node_modules incl. the
# workspace dep @chartmate/shared with its dist, plus apps/server/dist).
RUN pnpm deploy --filter @chartmate/server --prod /out

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Chartmate" \
      org.opencontainers.image.description="Self-hosted charting app (server + web UI)" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATABASE_URL=sqlite:/data/chartmate.db \
    CHARTMATE_WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/dist ./dist
COPY --from=build /repo/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/main.js"]
