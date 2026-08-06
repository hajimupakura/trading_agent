import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title:"SPX / SPY Options Command Center", description:"Paper-only 0–2 DTE options research" };
export default function RootLayout({ children }: Readonly<{ children:React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
