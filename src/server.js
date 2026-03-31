import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR;
const ociDir = process.env.OCI_DIR ?? "/root/.oci";

const app = createApp({ dataDir, ociDir });
await app.ready;

app.server.listen(port, () => {
  console.log(`OCI bot listening on http://0.0.0.0:${port}`);
});

async function shutdown() {
  await app.shutdown();
  app.server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
