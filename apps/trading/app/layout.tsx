import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title:"Velocity · SPX / SPY Options Desk", description:"Live 0–2 DTE options intelligence and paper-trading research" };
export default function RootLayout({ children }: Readonly<{ children:React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
