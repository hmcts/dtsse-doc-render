FROM alpine:3.22
RUN apk add --no-cache poppler-utils imagemagick bash
COPY analyse.sh /usr/local/bin/analyse
ENTRYPOINT ["/usr/local/bin/analyse"]
