'use client';

import { SignInButton, UserButton, useAuth } from '@clerk/nextjs';

/** Clerk's account controls, rendered in whichever chrome hosts them.
 *  `sidebar` is the original footer layout; `topbar` is the Direction A
 *  header variant (no top border, no margin, sits inline in the 56px bar). */
export function ClerkAuthControls({ variant = 'sidebar' }: { variant?: 'sidebar' | 'topbar' }) {
  const { isSignedIn } = useAuth();
  const shell = variant === 'topbar'
    ? 'flex items-center gap-3'
    : 'flex items-center justify-between px-3 py-2 mt-3';
  return (
    <div className={shell} style={variant === 'topbar' ? undefined : { borderTop: '1px solid oklch(30% 0.008 75)' }}>
      {!isSignedIn ? (
        <SignInButton mode="modal">
          <button className="bg-transparent border-none text-[12px] font-semibold cursor-pointer" style={{ color: 'oklch(80% 0.005 75)' }}>
            Sign in
          </button>
        </SignInButton>
      ) : (
        <>
          <span className="text-[11px]" style={{ color: 'oklch(65% 0.006 75)' }}>Account</span>
          <UserButton />
        </>
      )}
    </div>
  );
}
