import { AppProviders } from "@/components/AppProviders";

export default function VendorPublicLayout({ children }: { children: React.ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
