import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { ClerkProvider } from '@clerk/nextjs';
import { ClerkAuthBridge } from '../components/ClerkAuthBridge';
import { AuthGate } from '../components/AuthGate';

export const metadata: Metadata = {
  title: 'Grand Circuit',
  description: 'Grand Circuit — a fair, browser-based tennis manager RPG',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  // AuthGate sits INSIDE ClerkProvider, so its useAuth has a provider. With
  // no key it simply passes children through (local dev unchanged).
  const content = publishableKey ? (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkAuthBridge />
      <AuthGate>{children}</AuthGate>
    </ClerkProvider>
  ) : (
    <AuthGate>{children}</AuthGate>
  );

  return (
    <html lang="en">
      {/* No shared nav/main wrapper here — every route renders its own
         full-bleed Sidebar + content layout (components/Sidebar.tsx),
         so a second top nav bar here would just duplicate it. */}
      <body style={{ margin: 0 }}>{content}</body>
    </html>
  );
}
