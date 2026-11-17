FROM hmctsprod.azurecr.io/base/node:24-alpine AS base

USER root
RUN corepack enable
USER hmcts

FROM base AS dependencies

WORKDIR /app
USER root
RUN chown -R hmcts:hmcts /app
USER hmcts

COPY --chown=hmcts:hmcts package.json yarn.lock .yarnrc.yml ./

RUN yarn install --immutable

FROM dependencies AS build

WORKDIR /app

COPY --chown=hmcts:hmcts tsconfig.json tsconfig.build.json ./
COPY --chown=hmcts:hmcts src ./src

RUN yarn build

FROM base AS runtime

# Writer is the only LibreOffice component conversion needs. The metric-compatible families (Liberation for
# Arial/Times New Roman/Courier New, Carlito for Calibri) stand in for the Microsoft fonts, and Cambria falls back
# to a serif face because Alpine has no Caladea package.
USER root
RUN apk add --no-cache \
      libreoffice-writer \
      fontconfig \
      font-liberation \
      font-carlito \
      font-dejavu \
      font-opensans \
      font-freefont \
    && fc-cache -f

WORKDIR /app
RUN chown -R hmcts:hmcts /app
USER hmcts

# The pod runs as uid 1000 but nothing outside /tmp is guaranteed writable, so LibreOffice's user profile and
# every other runtime write go there.
ENV NODE_ENV=production \
    HOME=/tmp \
    SOFFICE_PROFILE_DIR=/tmp/lo-profile

COPY --chown=hmcts:hmcts package.json yarn.lock .yarnrc.yml ./
RUN yarn workspaces focus --production 2>/dev/null || yarn install --immutable

COPY --from=build --chown=hmcts:hmcts /app/dist ./dist

EXPOSE 8080

CMD ["node", "dist/server.js"]
