'use client';

import { SignInButton, UserButton, useAuth } from '@clerk/nextjs';

export function ClerkAuthControls() {
  const { isSignedIn } = useAuth();
  return (
    <div className="flex items-center justify-between px-3 py-2 mt-3" style={{ borderTop: '1px solid oklch(30% 0.008 75)' }}>
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
