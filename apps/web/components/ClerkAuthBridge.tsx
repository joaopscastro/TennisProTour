'use client';

import { useAuth } from '@clerk/nextjs';
import { useEffect } from 'react';
import { setAuthTokenProvider } from '../lib/api';

/** Makes the current Clerk session available to the plain HTTP API client.
 * The client sends a bearer token to Fastify; the API verifies it with
 * Clerk's JWKS/secret and never trusts a manager ID from the browser. */
export function ClerkAuthBridge() {
  const { getToken } = useAuth();

  useEffect(() => {
    setAuthTokenProvider(getToken);
    return () => setAuthTokenProvider(null);
  }, [getToken]);

  return null;
}
