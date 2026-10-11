---
type: concept
title: Credentials and trust boundaries - who a request acts as, and which secrets are stored how
description: an API route acts either for a NextAuth session user (always WRITE) or for the owner of a dsat_ Bearer token (READ or WRITE, matched by its stored value), and in both cases calls GitHub with that user's stored OAuth token; token management is session-only; the GitHub OAuth token (written at every GitHub sign-in, used by the cron, the PR webhook and CI ingestion), the dsat_ token and the outgoing-webhook signing secret are stored as plaintext columns, while the PR-scan webhook secret is sealed with AES-256-GCM bound to its row; outgoing webhook and Slack URLs pass the public-address check at save and again at every delivery; Dev Login exists only in development builds.
tags: [auth, tokens, secrets, webhooks, security]
timestamp: 2026-10-11T15:51:49Z
sources:
  - lib/auth.ts
  - lib/auth-api.ts
  - app/api/tokens/route.ts
  - app/api/tokens/[id]/route.ts
  - scripts/mint-api-token.ts
  - lib/pr/webhook-secret.ts
  - lib/net/safe-fetch.ts
  - lib/alerts/notifier.ts
  - app/api/webhooks/route.ts
  - app/api/webhooks/[id]/route.ts
  - app/api/webhooks/github/route.ts
  - app/api/slack/route.ts
  - app/api/scan/route.ts
  - app/api/repos/route.ts
  - lib/cron/auto-scan.ts
  - lib/ci/ingest.ts
  - prisma/schema.prisma
---

The "Security model" section of `docs/architecture.md` lists the credentials and how each is stored, and `docs/api.md` lists which endpoints accept a Bearer token. This doc connects the files that resolve a caller, hold a secret, or reach an outside system.

## Who a request acts as

GitHub sign-in requests the scopes `repo user:email read:org` (`lib/auth.ts:16-18#"scope: 'repo user:email read:org',"`) and writes the returned access token onto the `User` row at every sign-in (`lib/auth.ts:79-84#"githubToken: account.access_token ?? '',"`). The session callback reads the row again for each session and puts its id, login and GitHub token into the session (`lib/auth.ts:102-112#"session.user.githubToken = dbUser.githubToken;"`).

`resolveRequestUser` decides the caller of every route that accepts a Bearer token:

- A session user resolves first and always gets `WRITE` (`lib/auth-api.ts:33-44#"scope: 'WRITE',"`).
- Otherwise an `Authorization: Bearer dsat_...` header is looked up by its exact value in `ApiToken`, and a revoked token resolves to nobody (`lib/auth-api.ts:48-62#"if (!record || record.revokedAt) return null;"`). The token resolves to its owner, the owner's GitHub token and the token's own scope (`lib/auth-api.ts:73-77#"scope: record.scope,"`).

A write route checks `hasWriteScope` (`lib/auth-api.ts:17-18#"return user.scope === 'WRITE';"`) and answers a `READ` token with `403`, for example `POST /api/scan` (`app/api/scan/route.ts:20-21#"return NextResponse.json({ error: 'This token does not have write access' }, { status: 403 });"`). Whatever the scope, the token caller's GitHub requests use the owner's stored OAuth token; `GET /api/repos`, open to `READ` tokens, lists repositories from GitHub with it (`app/api/repos/route.ts:18-23#"const allRepos = await getUserRepos(user.githubToken);"`).

Routes that call `auth()` instead of `resolveRequestUser` are session-only. Token management is one of them on purpose, so a `dsat_` token cannot mint, list or revoke tokens (`app/api/tokens/route.ts:9-11#"revoke tokens, otherwise a leaked token could escalate into more tokens."`).

## API tokens

`POST /api/tokens` mints `dsat_` plus 32 random bytes in hex, stores that value in `ApiToken.token` and returns it once (`app/api/tokens/route.ts:68-75#"return NextResponse.json({ token: rawToken, record }, { status: 201 });"`). Without a `scope` in the body the token is `WRITE` (`app/api/tokens/route.ts:60-65#"scope = body.scope as ApiTokenScope;"`). `GET /api/tokens` returns metadata only (`app/api/tokens/route.ts:20-28#"revokedAt: true,"`), and `DELETE /api/tokens/[id]` sets `revokedAt` on a token of the caller (`app/api/tokens/[id]/route.ts:22-24#"data: { revokedAt: new Date() },"`). The operator script `scripts/mint-api-token.ts` writes the same kind of row for any user id, also `WRITE` by default (`scripts/mint-api-token.ts:64-74#"select: { id: true, name: true, scope: true, createdAt: true },"`). The model has no expiry column (`prisma/schema.prisma:238-241#"@default(now())"`): a token works until it is revoked.

## Where the stored GitHub token is used

The `User.githubToken` column (`prisma/schema.prisma:18#"stored in plaintext"`) is also read straight from the database, not from a request's caller, in three places:

- the auto-scan cron, for every user whose token is not empty, to sync repositories and run the three scanners (`lib/cron/auto-scan.ts:54-62#"const githubRepos = await getUserRepos(user.githubToken);"`);
- the PR-scan webhook, for the owner of the tracking row that verified the delivery (`app/api/webhooks/github/route.ts:348-366#"user: { select: { githubToken: true } },"`);
- CI ingestion, for the owner of the repository row (`lib/ci/ingest.ts:24-31#"const token = repo.user.githubToken;"`).

