import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VibeSync — Listen Together",
  description: "Real-time collaborative music listening rooms.",
};

// Ensures the viewport shrinks when the mobile keyboard opens,
// keeping dvh units and fixed elements above the keyboard
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1, // prevents auto-zoom on input focus in mobile Safari
  interactiveWidget: 'resizes-content', // Chrome-specific: shrinks viewport on keyboard open
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
