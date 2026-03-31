FROM node:20-bullseye-slim

ENV OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV OCI_DIR=/root/.oci

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip bash ca-certificates groff less \
  && pip3 install --no-cache-dir oci-cli \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data /root/.oci

EXPOSE 3000

CMD ["npm", "start"]
