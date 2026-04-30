/**
 * `/clients/new` — agency onboarding form.
 *
 * Server route → renders Header + ClientCreateForm. The form posts to
 * `/api/clients` and on success redirects to the new client's dashboard.
 */

import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Header } from '@/components/turfmap/Header';
import { ClientCreateForm } from '@/components/turfmap/ClientCreateForm';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';

export default async function NewClientPage() {
  const me = await requireAgencyUserOrRedirect('/clients/new');
  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />
      <div className="px-8 py-6">
        <Link
          href="/"
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 mb-3"
        >
          <ChevronLeft size={12} /> Back to clients
        </Link>
        <div className="mb-6">
          <h1 className="font-display text-2xl font-bold">Onboard a new client</h1>
          <p className="text-xs text-zinc-500 mt-1">
            Creates the client + a primary tracking keyword. The first scheduled
            scan runs on the next cron cycle (Mondays 06:00 UTC). To scan
            immediately, use the dashboard&apos;s <span className="text-zinc-300">Re-scan turf</span> button.
          </p>
        </div>
        <ClientCreateForm />
      </div>
    </div>
  );
}
