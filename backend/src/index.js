'use strict';

const fs = require('node:fs');
const { buildConfig } = require('./config');
const { createStore } = require('./store');
const { createPersistence } = require('./persist');
const { createAvatarCache } = require('./avatars');
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
  // Load before the socket connects, so the widget has the previous chat list
  // immediately instead of an empty panel that fills in only if a sync lands.
  const persistence = createPersistence({ file: config.storeFile, store });
  persistence.load();
  persistence.start();

  const authenticator = createAuthenticator({ service: config.pamService });
  // Built here rather than inside the client so the socket it needs can be
  // handed over after connect; the client owns the socket, not this file.
  let avatars = null;
  const client = createWhatsAppClient({
    sessionDir: config.sessionDir,
    store,
    avatars: {
      ensure: (jid) => (avatars ? avatars.ensure(jid) : Promise.resolve('')),
    },
  });
  avatars = createAvatarCache({
    dir: config.avatarDir,
    fetchUrl: (jid, type) => client.profilePictureUrl(jid, type),
  });
  const server = createServer({ client, store, authenticator, endpointFile: config.endpointFile });

  const { port } = await server.listen();
  console.log(`whatsapp-widget backend listening on 127.0.0.1:${port}`);

  await client.start();

  const shutdown = async () => {
    persistence.stop();
    // Final flush: the interval may be up to 10s stale, and everything learned
    // in that window would otherwise need another device link to recover.
    persistence.save();
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
