'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, LogOut } from 'lucide-react';

/**
 * Tiny client button — POSTs to /api/auth/signout, then refreshes so the
 * portal route's session check kicks the user back to /login.
 */
export function SignOutButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const onClick = async () => {
    setSubmitting(true);
    try {
      await fetch('/api/auth/signout', { method: 'POST' });
      startTransition(() => router.refresh());
    } finally {
      setSubmitting(false);
    }
  };

  const px = size === 'md' ? 'px-3 py-2' : 'px-2.5 py-1.5';
  const text = size === 'md' ? 'text-xs' : 'text-[11px]';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={submitting}
      className={`${px} ${text} rounded-md text-zinc-500 hover:text-zinc-200 transition-colors flex items-center gap-1.5 font-mono disabled:opacity-50`}
    >
      {submitting ? (
        <Activity size={11} className="animate-pulse" />
      ) : (
        <LogOut size={11} />
      )}
      Sign out
    </button>
  );
}
