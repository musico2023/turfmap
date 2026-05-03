import Link from 'next/link';
import { ChevronRight, Crosshair, Plus } from 'lucide-react';
import { getServerSupabase } from '@/lib/supabase/server';
import type { ClientRow } from '@/lib/supabase/types';
import { Header } from '@/components/turfmap/Header';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';
import { LinkButton } from '@/components/ui/Button';

export default async function AgencyHomePage() {
  const me = await requireAgencyUserOrRedirect('/clients');
  const supabase = getServerSupabase();
  const { data: clients } = await supabase
    .from('clients')
    .select('*')
    .order('created_at', { ascending: false });

  const list = (clients ?? []) as ClientRow[];

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      <div className="px-8 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="font-display text-2xl font-bold">Agency clients</h1>
            <p className="text-xs text-zinc-500 mt-1">
              {list.length} client{list.length === 1 ? '' : 's'} on TurfMap.
            </p>
          </div>
          <LinkButton
            variant="primary"
            size="md"
            href="/clients/new"
            leftIcon={<Plus size={14} strokeWidth={2.75} />}
          >
            Add client
          </LinkButton>
        </div>

        {list.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {list.map((c) => (
              <Link
                key={c.id}
                href={`/clients/${c.public_id}`}
                className="border rounded-lg p-5 transition-colors hover:border-zinc-700 group"
                style={{
                  background: 'var(--color-card)',
                  borderColor: 'var(--color-border)',
                }}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
                    {c.industry ?? 'Local business'}
                  </div>
                  <ChevronRight
                    size={16}
                    className="text-zinc-600 group-hover:text-zinc-300 transition-colors"
                  />
                </div>
                <div className="font-display text-lg font-semibold leading-snug mb-1">
                  {c.business_name}
                </div>
                <div className="text-xs text-zinc-500 truncate">
                  {c.address}
                </div>
                <div className="mt-4 flex items-center gap-2 text-[11px] font-mono text-zinc-600">
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full"
                    style={{
                      background:
                        c.status === 'active'
                          ? 'var(--color-lime)'
                          : '#666',
                    }}
                  />
                  <span className="uppercase tracking-wider">
                    {c.status ?? 'unknown'}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="border rounded-lg p-12 flex flex-col items-center text-center"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center mb-5 border border-zinc-800"
        style={{ background: '#0a0a0a' }}
      >
        <Crosshair size={28} className="text-zinc-600" strokeWidth={1.5} />
      </div>
      <h4 className="font-display text-xl font-semibold text-zinc-300">
        No clients yet
      </h4>
      <p className="text-sm text-zinc-500 mt-2 max-w-sm">
        Run <span className="font-mono text-zinc-300">npm run test-scan</span>{' '}
        to seed a test client and its first scan.
      </p>
    </div>
  );
}
