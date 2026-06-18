# /yourmap Restructure (v2, reconciled to live origin/main) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Supersedes** `2026-06-17-yourmap-restructure.md` (that plan was written against a stale base — `app/yourmap/page.tsx` was 1502 lines; live is 1859 with "Part B" components already shipped). This plan targets current `origin/main` (HEAD `e3e5981`) and ADDS only the approved-mockup beats that aren't already live, reconciling with existing components.

**Goal:** Bring the live `/yourmap` page in line with the approved mockup by adding the genuinely-missing beats — two under-map trust micro-lines, a "What's behind the button" unlock manifest, a "Why you got this" cold-outreach accordion, and the "Run the full scan — free" CTA — without duplicating or regressing the already-shipped Part B work.

**Already live (do NOT re-add):** `PersonalizedStatHero` (% invisibility stat), `TheirDataTeaser` (honest proportional 81-cell map), `RiskReversalCallout`, `TrustStripRow`, `OneOfEightyOneSection`, `TestimonialSection`, funnel instrumentation (`YourmapFunnelEmitter`), the COLDSCAN bypass + Stripe fallback. PRESERVE all of these.

**Constraints:** No dev server (OOM) — verify via `npm run lint` + `npm run typecheck`, then prod. Subagents READ `app/yourmap/page.tsx` to find anchors (line numbers approximate). Known pre-existing noise: `.next/` artifacts + three unrelated files — ignore. Only touch files named in each task.

---

## Task 1: "Why you got this" accordion + FAQ dedupe

