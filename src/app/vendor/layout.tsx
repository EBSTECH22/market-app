import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";

export const metadata: Metadata = {
  title: "Community Harvest Vendor Portal",
};

export default function VendorLayout({ children }: { children: React.ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
