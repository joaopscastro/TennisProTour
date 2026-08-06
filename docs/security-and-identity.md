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
- Add an account deletion/export flow that removes private profile data while
  preserving only the minimum historical game records required by the rules.
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
