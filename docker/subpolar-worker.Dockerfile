FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 subpolar \
  && useradd --uid 1000 --gid subpolar --create-home --home-dir /tmp/home --shell /bin/bash subpolar

COPY docker/subpolar-worker/worker.mjs /usr/local/lib/subpolar/worker.mjs
COPY docker/subpolar-worker/terminal-supervisor.mjs /usr/local/lib/subpolar/terminal-supervisor.mjs
RUN chmod 0555 /usr/local/lib/subpolar/worker.mjs /usr/local/lib/subpolar/terminal-supervisor.mjs

ENV HOME=/tmp/home TMPDIR=/tmp
USER 1000:1000
WORKDIR /workspace
CMD ["node", "-e", "setInterval(() => {}, 3600000)"]
