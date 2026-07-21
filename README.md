# Competition Studio

Competition Studio is a capacity-first sports competition platform built with Next.js 16, React 19, TypeScript and Kysely.

Milestone 3 adds the first authoritative competition engine: every division owns a versioned stage graph, real fixtures and typed advancement dependencies, while one competition-wide constraint scheduler coordinates shared pitches or courts. Release 0.3.1 also hardens the production build and verifies authenticated routes against a real production server.

## What is implemented

### Public SEO and GEO acquisition layer

- Tournament Capacity Calculator
- Competition Format Planner
- Match Count Calculator
- Round Robin Generator with CSV export
- Group-to-Knockout Planner
- Sport hubs for Canoe Polo, Badminton, Table Tennis, Volleyball and Basketball
- Format pages and planning pages for 8, 12, 16, 24 and 48 entries
- Crawlable example competition pages for overview, schedule, standings, bracket and results
- XML sitemap index, public-content quality gates, canonical metadata and structured data
- Separate crawler controls for search discovery and model training

### Organizer foundation

- Account signup, login and logout
- Salted `scrypt` password hashes
- HttpOnly, SameSite session cookies backed by hashed database tokens
- Organizations, memberships and active-organization sessions
- Owner, organizer, staff, official and viewer roles
- Capacity-first Assisted Setup
- One sport per competition
- Free-plan enforcement for one active competition and 16 total entries
- Persistent divisions, entries, format revisions, fixtures, schedule revisions and audit events
- Competition archive and guarded deletion
- One-month expiry for unpublished schedule revisions
- Organizer-only schedule publication

### Shared stage graph

- An independent selected format revision for every division
- Stage types:
  - Group stage
  - Round robin
  - Single elimination
  - Ranking bracket
- Typed advancement routes:
  - Group rank
  - Best group rank
  - Stage winner
  - Stage loser
  - Manual slots
- Manual stage editor
- Drag-and-drop visual editor using the same graph state
- Persistent canvas column and row positions
- Compact, balanced and participation templates for 8, 12, 16, 24 and 48 entries
- Structural validation before persistence
- Immutable revision history; replacing a selected format supersedes rather than overwrites it

### Authoritative fixtures and dependencies

- Seeded snake allocation for preliminary groups
- Round-robin fixtures and repeated cycles
- Advancement-fed intermediate group stages
- Knockout rounds and optional third-place matches
- Stable division-prefixed match codes
- Typed home and away participant sources
- Match-to-match winner and loser dependencies
- Group-rank and cross-group qualification sources
- Competition-wide loading of fixtures from every active division
- Scoped format invalidation: editing one division preserves the other divisions' fixtures

### Constraint scheduler

- Capacity based on days, daily hours, playing areas and one time slot per match
- Hard requirements:
  - No duplicate pitch/court slot
  - No known participant in simultaneous matches
  - Match dependencies occur in order
  - Locked assignments remain fixed
  - Required minimum rest
  - Required back-to-back avoidance
  - Required maximum matches per day
- Preferred constraints that influence the quality score without always blocking a result
- Fastest, balanced, rest-focused and recovery objectives
- Multiple immutable schedule revisions
- Quality, finish, minimum-rest, average-rest, preference and movement metrics
- Competition-wide optimization across divisions sharing the same resources
- Draft selection and comparison
- Per-match locks
- Affected-match and downstream repair that preserves unaffected assignments
- Database uniqueness protection against two matches occupying the same area and slot in one revision

### Current scorekeeper proof

The protected scorekeeper demo still demonstrates the intended interaction model:

- Manual event-time input
- Canoe Polo goal-scorer attribution
- Append-only events
- Reversal actions rather than destructive deletion

It is not yet connected to authoritative matches. Signed QR access and persisted scoring are the next milestone.

## Technology stack

- Next.js 16 App Router
- React 19
- TypeScript
- Kysely query builder and migrations
- PostgreSQL for hosted environments
- Node.js built-in SQLite adapter for local development and isolated audits
- Plain CSS design system
- Lucide icons
- Playwright Core browser-audit script for staging environments

## Requirements

- Node.js 22 or newer
- npm, pnpm 11 or another compatible package manager
- PostgreSQL for staging and production, or SQLite for local development

The SQLite adapter uses Node's experimental `node:sqlite` API and may display an experimental warning. Use PostgreSQL for hosted competition operations.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000`.

The default seed creates only the five launch sports. It does not create a known organizer account.

To create an explicit local demo organizer:

```bash
DEMO_USER_EMAIL=you@example.com \
DEMO_USER_PASSWORD='A-strong-local-password-2026' \
DEMO_USER_NAME='Your Name' \
npm run db:seed
```

Production demo seeding is blocked unless `ALLOW_DEMO_SEED=true` is intentionally supplied.

## PostgreSQL configuration

```bash
DATABASE_URL=postgresql://user:password@host:5432/competition_studio
DATABASE_POOL_MAX=5
DATABASE_SSL=require
DB_AUTO_MIGRATE=false
```

Recommended deployment order:

```bash
npm ci
npm run db:migrate
npm run check
npm start
```

Run migrations as a separate deployment step. Database clients are created lazily, so `next build` does not require a runtime connection string.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for metadata and sitemaps | `http://localhost:3000` |
| `DATABASE_URL` | Hosted PostgreSQL connection string | unset |
| `DATABASE_POOL_MAX` | PostgreSQL pool maximum | `5` |
| `DATABASE_SSL` | Set `disable` only for trusted local PostgreSQL | hosted TLS default |
| `DATABASE_PATH` | Local SQLite database path | `.data/competition-studio.sqlite` |
| `DB_AUTO_MIGRATE` | Run migrations automatically at runtime | `true` |
| `SESSION_COOKIE_NAME` | Authentication cookie name | `competition_studio_session` |
| `SESSION_TTL_DAYS` | Session lifetime | `30` |
| `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` | Explicit local demo credentials | unset |
| `ALLOW_DEMO_SEED` | Permit deliberate production fixture seeding | `false` |

