import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Front Office — Clinic Console',
  description: 'AI receptionist console: conversations, escalations, appointments and performance.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
