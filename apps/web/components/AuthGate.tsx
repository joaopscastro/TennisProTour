'use client';

import type { ReactNode } from 'react';
import { SignInButton, useAuth } from '@clerk/nextjs';
import { CLERK_ENABLED } from '../lib/api';
import { AppFrame, Panel, Button } from './ui/primitives';

/**
 * The entire signup surface (Phase 1 — "make it enterable"). When a real
 * identity provider is configured, a signed-out visitor sees a minimal
 * landing panel with a modal sign-in button and NOTHING else; a signed-in
 * visitor sees the app. When Clerk is not configured (local development),
 * children render unchanged, preserving the dev-manager workflow.
 *
 * Deliberately one wrapper around the layout's children — no new route and
 * no middleware. Every page already renders its own full-bleed Sidebar, so
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
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--gc-bg-deep)',
        color: 'var(--gc-ink-mute)',
      }}
    >
      <span style={{ fontSize: 13, letterSpacing: '0.4px' }}>{children}</span>
    </div>
  );
}

function SignInPanel() {
  return (
    <AppFrame>
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
        <Panel style={{ maxWidth: 420, width: '100%', padding: '34px 30px', textAlign: 'center' }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: '1.6px', textTransform: 'uppercase', color: 'var(--gc-ball)' }}>
            Grand Circuit
          </div>
          <h1 style={{ margin: '12px 0 6px', fontSize: 26, fontWeight: 800, color: 'var(--gc-ink)' }}>Manage your tour</h1>
          <p style={{ margin: '0 0 24px', fontSize: 13.5, lineHeight: 1.5, color: 'var(--gc-ink-mute)' }}>
            Sign in to build your roster, enter tournaments, and climb the rankings. Free to play — no pay-to-win.
          </p>
          <SignInButton mode="modal">
            <Button variant="primary" style={{ width: '100%' }}>
              Sign in
            </Button>
          </SignInButton>
        </Panel>
      </div>
    </AppFrame>
  );
}
