/**
 * Server-only Anthropic client. Used by the AI Coach route handler.
 * Singleton — one instance per process.
 */

import Anthropic from '@anthropic-ai/sdk';

let cached: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY missing — check .env.local');
  }
  cached = new Anthropic({ apiKey });
  return cached;
}

/** Model ID for the TurfMap AI Coach. CLAUDE.md spec: Anthropic Sonnet 4. */
export const COACH_MODEL = 'claude-sonnet-4-6' as const;
