import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Drive Core | National Operations", description: "Authenticated nationwide commerce and inventory command center" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
