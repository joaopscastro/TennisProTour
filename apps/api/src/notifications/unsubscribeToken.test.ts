import { describe, expect, it } from 'vitest';
import { buildUnsubscribeUrl, signUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribeToken';

const SECRET = 'test-unsubscribe-secret';

describe('unsubscribeToken', () => {
  it('round-trips a manager id through sign/verify', () => {
    const token = signUnsubscribeToken('m-123', SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe('m-123');
  });

  it('is deterministic for the same manager + secret', () => {
    expect(signUnsubscribeToken('m-123', SECRET)).toBe(signUnsubscribeToken('m-123', SECRET));
  });

  it('rejects a token signed with a different secret', () => {
    const token = signUnsubscribeToken('m-123', 'other-secret');
    expect(verifyUnsubscribeToken(token, SECRET)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = signUnsubscribeToken('m-123', SECRET);
    const [payload, signature] = token.split('.');
    // Re-encode a DIFFERENT manager id under the same signature.
    const forgedPayload = Buffer.from('m-999', 'utf8').toString('base64url');
    expect(verifyUnsubscribeToken(`${forgedPayload}.${signature}`, SECRET)).toBeNull();
    // Sanity: the original still verifies.
    expect(verifyUnsubscribeToken(`${payload}.${signature}`, SECRET)).toBe('m-123');
  });

  it('rejects a tampered signature', () => {
    const token = signUnsubscribeToken('m-123', SECRET);
    const [payload] = token.split('.');
    expect(verifyUnsubscribeToken(`${payload}.not-a-real-signature`, SECRET)).toBeNull();
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifyUnsubscribeToken('', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken('no-dot-at-all', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken('.onlysignature', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken('payload.', SECRET)).toBeNull();
  });

  it('builds the public unsubscribe URL and tolerates a trailing slash', () => {
    expect(buildUnsubscribeUrl('https://api.example.com', 'abc.def')).toBe(
      'https://api.example.com/notifications/unsubscribe?token=abc.def',
    );
    expect(buildUnsubscribeUrl('https://api.example.com/', 'abc.def')).toBe(
      'https://api.example.com/notifications/unsubscribe?token=abc.def',
    );
  });
});
