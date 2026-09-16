import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";

/* The kiosk calls useToast(), which needs the provider above it. /admin gets
   this from its own layout; a page outside that tree has to bring its own or it
   throws on the first toast. */

export const metadata: Metadata = {
  title: "Register — Community Harvest",
  manifest: "/admin-manifest.json",
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
