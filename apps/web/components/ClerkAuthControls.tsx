'use client';

import { SignInButton, UserButton, useAuth } from '@clerk/nextjs';

/** Clerk's account controls for the Direction A topbar: no border, no
 *  margin, sits inline in the 56px bar. */
export function ClerkAuthControls() {
  const { isSignedIn } = useAuth();
  return (
    <div className="flex items-center gap-3">
      {!isSignedIn ? (
        <SignInButton mode="modal">
          <button className="bg-transparent border-none text-[12px] font-semibold cursor-pointer" style={{ color: 'var(--ink-2)' }}>
            Sign in
          </button>
        </SignInButton>
      ) : (
        <>
          <span className="text-[11px]" style={{ color: 'var(--ink-3)' }}>Account</span>
          <UserButton />
        </>
      )}
    </div>
  );
}
