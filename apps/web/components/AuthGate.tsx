'use client';

import type { ReactNode } from 'react';
import { SignInButton, useAuth } from '@clerk/nextjs';
import { CLERK_ENABLED } from '../lib/api';
import { Button } from './ui/primitives';
import { Icon } from './ui/Icon';

/**
 * The entire signup surface (Phase 1 — "make it enterable"). When a real
 * identity provider is configured, a signed-out visitor sees a minimal
 * landing panel with a modal sign-in button and NOTHING else; a signed-in
 * visitor sees the app. When Clerk is not configured (local development),
 * children render unchanged, preserving the dev-manager workflow.
 *
 * Deliberately one wrapper around the layout's children — no new route and
 * no middleware. Every page already renders its own full-bleed chrome, so
 * there is nowhere sane to add a second chrome, and there is no
 * protected-route list to maintain: the API is the real authorization
 * boundary (`requireManager`), this only decides what a browser draws.
 *
 * The Clerk/no-Clerk split lives here in `AuthGate` (a stable build-time
 * constant) while `useAuth` lives in the CHILD `ClerkGate`, so the hook is
 * never called without a ClerkProvider above it.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  if (!CLERK_ENABLED) return <>{children}</>;
  return <ClerkGate>{children}</ClerkGate>;
}

function ClerkGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <Splash>Loading…</Splash>;
  if (!isSignedIn) return <SignInPanel />;
  return <>{children}</>;
}

function Splash({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--ink-3)' }}>
      <span className="t-body-sm">{children}</span>
    </div>
  );
}

function SignInPanel() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)' }}>
      <div className="gc-panel" style={{ maxWidth: 420, width: '100%', padding: '34px 30px', textAlign: 'center', borderTop: '2px solid var(--accent)' }}>
        <div className="gc-brand" style={{ justifyContent: 'center', fontSize: 18 }}>
          <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><Icon name="ball" size={18} /></span>
          Grand Circuit
        </div>
        <h1 className="t-h2" style={{ margin: '12px 0 6px', color: 'var(--ink)' }}>Manage your tour</h1>
        <p className="t-body-sm" style={{ margin: '0 0 24px', lineHeight: 1.5 }}>
          Sign in to build your roster, enter tournaments, and climb the rankings. Free to play — no pay-to-win.
        </p>
        <SignInButton mode="modal">
          <Button variant="primary" style={{ width: '100%', justifyContent: 'center' }}>
            Sign in
          </Button>
        </SignInButton>
      </div>
    </div>
  );
}
