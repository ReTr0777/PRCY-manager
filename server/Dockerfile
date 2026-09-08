# The server has no dependencies, so there is nothing to install.
FROM node:22-alpine

WORKDIR /app
COPY index.js launch.js ui.html package.json ./

ENV PRCY_DATA=/data
ENV PRCY_PORT=8787
VOLUME /data
EXPOSE 8787
# Only served when PRCY_PUBLIC_PORT is set: share-link downloads and nothing else.
EXPOSE 8788

# Fails the container if the process is up but not answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

# launch.js supervises the server so it can update and restart itself, and so
# a bad update can be rolled back from outside the process it replaced.
CMD ["node", "launch.js"]
