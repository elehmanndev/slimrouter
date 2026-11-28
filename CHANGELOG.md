# Changelog

## Unreleased

- Claude accounts can be added from a `claude setup-token`: Providers, Connect Claude Code, "Paste a setup token instead". The token lasts a year and has no refresh token, so nothing can expire in between. It is checked with one 1-token request before it is saved; pasting again under the same name replaces it. The Providers page warns 30 days before it expires and when Anthropic revokes it.
- Usage for setup-token accounts comes from the `anthropic-ratelimit-unified-*` headers of a 1-output-token Haiku request, because the usage endpoint needs a scope a setup token does not have. A 429 with status "rejected" counts as a spent window.
- New read-only `GET /v1/usage` for any client key: every subscription account with its windows, whether the quota guard would skip it now and why, plus the last 24 hours of requests, tokens and cost. No tokens, emails or management rights. Meant for Paseo's Usage modal.
- New account strategy **consume-first**: the account whose weekly window resets soonest is used first, so quota that is about to expire is spent before quota that would carry over. Accounts without a known reset, or whose reset already passed, come after, by priority. Available per provider and as the default strategy.
- OAuth accounts are refreshed in the background every 5 minutes, without traffic: any account whose token expires within 30 minutes (or the provider lead, 4 hours for Claude) or that is due by age (Codex, 8 days) is refreshed, one at a time with a pause between accounts. An idle account no longer loses its refresh token. Set `DISABLE_BACKGROUND_REFRESH=1` to turn it off.
- A refresh token the provider rejects for good marks the account "Sign in again" on the Providers page and stops further refresh attempts until you sign in again. Signing in again with an account that is already connected now updates that account in place (priority, name and usage history kept) instead of adding a duplicate.
- Claude sign-in and refresh use the endpoints current Claude Code uses (`claude.com/cai/oauth/authorize`, `platform.claude.com/v1/oauth/token`).
- OAuth sign-in no longer needs a paste in the common case. The dashboard polls the server for the outcome, and when a provider only allows a localhost redirect (Claude on localhost at the dashboard's port, like 9router; Codex on 1455) copying the dead page's address is enough: the dialog reads the clipboard and finishes on its own. The paste box stays as a fallback.
- Claude Code sign-in redirects to `http://localhost:<dashboard port>/callback`, the same pattern 9router uses. Anthropic accepts localhost on any port but only with the exact path `/callback`; `/oauth/callback` is rejected. The previous LAN-address redirect was rejected by Anthropic with "Redirect URI is not supported by client" before sign-in.
- Round robin broke ties between accounts used in the same millisecond by priority, which could restart a streak on the wrong account. Ties now go to the account with the running streak.
- CI builds the image for amd64 only and reuses the GitHub Actions layer cache, cutting the image job from about 7 minutes to 1 or 2. Each image is also tagged with its commit sha.
- New public callback route under /api/oauth/callback that completes a flow from a code and state, and an admin status endpoint the dialog polls.

## 0.1.0

- First release: provider registry, OAuth onboarding for Claude Code, Codex, Antigravity and Gemini CLI, API key providers, fill-first and sticky round robin selection with a quota guard on the 5 hour and weekly windows, combos, translators for the Claude, Responses, Gemini and OpenAI dialects, usage with list-price value, hashed client keys, shadcn dashboard, Docker image and CI.
