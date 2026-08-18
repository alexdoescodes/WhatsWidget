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
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (char) => {
      switch (char) {
        case '\n':
        case '\r':
        case '':
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          break;
        case '':
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          reject(new Error('cancelled'));
          break;
        case '':
        case '\b':
          value = value.slice(0, -1);
          break;
        default:
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
