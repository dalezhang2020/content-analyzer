import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Content Analyzer",
  description: "Analyze social-media content for creator insights",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full bg-background text-foreground">
        <div className="flex h-full">
          {/* Sidebar navigation — 200px fixed width on desktop, collapsible on smaller screens */}
          <Sidebar />

          {/* Main content area — scrollable, with max-width for readability */}
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl px-6 py-8 lg:px-8">
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
