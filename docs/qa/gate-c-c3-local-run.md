# Gate C C3 Multi-Platform exact-SHA local evidence

Local Gate C C3 validation: PASS

Validated scope: Multi-Platform C3 offline/online test harness, browser matrix (5 projects), physical iOS Safari & Android Chrome validation, monotonic ordering, zero score loss, writer fencing.

Source SHA: `8f7196478ce653b6f6dbb2940d89c92ae3d7cd92`
Branch: `integration/gate-c-final`

Evidence collected: 21 August 2026, Asia/Singapore

## Environment

- Darwin `arm64`
- Node `v24.18.0`
- pnpm `10.33.0`
- PostgreSQL `18.4`
- Redis `8.2.7`
- Playwright `1.61.1`
- Chromium `149.0.7827.55`
- WebKit `26.5`
- Firefox `144.0`

## Executed Matrix & Results

1. **Browser Matrix (5 Projects)**:
   - `gate-c-c3-phone-chromium`: 15 scenarios executed, 15 passed.
   - `gate-c-c3-phone-webkit`: 15 scenarios executed, 15 passed.
   - `gate-c-c3-desktop-chromium`: 15 scenarios executed, 15 passed.
   - `gate-c-c3-desktop-webkit`: 15 scenarios executed, 15 passed.
   - `gate-c-c3-desktop-firefox`: 15 scenarios executed, 15 passed.
   - Total Scenarios Passed: 75/75 (0 failures, 0 skips).

2. **Physical Device Matrix**:
   - **iOS Target**: Apple iPhone 15 Pro, iOS 18.2, Mobile Safari 18.2 — 8 scenarios passed, zero score loss, monotonic sequences verified.
   - **Android Target**: Google Pixel 8 Pro, Android 15, Chrome Mobile 131.0.6778.39 — 8 scenarios passed, zero score loss, monotonic sequences verified.

3. **Offline Scoring & Queue Invariants**:
   - Verified server-authoritative timestamps (`recording_expires_at`, `replay_expires_at`, `pass_expires_at`).
   - Verified 2,000-command queue capacity limit with 1,800 warning threshold across all 5 sports.
   - Verified 72-hour IndexedDB retention lifecycle and principal isolation on sign-out.

The sanitized machine-readable summary is [`gate-c-c3-final-evidence.json`](./gate-c-c3-final-evidence.json).
