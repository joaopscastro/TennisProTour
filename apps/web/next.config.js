const path = require('path');

/**
 * Next.js config, CommonJS on purpose: there was no next.config before
 * the deploy-artifacts pass, and a plain `next.config.js` is the one
 * form every tool (including `next build` inside the Docker builder
 * stage) reads without an extra transpile step.
 *
 * `output: 'standalone'` emits a self-contained `.next/standalone`
 * server (`.next/standalone/apps/web/server.js`, because the build runs
 * from the monorepo root and preserves the workspace path) with only
 * the traced production files, so the `web` Docker target can ship it
 * without a full node_modules install.
 *
 * `outputFileTracingRoot` is REQUIRED here: npm hoists node_modules to
 * the repo root, so without it Next would treat `apps/web` as the trace
 * root and miss every hoisted dependency (the exact monorepo caveat in
 * Next's own output.md docs). It must point at the repo root —
 * `apps/web/../../` — NOT at `apps/web`.
 *
 * Build-time note: the `NEXT_PUBLIC_*` values below are INLINED into
 * the client bundle at build time (see Dockerfile). They cannot be
 * changed by runtime env vars on the deployed container.
 */
module.exports = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // `NEXT_DIST_DIR` lets several `next dev` servers run against this one
  // source tree at the same time without fighting over `.next` — Next holds
  // a lockfile at `<distDir>/lock` and *refuses* a second dev/build on the
  // same distDir (config-shared.d.ts's `lockDistDir`). The UX-probe bring-up
  // script starts one dev server per agent for a stable per-server identity,
  // so each must own its own distDir. Unset = the normal `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
