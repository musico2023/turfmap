import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

// Next 16 renamed middleware.ts → proxy.ts and the exported function name
// from `middleware` to `proxy`. Functionally equivalent.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Run on portal routes (session refresh) and auth routes (sign-in flow).
    // Skip Next internals + every API namespace that uses service-role auth.
    '/((?!_next/|favicon.ico|api/cron/|api/scans/|api/ai/|api/reports/|api/clients|api/keywords|api/client_users).*)',
  ],
};