## Database commands

```bash
npm run db:migrate
npm run db:seed
npm run db:reset
npm run test:database
npm run test:stage-scheduler-db
npm run test:milestone3-db
```

`db:reset` deletes only the configured local SQLite database and refuses to operate when `DATABASE_URL` is present.

## Validation commands

```bash
npm run lint
npm run typecheck
npm run test:routes
npm run test:artifacts
npm run test:engine
npm run test:stage-scheduler
npm run test:database
npm run test:stage-scheduler-db
npm run test:milestone3-db
npm run test:seo
npm run build
npm run test:authenticated-routes
```

Or run the principal source suite:

```bash
npm run check
```

The GitHub Actions workflow in `.github/workflows/ci.yml` runs the same source, database, build-artifact and authenticated production-route gates on every pull request and push to `main`.

The authenticated production-route audit starts its own isolated production server and database:

```bash
npm run test:authenticated-routes
```

With a separate production server running, use:

```bash
AUDIT_BASE_URL=http://127.0.0.1:3000 npm run test:rendered
AUDIT_BASE_URL=http://127.0.0.1:3000 npm run test:browser
```

The browser audit creates an organizer and competition. Never point it at production.


## Production build safety

The build process always produces the directory that Next.js will serve: `.next`. It does not rename a build created with another `distDir`. Before a new build starts, the previous verified build is moved to a rollback directory and is restored if compilation or artifact validation fails.

Validation checks:

- No URL-encoded or colliding App Router source paths.
- `required-server-files.json` records `.next` as the runtime `distDir`.
- Every App Router page has a client-reference manifest.
- `npm start` refuses to serve an incomplete or mismatched build.
- Authenticated format, schedule and overview routes return HTTP 200 from the production server.

The isolated database audits explicitly ignore any inherited `DATABASE_URL`, preventing `npm run check` from writing test fixtures into a configured hosted database.

## Important routes

| Purpose | Route |
|---|---|
| Home | `/` |
| Capacity calculator | `/tools/tournament-capacity-calculator` |
| Public example competition | `/competitions/singapore-canoe-polo-open-2026` |
| Signup | `/signup` |
| Login | `/login` |
| Organizer dashboard | `/app` |
| New competition wizard | `/app/new` |
| Competition overview | `/app/competitions/[id]` |
| Division format designer | `/app/competitions/[id]/format` |
| Competition-wide scheduler | `/app/competitions/[id]/schedule` |
| Entries | `/app/competitions/[id]/entries` |
| Audit history | `/app/competitions/[id]/audit` |
| Scorekeeper proof | `/score/demo-match` |
| Health API | `/api/health` |

## Domain model

```text
Organization
 └─ Competition (one sport)
     ├─ Division A
     │   ├─ Entries
     │   └─ Selected Format Revision
     │       ├─ Stage Nodes + Layouts
     │       ├─ Advancement Edges
     │       ├─ Seeded Assignments
     │       └─ Matches + Participant Dependencies
     ├─ Division B
     │   └─ Independent selected graph and fixtures
     ├─ Competition-wide Schedule Constraints
     ├─ Schedule Revisions
     │   ├─ Scheduled Match Assignments
     │   └─ Optimization Summary
     └─ Audit Events
```

The graph is division-owned; the timetable is competition-owned because all divisions can share pitches, courts or playing areas.

## Correctness boundaries

The current implementation deliberately prevents several unsafe shortcuts:

- A competition-wide schedule is not generated until every active division with entries has a selected format.
- Editing one division invalidates the shared schedule, but does not delete another division's format or fixtures.
- A stage graph cannot be saved when it has cycles, multiple seeded roots, missing routes, impossible ranks, overfilled stages or more than one championship path.
- A published schedule blocks format replacement.
- A started or completed match blocks format replacement.
- Two scheduled matches cannot occupy the same revision, day, time and playing area at the database layer.
- Result scoring is not yet enabled against these matches, avoiding premature live-event dependence.

## Remaining work before real-event dependence

- Managed PostgreSQL staging migration and concurrency proof
- Email verification, password recovery and external rate limiting
- Organization invitations and organization switching UI
- Direct manual schedule movement and visual timeline editing
- Officials and official availability
- Database-backed public competition publishing and privacy gates
- Signed match-specific QR tokens and fallback number codes
- Single-writer device transfer
- Persisted score events, result finalization and downstream recalculation
- Realtime delivery and offline scoring reconciliation
- AI text-to-format and paid usage ledger
- Registration and payments in a later release

## Next milestone

The authoritative fixture graph now exists, so the next safe milestone is **signed QR scorekeeping against persisted matches**:

1. Match access passes and fallback codes
2. One active writer with controlled device transfer
3. Persisted append-only score events and reversals
4. Immediate result publication
5. Standings and advancement recalculation
6. Schedule-conflict detection after result correction
7. Realtime spectators and offline command queues

See:

- `docs/MILESTONE_3_REPORT.md`
- `docs/STAGE_GRAPH_AND_SCHEDULER.md`
- `docs/DATABASE_SCHEMA.md`
- `docs/VERIFICATION_REPORT.md`
- `IMPLEMENTATION_STATUS.md`
