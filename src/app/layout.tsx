import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { TabBar } from "@/components/TabBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Boodschappen",
  description: "Slim boodschappenlijstje met AH & Picnic prijsvergelijking",
  applicationName: "Boodschappen",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Boodschappen" },
  other: { "apple-mobile-web-app-capable": "yes" },
  icons: {
    icon: [
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F2F2F7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="nl">
      <body className="min-h-screen overflow-x-clip antialiased">
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 top-0 z-40 h-[env(safe-area-inset-top,0px)] bg-[var(--canvas)]"
        />
        <div vaul-drawer-wrapper="" className="min-h-screen overflow-x-clip">
          {children}
        </div>
        <TabBar />
        <Toaster
          position="top-center"
          richColors
          closeButton={false}
          visibleToasts={1}
          duration={2000}
          offset={{ top: "calc(env(safe-area-inset-top, 0px) + 0.75rem)" }}
          mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 0.5rem)" }}
          toastOptions={{ style: { pointerEvents: "none" } }}
        />
      </body>
    </html>
  );
}
