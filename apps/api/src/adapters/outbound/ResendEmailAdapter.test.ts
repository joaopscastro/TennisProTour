import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagerId } from '@tennis-manager/domain';
import { OutboundEmail } from '@tennis-manager/application';
import { ResendEmailAdapter } from './ResendEmailAdapter';

function message(overrides: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    to: 'alice@example.com',
    subject: 'Tennis Manager - results digest',
    text: 'Your results body',
    html: '<p>Your results body</p>',
    managerId: ManagerId('m1'),
    ...overrides,
  };
}

/**
 * Stubs global.fetch and captures the request so assertions never need a
 * cast through `mock.calls`. No network is touched: the stub returns the
 * supplied Response object synchronously.
 */
function stubFetch(response: Response) {
  let url: RequestInfo | URL | undefined;
  let init: RequestInit | undefined;
  let body: Record<string, string> = {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    url = input;
    init = requestInit;
    body = requestInit?.body ? (JSON.parse(String(requestInit.body)) as Record<string, string>) : {};
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, request: () => ({ url, init, body }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResendEmailAdapter', () => {
  it('POSTs the expected URL, headers, and body to Resend', async () => {
    const { fetchMock, request } = stubFetch(new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }));
    const adapter = new ResendEmailAdapter({
      apiKey: 'test-key',
      fromEmail: 'Tennis Manager <digest@example.com>',
      appBaseUrl: 'https://api.example.com',
      unsubscribeSecret: 'secret',
    });

    await adapter.sendEmail(message());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = request();
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(body.from).toBe('Tennis Manager <digest@example.com>');
    expect(body.to).toBe('alice@example.com');
    expect(body.subject).toBe('Tennis Manager - results digest');
    expect(body.text).toContain('Your results body');
    expect(body.html).toContain('Your results body');
  });

  it('appends a recipient-specific unsubscribe footer to text and html', async () => {
    const { request } = stubFetch(new Response('', { status: 200 }));
    const adapter = new ResendEmailAdapter({
      apiKey: 'k',
      fromEmail: 'f@example.com',
      appBaseUrl: 'https://api.example.com',
      unsubscribeSecret: 'secret',
    });

    await adapter.sendEmail(message());

    const { body } = request();
    expect(body.text).toContain('https://api.example.com/notifications/unsubscribe?token=');
    expect(body.html).toContain('https://api.example.com/notifications/unsubscribe?token=');
    expect(body.html).toContain('Unsubscribe');
  });

  it('omits the footer when the unsubscribe secret is unset', async () => {
    const { request } = stubFetch(new Response('', { status: 200 }));
    const adapter = new ResendEmailAdapter({
      apiKey: 'k',
      fromEmail: 'f@example.com',
      appBaseUrl: 'https://api.example.com',
      unsubscribeSecret: null,
    });

    await adapter.sendEmail(message());

    const { body } = request();
    expect(body.text).toBe('Your results body');
    expect(body.text).not.toContain('unsubscribe');
  });

  it('omits the footer when there is no manager id to sign for', async () => {
    const { request } = stubFetch(new Response('', { status: 200 }));
    const adapter = new ResendEmailAdapter({
      apiKey: 'k',
      fromEmail: 'f@example.com',
      appBaseUrl: 'https://api.example.com',
      unsubscribeSecret: 'secret',
    });

    await adapter.sendEmail(message({ managerId: undefined }));

    expect(request().body.text).not.toContain('unsubscribe');
  });

  it('throws on a non-2xx so the use case marks the delivery failed', async () => {
    stubFetch(new Response('invalid api key', { status: 401 }));
    const adapter = new ResendEmailAdapter({
      apiKey: 'k',
      fromEmail: 'f@example.com',
      appBaseUrl: 'https://api.example.com',
      unsubscribeSecret: 'secret',
    });

    await expect(adapter.sendEmail(message())).rejects.toThrow(/401.*invalid api key/);
  });
});
