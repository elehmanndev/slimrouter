# Changelog

## Unreleased

- OAuth sign-in no longer needs a paste in the common case. The dashboard polls the server for the outcome, and when a provider only allows a localhost redirect (Claude on localhost at the dashboard's port, like 9router; Codex on 1455) copying the dead page's address is enough: the dialog reads the clipboard and finishes on its own. The paste box stays as a fallback.
- Claude Code sign-in redirects to `http://localhost:<dashboard port>/callback`, the same pattern 9router uses. Anthropic accepts localhost on any port but only with the exact path `/callback`; `/oauth/callback` is rejected. The previous LAN-address redirect was rejected by Anthropic with "Redirect URI is not supported by client" before sign-in.
- Round robin broke ties between accounts used in the same millisecond by priority, which could restart a streak on the wrong account. Ties now go to the account with the running streak.
- New public callback route under /api/oauth/callback that completes a flow from a code and state, and an admin status endpoint the dialog polls.

## 0.1.0

- First release: provider registry, OAuth onboarding for Claude Code, Codex, Antigravity and Gemini CLI, API key providers, fill-first and sticky round robin selection with a quota guard on the 5 hour and weekly windows, combos, translators for the Claude, Responses, Gemini and OpenAI dialects, usage with list-price value, hashed client keys, shadcn dashboard, Docker image and CI.
