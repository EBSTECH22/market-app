import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Community Harvest — Food and Craft Market",
  description: "Community Harvest — Food and Craft Market. Year-round in Noble, Oklahoma. Homegrown and homemade.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#22301c" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@800;900&family=Poppins:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
