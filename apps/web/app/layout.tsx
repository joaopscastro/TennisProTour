import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tennis Manager',
  description: 'Tennis manager RPG — dev frontend',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#fafafa', color: '#1a1a1a' }}>
        <nav style={{ padding: '0.75rem 1.5rem', borderBottom: '1px solid #ddd', background: '#fff' }}>
          <a href="/" style={{ marginRight: '1.5rem', fontWeight: 600, textDecoration: 'none', color: 'inherit' }}>
            Tennis Manager
          </a>
          <a href="/" style={{ marginRight: '1rem', color: '#555' }}>Roster</a>
        </nav>
        <main style={{ maxWidth: 960, margin: '0 auto', padding: '1.5rem' }}>{children}</main>
      </body>
    </html>
  );
}
