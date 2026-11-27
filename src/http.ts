#!/usr/bin/env node

/**
 * sota.io MCP Server — HTTP entry point (mcp.sota.io).
 *
 * The Express app lives in http-app.ts so tests can start it on an
 * ephemeral port; this file only binds it.
 */

import { app, PUBLIC_ORIGIN } from './http-app.js';
import { bridgeSecretProblem } from './auth/token-bridge.js';
import { logEvent } from './lib/log.js';
import { GIT_SHA, PACKAGE_VERSION } from './lib/version.js';

const PORT = Number(process.env.PORT ?? 8080);

// The hosted server cannot mint connector keys without the service secret
// the API requires (MCP_BRIDGE_SECRET): refuse to start rather than fail
// every signed-in request. The stdio server (index.ts) does not need it.
const problem = bridgeSecretProblem(process.env.MCP_BRIDGE_SECRET);
if (problem) {
  logEvent('error', { event: 'startup_refused', error_message: problem });
  console.error(`sota-mcp (hosted): ${problem}`);
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  logEvent('info', {
    event: 'listening',
    version: PACKAGE_VERSION,
    commit: GIT_SHA,
    url: `http://0.0.0.0:${PORT}`,
    public_origin: PUBLIC_ORIGIN,
  });
});
