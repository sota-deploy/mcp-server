#!/usr/bin/env node

/**
 * sota.io MCP Server — HTTP entry point (mcp.sota.io).
 *
 * The Express app lives in http-app.ts so tests can start it on an
 * ephemeral port; this file only binds it.
 */

import { app, PUBLIC_ORIGIN } from './http-app.js';
import { logEvent } from './lib/log.js';
import { GIT_SHA, PACKAGE_VERSION } from './lib/version.js';

const PORT = Number(process.env.PORT ?? 8080);

app.listen(PORT, '0.0.0.0', () => {
  logEvent('info', {
    event: 'listening',
    version: PACKAGE_VERSION,
    commit: GIT_SHA,
    url: `http://0.0.0.0:${PORT}`,
    public_origin: PUBLIC_ORIGIN,
  });
});
