"use client";

import type { ReactNode } from "react";
import { DialogProvider } from "./ui/Dialog";
import { ToastProvider } from "./ui/Toast";

/**
 * Wraps a section of the app in the dialog + toast systems.
 * Anything under this can call useDialog() and useToast() instead of reaching
 * for window.confirm / window.prompt / window.alert.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <DialogProvider>{children}</DialogProvider>
    </ToastProvider>
  );
}

export default AppProviders;
