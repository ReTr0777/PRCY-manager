# The server has no dependencies, so there is nothing to install.
FROM node:22-alpine

WORKDIR /app
COPY index.js ./
COPY package.json ./

ENV PRCY_DATA=/data
ENV PRCY_PORT=8787
VOLUME /data
EXPOSE 8787

# Fails the container if the process is up but not answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "index.js"]
