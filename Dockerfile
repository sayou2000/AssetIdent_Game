# syntax=docker/dockerfile:1
# AssetIdent: The Handover Quest — static-site container
# Tiny nginx:alpine serves the prebuilt files; there is no build step.
# Image ~10 MB, game bundle ~180 KB.

FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="AssetIdent: The Handover Quest"
LABEL org.opencontainers.image.description="80s retro arcade marketing game about the FM handover gap"
LABEL org.opencontainers.image.version="2.0.1"
LABEL org.opencontainers.image.licenses="MIT"

# Static site files. og-image.png is the share card for LinkedIn/Slack previews.
COPY index.html style.css bundle.js og-image.png /usr/share/nginx/html/

# Server config + the shared header snippet it includes
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf

# NOTE: the master process still starts as root (it drops privileges for the
# workers). Port 8080 is used anyway so the container also runs on hosts that
# forbid privileged ports. For a genuinely rootless container switch the base image
# to nginxinc/nginx-unprivileged:1.27-alpine — it listens on 8080 already and keeps
# its pid and temp files under /tmp.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
