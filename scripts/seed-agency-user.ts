/**
 * Seed the agency-staff user table with the founder's account so the
 * forthcoming auth gate doesn't lock him out of his own product. Idempotent.
 *
 * Run with:  npm run seed:agency-user
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

const STAFF = [
  { email: 'anthony@fourdots.ca', full_name: 'Anthony Alfonsi', role: 'admin' as const },
];

async function main() {
  const supabase = getServerSupabase();
  for (const u of STAFF) {
    const { data: existing } = await supabase
      .from('users')
      .select('id, email, role')
      .eq('email', u.email)
      .maybeSingle();
    if (existing) {
      if (existing.role !== u.role) {
        await supabase.from('users').update({ role: u.role }).eq('id', existing.id);
        console.log(`✓ ${u.email} role updated → ${u.role}`);
      } else {
        console.log(`✓ ${u.email} already seeded as ${existing.role}`);
      }
      continue;
    }
    const { error } = await supabase.from('users').insert(u);
    if (error) {
      console.log(`✗ ${u.email}: ${error.message}`);
    } else {
      console.log(`+ added ${u.email} (role=${u.role})`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
