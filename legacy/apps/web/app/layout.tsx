import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "DevSync", description: "Shared workspace for software development" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
