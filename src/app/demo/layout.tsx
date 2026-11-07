import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Demo Clinic A – Receptionist",
  description: "AI receptionist demo for Demo Clinic A",
  robots: {
    index: false,
    follow: false,
  },
};

export default function DemoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

