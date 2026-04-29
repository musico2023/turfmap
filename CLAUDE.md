# TurfMap.ai — Build Context

## Project

**TurfMap.ai** is a proprietary geo-grid rank tracking dashboard built by Fourdots Digital. It powers **Local Lead Machine** — our productized SEO offer for home services businesses (plumbers, HVAC, roofers, electricians, etc.).

## Brand & domain architecture

- `turfmap.ai` → the app. This is where clients log in. Vercel-hosted, Next.js.  
- `localleadmachine.io` → the marketing/sales site. Separate property, do not confuse the two.  
- TurfMap is **not** sold as a standalone SaaS. It is the moat for Local Lead Machine. Treat it as proprietary tech that only LLM clients access.

## Who I am

I'm Anthony, founder of Fourdots Digital. I'm building this myself with you (Claude Code) on macOS. I'm comfortable with code but not a full-time developer — explain non-obvious architectural decisions, but don't over-explain syntax. I move fast and prefer working solutions over theoretical perfection.

## Stack (locked decisions — do not suggest alternatives)

- **Next.js 15** (App Router) \+ **TypeScript**  
- **Tailwind CSS v4** \+ **shadcn/ui**  
- **Supabase** (Postgres \+ Auth \+ Storage)  
- **DataForSEO Local Pack API** — Standard Queue ($0.0006/req) for scheduled scans, Live Mode ($0.002/req) for on-demand  
- **Anthropic Claude Sonnet 4** for the TurfMap AI Coach  
- **Vercel** hosting \+ **Vercel Cron** for scheduled scans  
- **Resend** for transactional email  
- **Sentry** (free tier) for error tracking

If you think a different choice is materially better, raise it once with reasoning. If I say "stick with the spec," drop it.

## Architectural principles

1. **Server components by default.** Client components only when interactivity is required.  
2. **All DataForSEO calls go through `lib/dataforseo/client.ts`** — never call from a component or a route handler directly.  
3. **All metric calculations live in `lib/metrics/`** — pure, testable functions.  
4. **Multi-tenant safety via Supabase RLS.** A client must never see another client's data. Test this explicitly.  
5. **The 81-point grid (9×9) is fixed in v1.** Don't make it configurable.  
6. **Cost discipline:** every DataForSEO request logs to a `dfs_cost_cents` field on the related `scans` row. We track unit economics from day one.  
7. **White-label per client** (their logo, their accent color), but the agency owns the data and infrastructure.

## Visual reference

The visual prototype lives at `references/turfmap_dashboard.jsx`. Match the aesthetic exactly:

- Dark theme: `#0a0a0a` background, `#0d0d0d` cards, `#27272a` borders  
- Brand accent: `#c5ff3a` (lime)  
- Display font: Bricolage Grotesque  
- Mono: JetBrains Mono  
- Heatmap cells reveal in waves from center outward during a scan  
- Branding in header: `Crosshair` icon in a lime square \+ "TurfMap.ai" wordmark \+ "An exclusive feature of Local Lead Machine" subtitle

If a UI decision isn't covered in the prototype, ask before inventing.

## Build phases

We're in **Phase 1**. Don't touch the UI yet. Goals for the current session:

1. Initialize Next.js project, point local dev at `turfmap.ai` via the `/etc/hosts` trick or a `.local` subdomain  
2. Set up Supabase locally with the schema in `docs/schema.sql`  
3. Build `lib/dataforseo/client.ts` and `lib/dataforseo/grid.ts` (coordinate generation for the 9×9 grid)  
4. Write `scripts/test-scan.ts` that runs a real scan against a hardcoded Toronto plumber and stores the results in Supabase  
5. Verify cost tracking — the test scan should write a `dfs_cost_cents` value matching DFS's reported cost

**Do not start on UI until Phase 1 produces a real heatmap dataset in the database.** The data flow is the risky part; the UI is already designed.

## Phases that come after (don't get ahead of yourself)

- **Phase 2:** Port the prototype into the live app, wire to real Supabase data, add scan history  
- **Phase 3:** Vercel Cron for scheduled scans, AI Coach endpoint, PDF TurfReports, white-label client portal  
- **Phase 4 (optional):** Competitor overlay, trend lines, Slack alerts, bulk client import

## Things I care about

- **Cost discipline.** Surface unit economics in the dashboard itself eventually.  
- **Type safety.** Generate Supabase types from the schema, don't hand-write them.  
- **Deployability.** Every commit deploys cleanly to Vercel. Use preview deployments per PR.  
- **Brand consistency.** This is a premium-priced offering. The product must feel premium.

## Things I don't care about (in v1)

- 100% test coverage (write tests for `lib/metrics/` only)  
- Mobile responsiveness (this is a desktop tool for me and clients)  
- Internationalization  
- Dark/light mode toggle (we're dark-only by design)

## Working agreement

- When you finish a phase milestone, summarize what shipped \+ what's next, then stop and wait for me.  
- Run linter and type check before declaring "done." I should never have to point out a TS error.  
- When you find ambiguity, ask one focused question. Don't ask three.  
- Commit often with clear messages. Use conventional commits format.

Let's go.  
