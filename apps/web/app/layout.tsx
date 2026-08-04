import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Grand Circuit',
  description: 'Grand Circuit — a fair, browser-based tennis manager RPG',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* No shared nav/main wrapper here — every route renders its own
         full-bleed Sidebar + content layout (components/Sidebar.tsx),
         so a second top nav bar here would just duplicate it. */}
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
