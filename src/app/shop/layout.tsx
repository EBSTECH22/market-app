import { AppProviders } from "@/components/AppProviders";

/**
 * /shop uses useDialog() (the "Clear cart" confirmation), which needs a
 * provider above it. No metadata here on purpose: /shop/paid and /shop/sign
 * sit under this layout and should keep inheriting the root title.
 */
export default function ShopLayout({ children }: { children: React.ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
