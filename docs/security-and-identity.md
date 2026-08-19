# Security And Identity

## Identity Model

Clerk is the production identity provider for the MVP. The API does not trust
an ID supplied by a browser to decide ownership.

The boundary is:

1. Clerk authenticates the user and issues a signed access token.
2. Fastify verifies the token with Clerk's secret/JWKS configuration.
3. The verified Clerk subject is mapped to an application-owned row in
   `managers`.
4. Game use cases receive the internal `ManagerId` from that row.
5. Community features use `publicHandle`, never the Clerk subject, email, or
   internal manager ID.

The API accepts `x-dev-manager-id` only when `AUTH_MODE=development`. The
header is ignored when production uses Clerk mode. Production must fail closed
if `CLERK_SECRET_KEY` is missing.

## Current Protections

- Clerk bearer tokens are verified server-side; decoded browser claims are not
  trusted without signature verification.
- Manager ownership is resolved from the authenticated identity.
- Manager IDs in request bodies are ignored for ownership decisions.
- Cross-manager roster reads and mutations return a non-disclosing 404.
- Authentication failures return 401; suspended manager accounts return 403.
- CORS uses an explicit origin allowlist and credentials are not enabled for
  arbitrary origins.
- Fastify Helmet supplies baseline security headers.
- Fastify rate-limits requests globally as a first abuse-control layer.
- Tournament creation is an internal administrative action protected by a
  server-only token; it is not a manager endpoint.
- Passwords and Clerk tokens are never stored in the application database.
- Replay logs remain immutable and publicly cacheable by match ID only.

## Production Checklist

- Set `NODE_ENV=production` and `AUTH_MODE=clerk`.
- Set `CLERK_SECRET_KEY` and the browser publishable key through secret
  management, not committed files.
- Set `CLERK_AUTHORIZED_PARTIES` to the exact production web origin.
- Set `CORS_ORIGINS` to exact production origins; never use `*` with credentials.
- Generate a long random `INTERNAL_ADMIN_TOKEN` and keep it server-side.
- Configure Clerk email verification and account recovery before public beta.
- Enable MFA/passkeys when the selected Clerk plan supports them.
- Add monitoring for repeated 401/403 responses, rate-limit events, and
  account suspension events.
- ~~Add an account deletion/export flow that removes private profile data
  while preserving only the minimum historical game records required by
  the rules.~~ **Deletion built** (`DELETE /me/account`,
  `DeleteManagerAccountUseCase` in `packages/application/src/use-cases/`):
  releases every rostered player (reusing `ReleasePlayerUseCase`, so the
  P7a doubles-pair-dissolution cascade runs too) — the players and their
  full game history (ranking ledger, titles, peaks) survive, unowned,
  exactly like any other release, because that history belongs to the
  Player aggregate, not the manager — then anonymizes the `ManagerAccount`
  row itself (`authSubject`/`displayName`/`publicHandle` overwritten,
  `status: 'deleted'`) rather than deleting the row outright, since other
  tables reference the manager id by foreign key. `ManagerAccount.status`
  gained a third value (migration `0042_young_rockslide.sql`, additive —
  `ALTER TYPE ... ADD VALUE`); `EnsureManagerAccountUseCase` blocks
  re-authentication for both `'suspended'` and the new `'deleted'`
  permanently. One real bug caught and fixed while building this: the
  development auth adapter pins a manager's id directly from the
  `x-dev-manager-id` header (production/Clerk always mints a fresh random
  id instead), so a repeated dev-mode request with the same header after
  deletion would otherwise fall through to the account-creation path's
  upsert-by-id and silently resurrect the anonymized row — closed by
  having `EnsureManagerAccountUseCase` check `findById` (not just
  `findByAuthSubject`) whenever a dev id is supplied. Verified live
  against a running dev server + real Postgres (not just tests): created
  an account, deleted it (`204`), confirmed the DB row round-tripped to
  `status: 'deleted'` with `auth_subject`/`public_handle` anonymized and
  the same `id` preserved, and confirmed the same dev header now gets
  `403 Manager account has been deleted` on both `GET /auth/me` and a
  second `DELETE /me/account`. Export (a downloadable data dump) is
  still open — deletion was the doc's more load-bearing gap and is what
  this pass scoped to.
- Run dependency and npm audit checks in CI; do not apply force upgrades
  blindly to authentication dependencies.

## Community Security Seam

Community features are intentionally not part of the identity table. Future
bounded contexts should include:

- Public manager profiles keyed by `publicHandle`.
- Forum threads and posts with author `ManagerId` references.
- Private messages authorized by sender/recipient relationship, never by a
  client-supplied recipient ownership claim.
- Reports, moderation actions, bans, and immutable moderation audit events.
- Per-user and per-IP rate limits for posting and messaging.
- Length limits, server-side validation, output escaping, and safe link policy
  for user-generated content.
- Privacy controls for profile visibility and message requests.

Rankings can be public read models, but write access must remain exclusively in
competition/application workflows. A community feature must never be able to
write player stats, tournament outcomes, ranking ledger entries, or billing
entitlements.
