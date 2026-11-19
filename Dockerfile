FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun deployment/prepare-assets.ts && bun run build

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
# Keep runtime dependencies: some packages currently needed at runtime are devDependencies.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/analyze/fonts ./analyze/fonts
COPY --from=build /app/app/dist ./app/dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts ./scripts
RUN mkdir -p /data/media && chown -R bun:bun /data
USER bun
EXPOSE 3000
CMD ["bun", "dist/server.js"]
