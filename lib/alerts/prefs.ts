/**
 * Alert-preferences helpers — defaults + safe-load.
 *
 * The migration sets a default JSONB blob with all toggle keys
 * present, but a row that pre-dates 0013 (or a partial JSON sent
 * via PATCH) might be missing keys. This module fills any gaps
 * with the canonical defaults so every consumer can read
 * AlertPrefs without nullish-checking each toggle.
 */

import type { AlertPrefs } from '@/lib/supabase/types';

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  score_movement_email: true,
  score_movement_threshold: 5,
  competitor_entries_email: true,
  momentum_reversal_email: true,
  cell_changes_email: false,
  weekly_competitor_summary_email: true,
  monthly_pdf_email: true,
};

export function withAlertPrefDefaults(
  raw: Partial<AlertPrefs> | null | undefined
): AlertPrefs {
  return {
    ...DEFAULT_ALERT_PREFS,
    ...(raw ?? {}),
  };
}
