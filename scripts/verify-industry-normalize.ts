/**
 * Guard for lib/industries/normalize.ts.
 *
 * Fixtures are the real corrupted rows from the 2026-08-27 / 2026-09-01
 * outreach batches, plus the legitimate overlaps that must survive.
 */
import {
  normalizeIndustry,
  isBrandLeakage,
  tradeFromKeyword,
} from '../lib/industries/normalize';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { console.error(`✗ ${name}`); failures++; } else console.log(`✓ ${name}`);
}

// ── the real incident ───────────────────────────────────────────────────
check('Allbritten brand rejected, keyword wins',
  normalizeIndustry('Allbritten', {
    businessName: 'Allbritten Heating, Air Conditioning, Plumbing, and Electrical',
    keyword: 'hvac company near me',
  }) === 'hvac');

check('AB May → hvac',
  normalizeIndustry('AB May', { businessName: 'AB May', keyword: 'hvac company near me' }) === 'hvac');

check('DryLux → restoration',
  normalizeIndustry('DryLux Restoration', {
    businessName: 'DryLux Restoration', keyword: 'restoration company near me',
  }) === 'restoration');

check('Victors Home Solutions → roofing',
  normalizeIndustry('Victors Home Solutions', {
    businessName: 'Victors Home Solutions', keyword: 'roofing contractor near me',
  }) === 'roofing');

// Regression: punctuation differences defeated the substring test, so these
// 16 real rows survived the first backfill pass as lowercased brand names.
check('"AB May" vs "A.B. May Heating, A/C, Plumbing & Electrical" → hvac',
  normalizeIndustry('AB May', {
    businessName: 'A.B. May Heating, A/C, Plumbing & Electrical',
    keyword: 'hvac company near me',
  }) === 'hvac');
check('"Blue Ox Heating Air" vs "Blue Ox Heating & Air" → hvac',
  normalizeIndustry('Blue Ox Heating Air', {
    businessName: 'Blue Ox Heating & Air', keyword: 'hvac company near me',
  }) === 'hvac');
check('"Rogers Roofing" exact → roofing, not the brand',
  normalizeIndustry('Rogers Roofing', {
    businessName: 'Rogers Roofing', keyword: 'roofing contractor near me',
  }) === 'roofing');

// ── legitimate overlaps must survive ────────────────────────────────────
check('painting kept for "Painting Plus"',
  normalizeIndustry('painting', { businessName: 'Painting Plus', keyword: 'painters near me' }) === 'painting');
check('siding kept for "Superior Siding"',
  normalizeIndustry('siding', { businessName: 'Superior Siding', keyword: 'siding contractor' }) === 'siding');
check('roofing kept for "Rogers Roofing"',
  normalizeIndustry('roofing', { businessName: 'Rogers Roofing', keyword: 'roofer near me' }) === 'roofing');

// ── keyword suffix stripping ────────────────────────────────────────────
check('strips " near me"', tradeFromKeyword('plumber near me') === 'plumber');
check('strips " company near me"', tradeFromKeyword('hvac company near me') === 'hvac');
check('leaves real phrases intact', tradeFromKeyword('air conditioning repair') === 'air conditioning repair');
check('null keyword → null', tradeFromKeyword(null) === null);

// ── output invariants ───────────────────────────────────────────────────
check('always lowercase',
  normalizeIndustry('HVAC', { businessName: 'Acme Corp', keyword: null }) === 'hvac');
check('google place_type passes through',
  normalizeIndustry('general_contractor', { businessName: 'Acme Corp' }) === 'general_contractor');
check('no value + no keyword → null',
  normalizeIndustry(null, { businessName: 'Acme Corp' }) === null);
check('brand with no keyword → null, never the brand',
  normalizeIndustry('Allbritten', { businessName: 'Allbritten Heating' }) === null);

// ── leakage predicate ───────────────────────────────────────────────────
check('leakage: brand inside name', isBrandLeakage('Allbritten', 'Allbritten Heating and Air') === true);
check('no leakage: real trade inside name', isBrandLeakage('painting', 'Painting Plus') === false);
check('no leakage: value absent from name', isBrandLeakage('hvac', 'Allbritten Heating') === false);
check('no leakage on empty input', isBrandLeakage('', 'Acme') === false);

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll industry-normalize checks passed.');
