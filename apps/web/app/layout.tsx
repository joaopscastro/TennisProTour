import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, Inter, Saira_Condensed } from 'next/font/google';
import './globals.css';
import { ClerkProvider } from '@clerk/nextjs';
import { ClerkAuthBridge } from '../components/ClerkAuthBridge';
import { AuthGate } from '../components/AuthGate';

/* Direction A type system (design/prototypes/a-broadcast-telemetry.html):
   Saira Condensed for display, IBM Plex Mono for figures, Inter for body.
   Self-hosted at BUILD time by next/font; exposed as CSS variables on <html>
   so globals.css's --display/--mono/--body stacks can name them with
   fallbacks. */
const displayFont = Saira_Condensed({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const monoFont = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

const bodyFont = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

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
    <html lang="en" className={`${displayFont.variable} ${monoFont.variable} ${bodyFont.variable}`}>
      {/* No shared nav/main wrapper here — every route renders its own
         full-bleed AppShell chrome (components/ui/AppShell.tsx), so a
         second top nav bar here would just duplicate it. */}
      <body>{content}</body>
    </html>
  );
}
