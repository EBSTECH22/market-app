import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";

export const metadata: Metadata = {
  title: "Community Harvest Admin",
  manifest: "/admin-manifest.json",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
