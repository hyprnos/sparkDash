import fs from 'node:fs';

/** Use the existing auth system with a secret on the persistent config mount. */
export function loadConfiguredAccessToken(file, env = process.env) {
  if (String(env.SPARKDASH_TOKEN || env.DASHBOARD_TOKEN || '').trim()) return 'environment';
  let token;
  try { token = fs.readFileSync(file, 'utf8').trim(); }
  catch (error) {
    if (error.code === 'ENOENT') return 'none';
    throw error; // An unreadable configured credential must never become open access.
  }
  if (!token) throw new Error('Configured sparkDash access-token file is empty');
  env.SPARKDASH_TOKEN = token;
  return 'file';
}
