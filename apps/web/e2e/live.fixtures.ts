import {
  test as base,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from '@playwright/test';
import { LIVE_API_URL, LIVE_MANAGER_ID } from './liveSupport';

/**
 * Fixtures for the LIVE suite. Adds:
 *
 *  - `api`: an APIRequestContext pointed at the running API, carrying the
 *    same `x-dev-manager-id` the browser sends, so a spec can POLL the
 *    API for a condition (the deterministic alternative to
 *    `waitForTimeout`) and assert against values captured at runtime.
 *
 *  - `diagnostics`: per-test capture of browser `console` errors,
 *    uncaught `pageerror`s, and failed network requests, attached to the
 *    test output (and logged) so a failure report carries the browser's
 *    own evidence without having to re-run with a debugger attached.
 *
 * No backend mocking lives here or in the specs that use it — the whole
 * point of this suite is the real stack.
 */
export interface BrowserDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export const test = base.extend<
  { diagnostics: BrowserDiagnostics },
  { api: APIRequestContext }
>({
  // Worker-scoped: one request context for the whole run, available in
  // `beforeAll` (test-scoped fixtures are not).
  api: [
    async ({}, use) => {
      const context = await playwrightRequest.newContext({
        baseURL: LIVE_API_URL,
        extraHTTPHeaders: { 'x-dev-manager-id': LIVE_MANAGER_ID },
      });
      await use(context);
      await context.dispose();
    },
    { scope: 'worker' },
  ],

  diagnostics: async ({ page }, use, testInfo) => {
    const diagnostics: BrowserDiagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [] };

    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => {
      diagnostics.pageErrors.push(error.stack ?? error.message);
    });
    page.on('requestfailed', (request) => {
      diagnostics.failedRequests.push(
        `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown failure'}`,
      );
    });

    await use(diagnostics);

    const summary = { managerId: LIVE_MANAGER_ID, apiBase: LIVE_API_URL, ...diagnostics };
    await testInfo.attach('browser-diagnostics', {
      body: JSON.stringify(summary, null, 2),
      contentType: 'application/json',
    });
    if (diagnostics.pageErrors.length || diagnostics.failedRequests.length || diagnostics.consoleErrors.length) {
      // eslint-disable-next-line no-console
      console.log(`[browser-diagnostics] ${JSON.stringify(summary)}`);
    }
  },
});

export { expect };
