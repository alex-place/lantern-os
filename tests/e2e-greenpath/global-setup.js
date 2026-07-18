// @ts-check
/**
 * Greenpath globalSetup — stamps the run id (used in demo-account emails and the
 * run record) and clears any stale step rows from a crashed previous run.
 * Runs in the Playwright runner process; env set here is inherited by workers.
 */
const fs = require('fs');
const { STEPS_TMP } = require('./journey.helpers');

module.exports = async () => {
  if (!process.env.GREENPATH_RUN_ID) {
    process.env.GREENPATH_RUN_ID = Date.now().toString(36);
  }
  process.env.GREENPATH_RUN_T0 = String(Date.now());
  try { fs.unlinkSync(STEPS_TMP); } catch { /* no stale file — fine */ }
};
