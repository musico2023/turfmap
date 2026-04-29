# TurfMap™ Build Spec
**An exclusive feature of Local Lead Machine** · Build Document v1.0

---

## TL;DR — What this will cost you

| Scale | Monthly cost | Cost per client | Notes |
|---|---|---|---|
| **MVP (1–5 clients)** | ~$50–60/mo | $10–60 | Mostly fixed infra. Free tier on Supabase works here. |
| **Growth (10–25 clients)** | ~$75–110/mo | $4–8 | Worth upgrading Supabase to Pro for backups. |
| **Scale (50–100 clients)** | ~$130–225/mo | $2–4 | Add a CDN, monitor query volume. |
| **High-scale (200+ clients)** | ~$400–700/mo | $2–3.50 | Negotiate volume discount with DataForSEO. |

**The math at agency scale (50 clients × $3,500/mo Silver tier = $175K MRR):** TurfMap costs you ~$3.50/client to run, you charge $3,500/client. The dashboard is a 99.9% gross margin component of the offer.

---

## Detailed Cost Breakdown

### Fixed monthly costs (regardless of client count)

| Service | Tier | Cost | Why |
|---|---|---|---|
| Vercel | Pro | $20 | Hosting, cron jobs, edge functions |
| Supabase | Pro | $25 | Postgres, auth, storage, daily backups |
| Domain (subdomain of fourdots) | — | $0 | Use `app.locallleadmachine.com` |
| Sentry (error tracking) | Free | $0 | Free tier covers up to 5K events/mo |
| Stripe | Pay-per-use | 2.9% + $0.30 | Only if billing clients through dashboard |
| **Subtotal** | | **~$45/mo** | |

### Variable costs (per client, per month)

Assuming each client tracks **5 keywords**, scanned **weekly** with **2 on-demand scans/month**:

| API | Math | Cost per client |
|---|---|---|
| DataForSEO Standard Queue (scheduled scans) | 5 keywords × 81 points × 4 weeks = 1,620 queries × $0.0006 | **$0.97** |
| DataForSEO Live Mode (on-demand) | 2 × 5 × 81 = 810 queries × $0.002 | **$1.62** |
| Anthropic API (AI Coach, 4 generations/mo) | ~1,200 tokens × 4 × Sonnet 4 pricing | **$0.04** |
| Google Places API (competitor data) | ~50 lookups/mo × free tier or $0.017 | **~$0.85** |
| **Variable per client** | | **~$3.50/mo** |

### Hidden costs to budget for

