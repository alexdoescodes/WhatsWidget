'use strict';

const fs = require('node:fs');
const { buildConfig } = require('./config');
const { createStore } = require('./store');
const { createAuthenticator } = require('./auth-pam');
const { createWhatsAppClient } = require('./whatsapp');
const { createServer } = require('./server');

async function main() {
  const config = buildConfig();
  fs.mkdirSync(config.sessionDir, { recursive: true });

  const store = createStore({
    maxMessagesPerChat: config.maxMessagesPerChat,
    maxChats: config.maxChats,
  });
  const authenticator = createAuthenticator({ service: config.pamService });
  const client = createWhatsAppClient({ sessionDir: config.sessionDir, store });
  const server = createServer({ client, store, authenticator, endpointFile: config.endpointFile });

  const { port } = await server.listen();
  console.log(`whatsapp-widget backend listening on 127.0.0.1:${port}`);

  await client.start();

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