Adds the cold-outreach trust section (anchor `#why-you-got-this`, target for Task 2's micro-lines) and removes the now-duplicated "How did you get my information?" from the product FAQ.

**Files:** Modify `app/yourmap/page.tsx`.

- [ ] **Step 1:** Insert a new section immediately AFTER the closing CTA's product FAQ section is NOT where this goes — insert it AFTER the `TestimonialSection` (`<TestimonialSection />`, ~line 627) and BEFORE the "WHAT YOU'LL GET" section (`{/* ─── WHAT YOU'LL GET ... */}`, ~line 629). Insert exactly:

```tsx
      {/* ─── WHY YOU GOT THIS — cold-outreach trust accordion ────────── */}
      <section id="why-you-got-this" className="px-6 md:px-10 py-16 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span> Why you got
            this
          </div>
          <h2 className="font-display text-2xl md:text-3xl font-bold leading-tight tracking-tight mb-6 max-w-xl">
            No catch. <em>Here&rsquo;s the honest version.</em>
          </h2>
          <FAQAccordion
            items={[
              {
                q: 'Why are you reaching out to me?',
                a: (
                  <>
                    TurfMap is built by{' '}
                    <strong className="text-zinc-200">Fourdots Digital</strong>{' '}
                    — a digital marketing agency for home-services businesses.
                    We research local operators, and when we ran a preview of{' '}
                    {personalization
                      ? personalization.business_name
                      : 'your business'}{' '}
                    we saw a TurfScore that told us we might be able to help.
                    Rather than cold-pitch you, we wanted to lead with
                    something genuinely useful: your actual map. If it&rsquo;s
                    valuable and you&rsquo;d like to talk, great — if not, the
                    scan is yours either way, no strings.
                  </>
                ),
              },
              {
                q: "What's the catch?",
                a: (
                  <>
                    None — the full scan is free because it&rsquo;s how we
                    introduce ourselves. No subscription, no auto-enrollment,
                    no credit card. You keep the heatmap, competitor map, and
                    fix list. If you later want help executing the fixes,
                    that&rsquo;s a separate conversation you&rsquo;re free to
                    decline.
                  </>
                ),
              },
              {
                q: 'How did you get my information?',
                a: (
                  <>
                    We use publicly-available business data to identify
                    operators with significant local SEO weakness. Your
                    business name, address, and phone are listed publicly on
                    Google Business Profile, Yelp, and similar directories. We
                    ran a preview scan against this public data, identified
                    that you were missing visibility across your service area,
                    and reached out. No private data was accessed. If
                    you&rsquo;d prefer not to receive further outreach, simply
                    unsubscribe at the link in our email.
                  </>
                ),
              },
            ]}
          />
        </div>
      </section>
```

- [ ] **Step 2:** In the EXISTING product FAQ (heading "Things people ask before they buy.", ~line 896), remove the first item `q: 'How did you get my information?'` (answer starts "We use publicly-available business data...") so it now leads with "What if I find out my visibility is bad?". Leave the other four items. (The new accordion in Step 1 holds the canonical copy of that Q.)
- [ ] **Step 3:** `npm run lint && npm run typecheck` — typecheck clean, no new errors in page.tsx.
- [ ] **Step 4:** Commit: `feat(yourmap): 'why you got this' trust accordion + FAQ dedupe`.

---

## Task 2: Two trust micro-lines under the map

Adds the mockup's two under-map reassurance lines, linking to `#why-you-got-this`. They render in the hero right column beneath BOTH the `TheirDataTeaser` (personalized) and the sample fallback.

**Files:** Modify `app/yourmap/page.tsx`.

- [ ] **Step 1:** Add a colocated sub-component near the other hero helpers (e.g. after `RiskReversalCallout`):

```tsx
/** Two one-line trust teasers under the hero map — link to the "Why
 *  you got this" accordion (anchor #why-you-got-this). */
function HeroTrustLines() {
  return (
    <div className="mt-3 flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <ShieldCheck size={14} strokeWidth={2.25} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-lime)' }} />
        <p className="text-xs text-zinc-400 leading-relaxed">
          <strong className="font-semibold text-zinc-300">How do we know all this?</strong>{' '}
          A preview against your public Google Business Profile — no private data.{' '}
          <a href="#why-you-got-this" className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300 transition-colors">More ›</a>
        </p>
      </div>
      <div className="flex items-start gap-2">
        <HelpCircle size={14} strokeWidth={2.25} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-lime)' }} />
        <p className="text-xs text-zinc-400 leading-relaxed">
          <strong className="font-semibold text-zinc-300">What&rsquo;s the catch?</strong>{' '}
          None — it&rsquo;s free because it&rsquo;s how we introduce ourselves.{' '}
          <a href="#why-you-got-this" className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300 transition-colors">More ›</a>
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2:** Add `HelpCircle` to the `lucide-react` import (verify `ShieldCheck` is already imported — it is used by the trust strip; if not, add it too).
- [ ] **Step 3:** In the hero right column (`<div className="lg:col-span-5">`, ~line 532), render `<HeroTrustLines />` once, AFTER the `{personalization ? (<TheirDataTeaser .../>) : (<>...sample...</>)}` conditional closes but still inside the `lg:col-span-5` div, so it appears under the map on both paths. (i.e. place `<HeroTrustLines />` just before the closing `</div>` of the `lg:col-span-5` column.)
- [ ] **Step 4:** `npm run lint && npm run typecheck` — clean.
- [ ] **Step 5:** Commit: `feat(yourmap): under-map trust micro-lines linking to why-you-got-this`.

---

## Task 3: "What's behind the button" unlock manifest

Adds the 3-pillar preview-vs-full grid above the existing sample fix-list, inside the "WHAT YOU'LL GET" section — making the button's payload explicit. Keep the existing sample fix-list cards.

**Files:** Modify `app/yourmap/page.tsx`.

- [ ] **Step 1:** In the "WHAT YOU'LL GET" section (~line 629), change the eyebrow text "What you walk away with" → "What's behind the button" and the `<h2>` "A prioritized fix list. In plain English." → "One click reveals the full picture.". Then, immediately AFTER that `<h2>` and BEFORE the existing intro `<p>` (the "Three prioritized actions specific to your business..." paragraph), insert the 3-pillar grid:

```tsx
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {[
              { icon: Grid3x3, title: 'Your exact heatmap', now: 'one score', unlocks: 'all 81 cells, block by block' },
              { icon: MapPin, title: 'Competitor map', now: 'your top competitor', unlocks: 'who owns which cells, every competitor' },
              { icon: Sparkles, title: 'AI Coach Fix List', now: 'nothing', unlocks: 'your top 3 prioritized actions' },
            ].map((p) => {
              const Icon = p.icon;
              return (
                <div key={p.title} className="border rounded-lg p-5" style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
                  <Icon size={20} style={{ color: 'var(--color-lime)' }} />
                  <div className="font-display font-bold text-base mt-3 mb-3 text-zinc-100">{p.title}</div>
                  <div className="text-xs text-zinc-500 leading-relaxed"><span className="text-zinc-600">Now:</span> {p.now}</div>
                  <div className="text-xs text-zinc-300 leading-relaxed"><span style={{ color: 'var(--color-lime)' }}>Unlocks:</span> {p.unlocks}</div>
                </div>
              );
            })}
          </div>
```

(Leave the existing intro paragraph, "The fix list" sub-label, and the sample fix-list cards as-is below the new grid.)

- [ ] **Step 2:** Add `Grid3x3` and `MapPin` to the `lucide-react` import (`Sparkles` already imported). Verify `Grid3x3` exists in the installed lucide-react (grep node_modules); if not, use `LayoutGrid` for both import and usage, and report which.
- [ ] **Step 3:** `npm run lint && npm run typecheck` — clean.
- [ ] **Step 4:** Commit: `feat(yourmap): unlock manifest pillars above the fix list`.

---

## Task 4: CTA copy unification + closing headline + subtext trim

**Files:** Modify `app/yourmap/page.tsx` and `components/marketing/ColdscanRunButton.tsx`.

- [ ] **Step 1:** Add a module-level helper to `app/yourmap/page.tsx` (below the `pickFirst` helper):

```tsx
/** Shared price-aware CTA label. "free" on the COLDSCAN $0 path. */
function fullScanLabel(finalCents: number): string {
  return finalCents === 0
    ? 'Run the full scan — free'
    : `Run the full scan — ${formatUsd(finalCents)}`;
}
```

- [ ] **Step 2:** Replace ALL FOUR CTA `label` props with `label={fullScanLabel(finalCents)}` — the two inside `PricePanel` (its `ColdscanRunButton` `label="Run my free TurfScan"` and its `ScanIntakeLinkButton` ternary label) and the two in the closing CTA section (~lines 1040 and 1051). Change no other props.
- [ ] **Step 3:** In the closing CTA, change the headline "Ready to see your map?" → "Ready to see your real map?".
- [ ] **Step 4:** In `components/marketing/ColdscanRunButton.tsx`, replace the helper `<p>` subtext (currently "One click. Your scan runs in ~30-60 seconds and we'll show your TurfMap as soon as it's done.") with: "One click — runs in ~30–60 seconds and reveals your exact 81-cell heatmap, full competitor map, and your 3 prioritized fixes. No credit card required." (en-dash in ~30–60; keep the `<p>` element/classes).
- [ ] **Step 5:** `npm run lint && npm run typecheck` — clean, no unused `fullScanLabel`.
- [ ] **Step 6:** Commit: `feat(yourmap): 'Run the full scan — free' CTA + 'see your real map' + trimmed subtext`.

---

## Task 5: Ship & verify

- [ ] **Step 1:** Final `npm run lint && npm run typecheck`.
- [ ] **Step 2:** `git push origin main` (Vercel auto-deploys).
- [ ] **Step 3:** After deploy, fetch Carl's URL and confirm the four new beats rendered, plus the bare `/yourmap` fallback still renders:
  `https://www.turfmap.ai/yourmap?prospect_id=2Zk85zoxv4&coupon=COLDSCAN&utm_source=cold_email&utm_medium=outbound&utm_campaign=roofing_manvel_q2_2026`
  Confirm: under-map micro-lines present + the `#why-you-got-this` anchor scroll works; "What's behind the button" pillars; "Why you got this" accordion with the Fourdots copy; CTA reads "Run the full scan — free". Then fetch bare `https://www.turfmap.ai/yourmap` and confirm no crash, sample-fallback map renders, micro-lines still present.
- [ ] **Step 4:** Report deployed + verified; suggest the Carl follow-up.

## Self-review
Covers the four approved-mockup gaps (micro-lines, manifest, why-you-got-this, CTA) against the live base; preserves all Part B components; no `representativeHeatmap.ts` (superseded by `TheirDataTeaser`); CTA helper used at all four sites; FAQ deduped so "how did you get my info" appears once (in the new accordion).
