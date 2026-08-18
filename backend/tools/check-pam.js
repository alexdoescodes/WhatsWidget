'use strict';

/**
 * Manual check: confirms the dedicated PAM service can verify this user's
 * real login password. Run directly; the password is read with echo
 * disabled and is never stored, logged, or echoed.
 */
const os = require('node:os');
const pam = require('authenticate-pam');
const { buildConfig } = require('../src/config');

function readPassword(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('check-pam must be run from an interactive terminal'));
      return;
    }

    const KEY_CTRL_C = 3;
    const KEY_CTRL_D = 4;
    const KEY_BACKSPACE = 8;
    const KEY_LF = 10;
    const KEY_CR = 13;
    const KEY_DEL = 127;

    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        const code = char.charCodeAt(0);

        if (code === KEY_CR || code === KEY_LF || code === KEY_CTRL_D) {
          finish();
          resolve(value);
          return;
        }
        if (code === KEY_CTRL_C) {
          finish();
          reject(new Error('cancelled'));
          return;
        }
        if (code === KEY_DEL || code === KEY_BACKSPACE) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdin.on('data', onData);
  });
}

async function main() {
  const config = buildConfig();
  const username = os.userInfo().username;
  const password = await readPassword(`Password for ${username}: `);

  await new Promise((resolve, reject) => {
    pam.authenticate(username, password, (err) => {
      if (err) reject(new Error(String(err)));
      else resolve();
    }, { serviceName: config.pamService });
  });

  console.log(`OK: PAM service '${config.pamService}' verified the password.`);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
