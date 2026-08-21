'use strict';

const fs = require('node:fs');
const { buildConfig } = require('./config');
const { createStore } = require('./store');
const { createPersistence } = require('./persist');
const { acquireLock } = require('./lock');
const { createAvatarCache } = require('./avatars');
const { createMediaCache } = require('./media');
const { downloadContentFromMessage } = require('baileys');
const { createAuthenticator } = require('./auth-pam');
const { createWhatsAppClient } = require('./whatsapp');
const { createServer } = require('./server');

async function main() {
  const config = buildConfig();

  // Before anything touches the session directory: two backends sharing it
  // desynchronise the Signal ratchet, and the symptom lands on the people the
  // user is messaging, not here.
  const lock = acquireLock({ file: config.lockFile });

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
  const media = createMediaCache({
    dir: config.mediaDir,
    // Baileys hands back a stream of decrypted bytes; the cap is enforced
    // while reading so an oversized file cannot be pulled into memory whole
    // before anyone notices how big it is.
    download: async (info, kind, maxBytes) => {
      const stream = await downloadContentFromMessage(info, kind);
      const chunks = [];
      let total = 0;
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('media larger than the cap');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
  });

  const server = createServer({
    client, store, authenticator, media, endpointFile: config.endpointFile,
  });

  const { port } = await server.listen();
  console.log(`whatsapp-widget backend listening on 127.0.0.1:${port}`);

  await client.start();

  let shuttingDown = false;
  const shutdown = async () => {
    // SIGTERM then SIGINT (or systemd retrying) must not run this twice and
    // race the credential flush against itself.
    if (shuttingDown) return;
    shuttingDown = true;

    // Close the WhatsApp socket FIRST. Signal state advances per message, and
    // exiting with it half-written leaves the far end unable to decrypt what
    // we sent -- the recipient sees "Waiting for this message" forever.
    try {
      await client.stop();
    } catch (err) {
      console.error('could not close the WhatsApp connection cleanly:', err.message);
    }

    persistence.stop();
    // Final flush: the interval may be up to 10s stale, and everything learned
    // in that window would otherwise need another device link to recover.
    persistence.save();
    await server.close();
    lock.release();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
