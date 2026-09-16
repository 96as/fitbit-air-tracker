/**
 * Day-one experiment helper (docs/GOOGLE_HEALTH_API.md §5): prints how fresh
 * the Fitbit Air data is right now, using the tokens saved by the web sign-in.
 *   npm run google:probe -w server
 * Runs anywhere the server's data/app.db and .env are available (e.g. a Pi).
 */
import { loadDotEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/index.js';
import { createServerGoogleHealth } from '../src/providers/googleHealth/index.js';

loadDotEnv(new URL('../.env', import.meta.url).pathname);
const config = loadConfig();
const db = new Db(config.databasePath);
const user = db.seedDemoUser();
const google = createServerGoogleHealth({
  db,
  userId: user.id,
  clientId: config.googleClientId,
  clientSecret: config.googleClientSecret,
});

if (!google.configured) {
  console.error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in server/.env');
  process.exit(2);
}
if (!(await google.tokenManager.isConnected())) {
  console.error('Not signed in. Start the server, open the web app → Device → Connect Google.');
  process.exit(3);
}
const report = await google.provider.probe(user.id);
console.log(JSON.stringify(report, null, 2));
db.logEvent('google.probe', user.id, { ...report });
