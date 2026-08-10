# CLAUDE.md — Project Rules

Read `SPEC.md` first. This file is rules for how to work on this project,
not what to build.

## Non-negotiable: `.env` boundary

- **Never open, read, `cat`, `grep`, or otherwise inspect the contents of
  `.env`.** Not to "check if a value is set," not to debug, not for any
  reason. This applies to every tool available — file read, bash, search —
  all of it.
- If you need to know what variables the running application expects,
  maintain and read `.env.example` instead — same variable names, obvious
  placeholder values (`ADMIN_PASSWORD=changeme`), never the real file.
  Keep it in sync with what the code actually reads from `process.env`.
- If you're unsure whether a variable exists in the real `.env`, ask the
  user directly rather than opening the file to check.
- `.env` must be in `.gitignore` from the first commit. So must any
  generated TLS cert/key files.
- Application code reads `.env` via `process.env` at runtime as normal —
  this rule is about you, the coding agent, not about the running
  service. The service is supposed to read its own config.

## Secret obfuscation

Any value that could be a credential — API keys, the admin password, and
any webhook URL that embeds a token or ID that's effectively a bearer
credential — must never appear in full in logs, error messages, or
anywhere the UI displays configuration back to the user.

Write one shared helper, e.g. `maskSecret(value: string): string`, that
shows at most the last 4 characters and masks the rest (`••••••••wxyz`).
Use it at every log call and every API response that echoes configuration
back, including webhook URLs in the latches list — the UI can show that a
webhook is configured and roughly where it points, without rendering the
full URL if it contains a token.

When in doubt about whether a field is secret-bearing, treat it as if it
is.

## Stack

- **Next.js, App Router, TypeScript** — one project, frontend and backend
  together. Not a separate Express API plus a separate React app.
- **Runtime: Bun**, not Node — chosen so a Docker image can pin one exact
  runtime version identically across the Mac dev machine and the Debian
  deploy target, and to use `bun:sqlite`/`Bun.password` (argon2) without
  extra dependencies. Deployed as a Docker image (see DEPLOY.md), managed
  by systemd on the deploy target — not a bare Node/Bun process directly.
- **Storage: SQLite** (`bun:sqlite`), not flat config/state files — see
  SPEC.md section 6. One gitignored `data/app.db`, not a database server.
- **Styling**: Tailwind + shadcn/ui, as specified. `next-themes` for
  dark/light mode — respect system preference by default, let the user
  override and persist it.
- Language choice for the whole project is TypeScript, front and back,
  per the project owner's preference. Don't suggest Python; that tradeoff
  was already considered.

## The engine must not depend on the UI being open

This is the most important architectural constraint in the project. The
latch engine (state machine, sensor connection, timers) is a singleton
that boots once when the server process starts — in a custom server
entrypoint, before the HTTP(S) listener comes up — not something that
gets instantiated inside a Route Handler on first request. Route Handlers
call into the running engine; they don't own its lifecycle.

Concretely:

- Don't put engine initialization inside `app/api/**/route.ts` files, even
  guarded by a "has this run yet" check. Boot it in the custom server
  file.
- Be careful with Next.js dev-mode hot reloading re-running module-level
  code — verify the singleton actually stays a singleton across HMR in
  dev (a `globalThis`-based guard is the usual fix), and separately
  verify it behaves correctly in an actual production build. Don't assume
  `next dev` behavior generalizes to `next start` / the custom server.
- `next start` alone does not satisfy this — it doesn't run your custom
  server entrypoint. Production deployment runs the compiled custom
  server file directly (see `DEPLOY.md`).

## Process isolation

- The service runs as its own dedicated, unprivileged OS user on the
  Debian 13 deploy target. Document the exact `useradd`/systemd setup in
  `DEPLOY.md`.
