import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "ClinicDesk",
  description: "An AI receptionist that answers questions and books appointments for clinics.",
};

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-between min-h-screen px-6 py-16 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-sans">
      <main className="flex flex-col items-center justify-center flex-1 max-w-xl text-center space-y-8 my-auto">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
          ClinicDesk
        </h1>
        <p className="text-lg sm:text-xl text-zinc-600 dark:text-zinc-400 leading-relaxed">
          An AI receptionist that answers questions and books appointments for clinics.
        </p>
        <div>
          <Link
            href="/demo"
            className="inline-flex items-center justify-center px-6 py-3.5 text-base font-semibold text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-950"
          >
            Try Demo Clinic A
          </Link>
        </div>
      </main>
      <footer className="w-full max-w-xl text-center text-xs text-zinc-500 dark:text-zinc-500 py-6 border-t border-zinc-100 dark:border-zinc-900">
        Demo uses fictional data. Not for real medical use.
      </footer>
    </div>
  );
}