Only sign-in writes the column: the GitHub sign-in callback, and Dev Login when it creates a user (see below). Signing out does not clear it, so the cron, the webhook and CI ingestion keep using the stored token after the user has signed out.

## Secrets at rest

| Value | Column | At rest | Read by |
| --- | --- | --- | --- |
| GitHub OAuth token | `User.githubToken` (`prisma/schema.prisma:18#"stored in plaintext"`) | plaintext | the session callback, `resolveRequestUser` and the three uses above |
| `dsat_` API token | `ApiToken.token` (`prisma/schema.prisma:231#"@unique"`) | plaintext, unique, matched by value | `resolveRequestUser`; no endpoint returns it after minting |
| Outgoing webhook signing secret | `WebhookConfig.secret` (`prisma/schema.prisma:290#"// HMAC signing secret"`) | plaintext | the webhook delivery; also returned by `POST /api/webhooks` and `PATCH /api/webhooks/[id]` |
| Slack incoming webhook URL | `SlackConfig.webhookUrl` (`prisma/schema.prisma:304#"// Slack incoming webhook URL"`) | plaintext | the Slack delivery; also returned by `GET /api/slack` |
| PR-scan webhook secret | `Repo.webhookSecretEnc` (`prisma/schema.prisma:46-48#"webhookSecretEnc"`) | sealed (AES-256-GCM) | the PR-scan webhook route; the plaintext is shown only when it is minted |

The outgoing webhook secret is the HMAC key of the `X-depsight-Signature` header (`lib/alerts/notifier.ts:52-69#"headers['X-depsight-Signature'] = signPayload(secret, body);"`). `GET /api/webhooks` selects the columns without it (`app/api/webhooks/route.ts:13-16#"select: { id: true, name: true, url: true, events: true, enabled: true, createdAt: true },"`), while `POST /api/webhooks` returns the created row (`app/api/webhooks/route.ts:58-68#"return NextResponse.json({ webhook }, { status: 201 });"`) and `PATCH /api/webhooks/[id]` the updated row (`app/api/webhooks/[id]/route.ts:36-49#"return NextResponse.json({ webhook: updated });"`). `GET /api/slack` returns the whole Slack configuration (`app/api/slack/route.ts:13-17#"return NextResponse.json({ config });"`).

The PR-scan webhook secret is sealed because HMAC verification needs the plaintext, so it cannot be hashed (`lib/pr/webhook-secret.ts:6#"so it cannot be hashed"`). The key is derived with HKDF-SHA256 from `WEBHOOK_SECRET_KEY`, or from `NEXTAUTH_SECRET` when that is unset or blank (`lib/pr/webhook-secret.ts:32-37#"return Buffer.from(hkdfSync('sha256', material, KEY_SALT, KEY_INFO, 32));"`), and the row id is bound in as additional authenticated data (`lib/pr/webhook-secret.ts:45-57#"].join('.');"`). Opening returns `null` instead of throwing for a malformed value, a value sealed for another row, or a changed key (`lib/pr/webhook-secret.ts:65-79#"return plain === '' ? null : plain;"`), and the webhook route counts such a row as not verifying (`app/api/webhooks/github/route.ts:374-379#"if (secret && verifyGitHubSignature(rawBody, signature, secret)) verified.push(candidate);"`).

## Outgoing URLs

Outgoing webhook and Slack URLs are user input, checked twice by `lib/net/safe-fetch.ts`:

- **At save:** `POST /api/webhooks` and `POST /api/slack` call `assertPublicUrl` and answer `400` on failure (`app/api/webhooks/route.ts:40-46#"return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });"`, `app/api/slack/route.ts:38-44#"return NextResponse.json({ error: 'Invalid webhookUrl format' }, { status: 400 });"`). It accepts only `http:` and `https:` (`lib/net/safe-fetch.ts:112-121#"throw new SsrfBlockedError('Only http(s) URLs are allowed');"`) and requires every resolved address to be public (`lib/net/safe-fetch.ts:156-162#"return { url, addresses: resolved };"`), against the blocked IPv4 ranges (`lib/net/safe-fetch.ts:40-51#"inRange('240.0.0.0/4') // reserved"`) and IPv6 ranges (`lib/net/safe-fetch.ts:88-96#"addr.startsWith('feb')"`).
- **At delivery:** both deliveries go through `safeFetch` (`lib/alerts/notifier.ts:73#"safeFetch(url, { method: 'POST', headers, body })"`, `lib/alerts/notifier.ts:145#"safeFetch(webhookUrl, {"`), which repeats the check, connects only to the addresses it validated (`lib/net/safe-fetch.ts:207-231#"lookup: pinnedLookup(addresses),"`, `lib/net/safe-fetch.ts:174-182#"const safe = validated.filter((a) => !isBlockedIp(a));"`) and does not follow redirects (`lib/net/safe-fetch.ts:238-239#"into an internal target."`).

`PATCH /api/webhooks/[id]` changes only the `enabled` flag, so a stored webhook URL is never replaced without the save-time check.

## Dev Login

The GitHub provider is registered only when its client id and secret are set (`lib/auth.ts:11#"if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {"`), and the `dev-login` credentials provider only when `NODE_ENV` is `development` (`lib/auth.ts:25-45#"githubToken: 'dev-token',"`). Dev Login accepts any username without a password and creates the user `dev-<username>` with the placeholder GitHub token `dev-token`.
