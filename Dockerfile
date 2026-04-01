FROM node:20-bullseye-slim AS oci-cli-builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && python3 -m venv /opt/oci-cli \
  && /opt/oci-cli/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/oci-cli/bin/pip install --no-cache-dir oci-cli \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

FROM node:20-bullseye-slim

ENV OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV OCI_DIR=/root/.oci
ENV PATH=/opt/oci-cli/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --from=oci-cli-builder /opt/oci-cli /opt/oci-cli

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data /root/.oci

EXPOSE 3000

CMD ["npm", "start"]
