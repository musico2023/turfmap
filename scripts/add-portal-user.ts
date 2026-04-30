/**
 * One-off: move anthony@fourdots.ca's portal access to Ivy's Touch.
 *
 * NOTE: client_users currently has UNIQUE(email) (a schema bug — should be
 * UNIQUE(client_id, email)). Until that migration ships, an email can only
 * be on ONE client portal. This script moves the row instead of inserting.
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

const EMAIL = 'anthony@fourdots.ca';
const TARGET_CLIENT_ID = '00000000-0000-4000-a000-000000000002'; // Ivy's Touch

async function main() {
  const supabase = getServerSupabase();
  const { data: row } = await supabase
    .from('client_users')
    .select('id, client_id')
    .eq('email', EMAIL)
    .maybeSingle();

  if (!row) {
    const { error } = await supabase
      .from('client_users')
      .insert({ client_id: TARGET_CLIENT_ID, email: EMAIL });
    if (error) throw new Error(error.message);
    console.log(`+ inserted new row → Ivy's Touch`);
    return;
  }

  if (row.client_id === TARGET_CLIENT_ID) {
    console.log(`✓ already on Ivy's Touch`);
    return;
  }

  const { error } = await supabase
    .from('client_users')
    .update({ client_id: TARGET_CLIENT_ID, last_login_at: null })
    .eq('id', row.id);
  if (error) throw new Error(error.message);
  console.log(`→ moved ${EMAIL} from ${row.client_id} to Ivy's Touch`);
}

main().catch((e) => { console.error(e); process.exit(1); });
