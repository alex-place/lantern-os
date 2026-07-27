#!/usr/bin/env node
/**
 * test-email.mjs — prove the mail pipeline end-to-end on THIS box.
 *
 * Usage:  node scripts/test-email.mjs you@example.com
 *
 * Loads .env/.env.local (last non-empty wins, same as the server), reports which
 * transport the mailer would use (resend | smtp | dev), sends one real test email,
 * and prints the honest result. Written for the unisona.ai launch check: signup
 * verification emails "never arrived" because prod had NO provider configured and
 * the mailer silently fell back to the dev outbox — this script makes that state
 * impossible to miss.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const f of ['.env', '.env.local']) {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[2].trim() !== '') process.env[m[1]] = m[2].trim();
    }
  } catch { /* optional */ }
}

const require_ = createRequire(path.join(ROOT, 'apps/lantern-garage/package.json'));
const mailer = require_('./lib/mailer');

const to = process.argv[2];
const status = mailer.mailerStatus();
console.log('mailer status:', JSON.stringify(status, null, 2));

if (!to) {
  console.log('\nNo recipient given — status only. To send a real test: node scripts/test-email.mjs you@example.com');
  process.exit(status.transport === 'dev' ? 1 : 0);
}
if (status.transport === 'dev') {
  console.error('\nABORT: no mail provider configured (RESEND_API_KEY or SMTP_HOST/USER/PASS).');
  console.error('A "send" would only append to data/mail-outbox.jsonl — no user would receive anything.');
  process.exit(1);
}

const r = await mailer.sendMail({
  to,
  subject: 'Unisona mail test',
  text: `This is a mail-pipeline test from ${process.env.PUBLIC_BASE_URL || 'a Unisona server'} at ${new Date().toISOString()}. If you can read this, transactional email works.`,
});
console.log('\nsend result:', JSON.stringify(r));
process.exit(r.ok ? 0 : 2);
