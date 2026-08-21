'use strict';

const os = require('node:os');
const path = require('node:path');

/**
 * Resolve all filesystem locations and tunables from the environment.
 * Written as a factory (rather than reading process.env at module load)
 * so tests can drive it without mutating the real environment.
 */
function buildConfig(env = process.env, homedir = os.homedir(), uid = process.getuid()) {
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const dataHome = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
  const dataDir = path.join(dataHome, 'whatsapp-widget');

  return {
    dataDir,
    sessionDir: path.join(dataDir, 'session'),
    endpointFile: path.join(runtimeDir, 'whatsapp-widget-endpoint.json'),
    // Dedicated PAM service: see plan Global Constraints. Never 'login'.
    pamService: 'whatsapp-widget',
    maxMessagesPerChat: 50,
    // Raised from 200 once history sync started delivering whole accounts at
    // once. Chat metadata is tiny; the memory that matters is messages, and
    // that is still capped per chat, so the worst case is roughly
    // maxChats * maxMessagesPerChat message objects.
    maxChats: 500,
  };
}

module.exports = { buildConfig };
