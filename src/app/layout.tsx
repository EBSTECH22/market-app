import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://market.dailybreadbaked.com"),
  icons: { icon: "/favicon.png", apple: "/logo-192.png" },
  manifest: "/manifest.json",
  title: "Community Harvest — Food and Craft Market",
  description: "Community Harvest — Food and Craft Market. Year-round in Noble, Oklahoma. Homegrown and homemade.",
  openGraph: {
    title: "Community Harvest — Food and Craft Market",
    description: "Year-round indoor market in Noble, Oklahoma. Homegrown and homemade — see what's on the floor right now.",
    url: "https://market.dailybreadbaked.com",
    siteName: "Community Harvest",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Community Harvest — Food and Craft Market" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Community Harvest — Food and Craft Market",
    description: "Year-round indoor market in Noble, Oklahoma. Homegrown and homemade.",
    images: ["/og-image.png"],
  },
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
