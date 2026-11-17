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

COPY --chown=hmcts:hmcts tsconfig.json tsconfig.build.json ./
COPY --chown=hmcts:hmcts src ./src

RUN yarn build

FROM dependencies AS production-dependencies

RUN yarn workspaces focus --production

FROM base AS runtime

# Writer, Calc and Impress are installed because uploads to /rs/convert include xlsx and pptx. Alpine's libreoffice-common drags in Qt6, GTK, GStreamer, Mesa/LLVM and Python for GUI, media and scripting
# features that a headless conversion never loads, so those packages' files are removed in the same
# layer as the install. The apk database still lists them; the smoke conversion below fails the build if a prune
# ever removes something Writer needs. The metric-compatible families (Liberation for Arial/Times New Roman/Courier
# New, Carlito for Calibri) stand in for the Microsoft fonts, and Cambria falls back to a serif face because Alpine
# has no Caladea package.
USER root
RUN apk add --no-cache \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-impress \
      tini \
      fontconfig \
      font-liberation \
      font-carlito \
      font-dejavu \
      font-opensans \
      font-freefont \
    && for pkg in $(apk list -I | sed 's/-[0-9][^ ]* .*//' | grep -E '^(llvm[0-9]*-libs|mesa(-.*)?|qt6-.*|gtk\+3\.0|gtk4\.0|gstreamer.*|gst-plugins-.*|flite|x265-libs|aom-libs|libSvtAv1Enc|openh264|openal-soft-libs|directfb|spirv-tools|python3(-.*)?)$'); do \
        apk info -L "$pkg" | grep -v ':$' | grep -v '^$' | sed 's|^|/|' | xargs -r rm -rf; \
      done \
    && cd /usr/lib/libreoffice \
    && rm -rf help program/classes program/libpyuno.so program/libpythonloaderlo.so program/pyuno* program/python* \
              share/config/images_*.zip share/gallery share/template share/wizards share/Scripts share/librelogo \
    && find share/config/soffice.cfg/modules -mindepth 1 -maxdepth 1 -not \( -name swriter -o -name scalc -o -name simpress -o -name sdraw \) -exec rm -rf {} + \
    && fc-cache -f

WORKDIR /app
RUN chown -R hmcts:hmcts /app
USER hmcts

# The pod runs as uid 1000 but nothing outside /tmp is guaranteed writable, so LibreOffice's user profile and
# every other runtime write go there.
ENV NODE_ENV=production \
    HOME=/tmp \
    SOFFICE_PROFILE_DIR=/tmp/lo-profile

RUN lo="soffice --headless --norestore --nologo --nolockcheck -env:UserInstallation=file:///tmp/smoke-profile" \
    && printf 'smoke test\n' > /tmp/smoke.txt \
    && printf 'a,b\n1,2\n' > /tmp/smoke-sheet.csv \
    && $lo --convert-to pdf --outdir /tmp /tmp/smoke.txt \
    && $lo --convert-to "xlsx:Calc MS Excel 2007 XML" --outdir /tmp /tmp/smoke-sheet.csv \
    && $lo --convert-to pdf --outdir /tmp /tmp/smoke-sheet.xlsx \
    && head -c 4 /tmp/smoke.pdf | grep -q %PDF \
    && head -c 4 /tmp/smoke-sheet.pdf | grep -q %PDF \
    && rm -rf /tmp/smoke*

COPY --chown=hmcts:hmcts package.json ./
COPY --from=production-dependencies --chown=hmcts:hmcts /app/node_modules ./node_modules
COPY --from=build --chown=hmcts:hmcts /app/dist ./dist

EXPOSE 8080

# A conversion that hits its timeout is killed as a process group, which leaves soffice.bin as a zombie that
# only PID 1 can reap. Node does not reap strangers, so tini runs as PID 1.
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]

CMD ["node", "dist/server.js"]
