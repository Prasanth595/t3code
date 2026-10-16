FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache docker-cli \
  && mkdir -p /var/lib/subpolar \
  && chown bun:bun /var/lib/subpolar

WORKDIR /opt/codewise
COPY --chown=bun:bun packages/subpolar-environments/package.json ./packages/subpolar-environments/package.json
COPY --chown=bun:bun packages/subpolar-environments/src ./packages/subpolar-environments/src

ENV SUBPOLAR_MANAGER_HOST=0.0.0.0 \
    SUBPOLAR_MANAGER_PORT=8787 \
    SUBPOLAR_REGISTRATION_FILE=/var/lib/subpolar/environments.json

USER bun
EXPOSE 8787
ENTRYPOINT ["bun", "run", "packages/subpolar-environments/src/manager-cli.ts"]
