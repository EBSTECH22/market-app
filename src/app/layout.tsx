import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  icons: { icon: "/favicon.png", apple: "/logo-192.png" },
  manifest: "/manifest.json",
  title: "Community Harvest — Food and Craft Market",
  description: "Community Harvest — Food and Craft Market. Year-round in Noble, Oklahoma. Homegrown and homemade.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
