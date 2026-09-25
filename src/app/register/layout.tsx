import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";

/* The kiosk calls useToast(), which needs the provider above it. /admin gets
   this from its own layout; a page outside that tree has to bring its own or it
   throws on the first toast. */

export const metadata: Metadata = {
  title: "Register — Community Harvest",
  /* Its own app: added to the home screen it opens full-screen, sideways,
     straight onto the till — no address bar eating the ticket. */
  manifest: "/register-manifest.json",
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