- **Initial build time:** 5–15 days of focused work (yours or a contractor's). At a $100/hr contractor rate, that's $4,000–12,000. Doing it yourself in Claude Code, the cost is your time + ~$50–150 in Claude API credits during the build.
- **Ongoing maintenance:** ~3–6 hrs/month for dependency updates, bug fixes, Google API changes. Budget $300–900/mo if outsourcing this.
- **Buffer for surprises:** Google APIs change. DataForSEO occasionally adjusts pricing. Budget 20% headroom.

### What you do *not* pay for
- No per-seat licensing (build it once, scale to unlimited clients)
- No monthly SaaS subscriptions to Local Falcon, BrightLocal, etc.
- No credit caps that throttle you mid-month

---

## Tech Stack (Final Decisions)

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 (App Router)** | Server components for cheap renders, built-in API routes |
| Language | **TypeScript** | Catches API response shape errors at compile time |
| Styling | **Tailwind CSS v4 + shadcn/ui** | Matches the prototype, agency-grade components free |
| Database | **Supabase (Postgres)** | Auth + DB + storage in one, RLS for multi-tenant safety |
| Auth | **Supabase Auth** | Magic link login for clients, email/password for staff |
| Hosting | **Vercel** | Cron jobs included, edge runtime for fast API routes |
| Cron | **Vercel Cron** | Weekly scheduled scans, no extra service needed |
| Geo data | **DataForSEO Local Pack API** | Cheapest reliable source, UULE-based geolocation |
| AI | **Anthropic Claude Sonnet 4** | For TurfMap AI Coach (you're already using it) |
| Maps tile background | **None — use stylized SVG grid** | Zero Maps API costs, more brandable than embedded Google Maps |
| PDF reports | **react-pdf or Puppeteer on Vercel** | White-label PDF export of TurfReports |
| Email | **Resend** | $0 free tier, $20/mo for 50K emails |
| Error tracking | **Sentry** | Free tier sufficient for years |

### Why no Google Maps embed
Tempting but unnecessary. The stylized grid in your prototype is more brandable, has zero Maps API cost, and renders fast. Real heatmap tools all use overlays anyway — your customers don't need to see actual streets. Save the $200/mo Google Maps Platform fee.

---

## Database Schema

```sql
-- Users (you and your team)
create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  full_name text,
  role text check (role in ('admin', 'manager', 'analyst')) default 'analyst',
  created_at timestamptz default now()
);

-- Clients (your customers - the home services businesses)
create table clients (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  address text not null,
  latitude numeric(10, 7) not null,
  longitude numeric(10, 7) not null,
  pin_lat numeric(10, 7), -- if SAB and pin differs from address
  pin_lng numeric(10, 7),
  service_radius_miles numeric default 1.6,
  industry text, -- 'plumbing', 'hvac', 'roofing', etc.
  primary_color text default '#c5ff3a', -- for white-label per client
  logo_url text,
  status text check (status in ('active', 'paused', 'churned')) default 'active',
  monthly_price_cents integer,
  stripe_customer_id text,
  onboarded_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Keywords being tracked per client
create table tracked_keywords (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  keyword text not null,
  is_primary boolean default false,
  scan_frequency text check (scan_frequency in ('daily', 'weekly', 'biweekly', 'monthly')) default 'weekly',
  created_at timestamptz default now(),
  unique(client_id, keyword)
);

-- Each scan = one keyword scanned at one point in time
create table scans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  keyword_id uuid references tracked_keywords(id) on delete cascade,
  scan_type text check (scan_type in ('scheduled', 'on_demand')) not null,
  grid_size integer default 9, -- 9x9 = 81 points
  status text check (status in ('queued', 'running', 'complete', 'failed')) default 'queued',
  -- Computed metrics
  turf_score numeric, -- AMR
  top3_win_rate numeric, -- %
  turf_radius_units integer, -- in grid units, multiply by cell distance for miles
  total_points integer,
  failed_points integer default 0,
  -- DataForSEO cost tracking
  dfs_cost_cents integer,
  -- Timing
  started_at timestamptz default now(),
  completed_at timestamptz,
  created_at timestamptz default now()
);

-- Each grid point's result for a scan
create table scan_points (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid references scans(id) on delete cascade,
  grid_x integer not null,
  grid_y integer not null,
  latitude numeric(10, 7) not null,
  longitude numeric(10, 7) not null,
  rank integer, -- null = not ranked in top 100
  business_found boolean default false,
  -- Top 3 competitors at this point (jsonb for flexibility)
  competitors jsonb, -- [{name, place_id, rank}, ...]
  raw_response jsonb, -- store the DFS response for debugging
  created_at timestamptz default now()
);

create index idx_scan_points_scan_id on scan_points(scan_id);

-- AI Coach insights (one per scan, regenerable)
create table ai_insights (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid references scans(id) on delete cascade,
  diagnosis text,
  actions jsonb, -- [{priority, action, why}, ...]
  projected_impact text,
  model text default 'claude-sonnet-4',
  prompt_version text, -- for tracking which prompt template generated this
  created_at timestamptz default now()
);

-- Aggregated competitor tracking (extracted from scan_points)
create table competitors (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  competitor_name text not null,
  google_place_id text,
  -- Most recent snapshot
  last_amr numeric,
  last_top3_pct numeric,
  last_seen_at timestamptz,
  created_at timestamptz default now(),
  unique(client_id, google_place_id)
);

-- Client-facing user accounts (for the white-label portal)
create table client_users (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  email text unique not null,
  invited_at timestamptz default now(),
  last_login_at timestamptz
);

-- Row Level Security: clients can only see their own data
alter table clients enable row level security;
alter table scans enable row level security;
alter table scan_points enable row level security;
alter table ai_insights enable row level security;
-- (RLS policies added in setup)
```

### Key index decisions
- `scan_points.scan_id` — the heatmap render queries this constantly
- Add `scans (client_id, completed_at desc)` for the trend chart
- `tracked_keywords (client_id)` for the keyword list

---

## File Structure

```
turfmap/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── magic-link/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx               # sidebar + header
│   │   ├── page.tsx                 # agency overview (all clients)
│   │   ├── clients/
│   │   │   ├── page.tsx             # client list
│   │   │   ├── new/page.tsx         # onboard client
│   │   │   └── [id]/
│   │   │       ├── page.tsx         # client dashboard (TurfMap UI)
│   │   │       ├── scans/page.tsx   # scan history
│   │   │       ├── settings/page.tsx
│   │   │       └── reports/page.tsx
│   │   └── settings/page.tsx
│   ├── (portal)/                    # white-label client-facing
│   │   └── [slug]/
│   │       └── page.tsx             # branded client view
│   ├── api/
│   │   ├── scans/
│   │   │   ├── trigger/route.ts     # on-demand scan
│   │   │   └── [id]/route.ts        # scan status / cancel
│   │   ├── ai/
│   │   │   └── insights/route.ts    # AI Coach generation
│   │   ├── reports/
│   │   │   └── pdf/route.ts         # generate TurfReport PDF
│   │   ├── webhooks/
│   │   │   └── stripe/route.ts
│   │   └── cron/
│   │       └── weekly-scans/route.ts # called by Vercel Cron
│   └── layout.tsx
├── components/
│   ├── turfmap/
│   │   ├── HeatmapGrid.tsx          # the SVG heatmap (from prototype)
│   │   ├── StatCard.tsx
│   │   ├── AICoach.tsx
│   │   ├── CompetitorTable.tsx
│   │   ├── ScanButton.tsx
│   │   └── TurfReportPDF.tsx
│   ├── dashboard/
│   │   ├── Sidebar.tsx
│   │   ├── ClientCard.tsx
│   │   └── TrendChart.tsx
│   └── ui/                          # shadcn components
├── lib/
│   ├── dataforseo/
│   │   ├── client.ts                # API wrapper
│   │   ├── localPack.ts             # Local Pack scan logic
│   │   └── grid.ts                  # 9x9 grid coordinate generation
│   ├── anthropic/
│   │   ├── client.ts
│   │   └── prompts/
│   │       └── turfCoach.ts         # AI Coach prompt template
│   ├── supabase/
│   │   ├── server.ts
│   │   ├── client.ts
│   │   └── types.ts                 # generated from schema
│   ├── metrics/
│   │   ├── turfScore.ts             # AMR calculation
│   │   ├── top3Rate.ts
│   │   └── turfRadius.ts
│   └── pdf/
│       └── generateReport.ts
├── public/
│   └── brand/
├── supabase/
│   ├── migrations/
│   │   └── 0001_initial.sql
│   └── seed.sql
├── .env.local                       # DFS_LOGIN, DFS_PASSWORD, ANTHROPIC_API_KEY, etc.
├── package.json
├── tailwind.config.ts
└── README.md
```

---

## API Integration Sequence (Build Phases)

### Week 1 — Foundation
1. Spin up Next.js + Tailwind + Supabase locally
2. Create the database schema, run migrations, seed with one test client
3. Build the **DataForSEO wrapper** in `lib/dataforseo/`:
   - `generateGridCoordinates(centerLat, centerLng, gridSize, radiusMiles)` returns 81 coordinate pairs
   - `runLocalPackScan(keyword, coordinates[])` batches the requests, returns rank for each point
4. Build a CLI script `scripts/test-scan.ts` that runs a real scan against your test client and saves to DB. **Don't build any UI yet — get the data flow working first.**

### Week 2 — Dashboard UI
1. Port the prototype `HeatmapGrid` component into the Next.js app
2. Wire it to real scan data from Supabase
3. Build the agency dashboard (client list, search, status pills)
4. Build the per-client dashboard (the prototype, but with real data and history dropdown)
5. Add the on-demand scan button → triggers `api/scans/trigger`

### Week 3 — Production polish
1. Vercel Cron job for weekly scheduled scans (`/api/cron/weekly-scans`)
2. AI Coach endpoint (`/api/ai/insights`) — port the prompt from your prototype
3. PDF TurfReport generator (Puppeteer renders the dashboard, exports to PDF)
4. Client-facing white-label portal route
5. Stripe webhook handler if billing through the dashboard
6. Sentry integration, error states, empty states

### Week 4 (optional) — Differentiators
- Competitor overlay view (toggle to show top competitor's heatmap on top of yours)
- Trend lines (TurfScore over the past 12 weeks)
- Slack/email alerts when TurfScore changes by >X
- Bulk import (onboard 10 clients via CSV)
- White-label per-client branding (logo, color, custom subdomain)

---

## The Claude Code Kickoff Prompt

Save this as `CLAUDE.md` in your project root before starting. Then your first Claude Code session is just: *"Read CLAUDE.md and let's start with Phase 1."*

```markdown
# TurfMap Build Context

## Project
TurfMap™ is a proprietary geo-grid rank tracking dashboard, built as an exclusive
feature of Local Lead Machine (a productized SEO offer for home services businesses
by Fourdots Digital).

## My role
I'm Anthony, founder of Fourdots Digital. I'm building this myself with you (Claude
Code) on macOS. I'm comfortable with code but not a full-time developer — explain
non-obvious decisions, but don't over-explain syntax.

## Stack (locked decisions, do not suggest alternatives)
- Next.js 15 App Router, TypeScript
- Tailwind CSS v4 + shadcn/ui
- Supabase (Postgres + Auth + Storage)
- DataForSEO Local Pack API (Standard Queue for cron, Live Mode for on-demand)
- Anthropic Claude Sonnet 4 for AI Coach
- Vercel hosting + Vercel Cron
- Resend for transactional email

## Architectural principles
1. Server components by default. Client components only when interactivity is needed.
2. All DataForSEO calls go through `lib/dataforseo/client.ts` — never call from a component.
3. All metrics calculation in `lib/metrics/` — pure functions, easy to test.
4. Multi-tenant via Supabase RLS. A client can NEVER see another client's data.
5. The 81-point grid is fixed (9x9). Don't make it configurable in v1.
6. White-label is per-client (their logo, their color), but the agency owns the data.

## Visual reference
The prototype is in `references/turfmap_dashboard.jsx`. Match the aesthetic exactly:
- Dark theme: #0a0a0a background, #0d0d0d cards, #27272a borders
- Accent: #c5ff3a (lime)
- Display font: Bricolage Grotesque
- Mono: JetBrains Mono
- Cells reveal in waves from center outward during scan

## Build phases
We're in **Phase 1** right now. Don't touch the UI yet. Goals for this session:
1. Initialize Next.js project
2. Set up Supabase locally with the schema in `docs/schema.sql`
3. Build `lib/dataforseo/client.ts` and `lib/dataforseo/grid.ts`
4. Write `scripts/test-scan.ts` that runs a real scan for a hardcoded
   Toronto plumber and stores results in Supabase

## Things I care about
- Cost discipline: log every DataForSEO request to a `dfs_cost_cents` field on the scan
- Type safety: generate types from the Supabase schema, don't hand-write them
- Deployability: every commit should deploy cleanly to Vercel

## Things I don't care about
- 100% test coverage (we'll add tests for `lib/metrics/` only)
- Mobile responsiveness in v1 (this is a desktop tool for me + clients)
- Internationalization

Let's go.
```

---

## Risk & Hidden Cost Watchlist

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Google changes Local Pack format | Medium | High | DataForSEO updates within days; have a Sentry alert on parse errors |
| DataForSEO raises prices | Low | Medium | Pricing has been stable since 2022. Negotiate volume discount at 50+ clients |
| Vercel/Supabase outage | Low | High | Status page integrated into your dashboard footer. Self-host fallback path documented |
| You don't maintain it for 6 months | Medium | Medium | Document everything. Use Renovate bot for dependency updates. Consider a $500/mo retainer dev |
| Client requests features you didn't scope | High | Low | Tier the offer. Custom features = upsell to Gold tier |
| Competitor agency copies the UI | Low | Low | The data + AI prompt is the moat, not the UI. Improve the prompt monthly |

---

## Success metrics for the build itself

After 30 days post-launch, you should be able to answer "yes" to all of these:

- [ ] Can I onboard a new client in under 10 minutes (address → first scan → live dashboard)?
- [ ] Is my COGS per client under $5/mo?
- [ ] Does a client log in and immediately understand their TurfScore without explanation?
- [ ] Have I generated at least one signed-and-paid Local Lead Machine contract that mentions TurfMap as a deciding factor?
- [ ] Has the AI Coach generated insight that I would actually act on as the SEO operator?

If yes to all five, the build paid for itself.

---

*Build doc by Claude · Reach out for spec updates as the product evolves*