- HTTPS with a self-signed cert is terminated by the custom server itself
  (Node's `https` module wrapping the Next.js request handler) — not
  assumed to be handled by a reverse proxy in front of it, unless you
  have a specific reason to add one and note it in `DEPLOY.md`.
- Build with `output: 'standalone'`. Document the build and deploy steps
  in `DEPLOY.md`, including how the Mac dev build differs from what
  actually ships to Debian.

## API discovery

You're free to explore the UniFi Protect API directly to determine the
right integration approach (see SPEC.md section 8). When you do:

- Document every endpoint you rely on in `API_NOTES.md` as you discover
  it — method, path, auth, request/response shape, firmware version
  tested against, and whether you confirmed it by testing or are
  inferring it from documentation. Add to it as you go, not at the end.
- Prefer an existing, maintained library over hand-rolling a client, but
  note the library's maturity (last release date, open issue volume) in
  `API_NOTES.md` so the choice can be revisited later if it turns out to
  be unmaintained.
- If something in the API behaves differently than documented, note the
  discrepancy in `API_NOTES.md` rather than silently working around it.

## Config vs. secrets

- Non-secret, user-editable settings (sensors, latches, thresholds,
  durations, webhook targets) live in the config file described in
  SPEC.md section 6, not in `.env`.
- `.env` is for the operator credentials and anything else that's purely
  a secret with no reason to be user-editable through the UI.
- Don't invent a third place to store settings. If something doesn't
  obviously belong in either, ask rather than guessing.

## Correctness priorities

The latch state machine (idle → armed → fired → idle) is the one piece of
this project where a bug has real consequences — a missed alert on a
freezer is not a cosmetic issue. Write unit tests for the state machine
covering at minimum: arms on threshold cross, clears before duration
elapses (no webhook fired), fires after duration elapses, resolved
webhook only fires if the fired webhook fired first (never on a routine
clear that never armed long enough), and a restart mid-armed-state
behaves sanely per whatever persistence approach you land on.

## Publishability

This project is meant to be published and reused for other sites, not
just the one it was built for. Treat that as a hard constraint, not a
nice-to-have:

- No literal IPs, device IDs, sensor names, thresholds, or webhook URLs
  in source code, ever — full stop, no exceptions for "just for now."
  Everything site-specific comes from `config.json` or `.env`.
- `config.json` is gitignored, same as `.env`. It's private operational
  data even though it's not a secret. Ship `config.example.json` with
  obviously fake placeholder values, and make sure the app doesn't crash
  when no real config file exists yet — handle that as a first-run empty
  state.
- Sensors are discovered via the API and presented for the user to name
  and select, never hardcoded or assumed. If you catch yourself writing a
  device ID as a constant anywhere outside a test fixture, stop.
- `README.md` needs to actually work for someone who has never seen this
  repo — verify it by following it yourself, not by summarizing what you
  did from memory.
- Include a `LICENSE` file. Flag the choice to the user rather than
  picking silently.

## What not to do

- Multi-user auth (multiple operator accounts, argon2-hashed passwords in
  SQLite) is in scope per SPEC.md section 3 — but don't go further than
  that. No roles/permission tiers, no RBAC, no user-facing profile fields
  beyond username/password. Every account has identical access.
- Don't poll the Protect API faster than the sensor's own reporting
  interval "just in case" — it doesn't improve detection latency and
  it's unnecessary load. Confirm the interval before deciding on a
  polling/websocket strategy.
- Don't let any UI element render a full secret value. See obfuscation
  rules above.
- Don't deploy to anything serverless/edge — the engine needs a
  long-running process. `systemd` on Debian 13 is the target, full stop.
- Don't reach for `cron`, `node-cron`, or any external scheduler for
  polling, health checks, or reconnect logic — those live inside the
  engine as timers in the persistent process, for the same reason the
  engine can't be request-scoped (see above). If a genuinely separate
  periodic task turns out to be needed later (cert renewal, log
  rotation), use a systemd timer, not cron — stay consistent with the
  rest of the deployment rather than splitting scheduling across two
  systems.
