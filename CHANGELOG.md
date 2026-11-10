# Changelog

## Unreleased

- OAuth sign-in no longer needs a paste in the common case. The dashboard polls the server for the outcome, and when a provider only allows a localhost redirect (Claude on 54545, Codex on 1455) copying the dead page's address is enough: the dialog reads the clipboard and finishes on its own. The paste box stays as a fallback.
- Claude Code sign-in uses the localhost redirect Anthropic accepts; the previous server-origin redirect was rejected with "Redirect URI is not supported by client".
- New public callback route under /api/oauth/callback that completes a flow from a code and state, and an admin status endpoint the dialog polls.

## 0.1.0

- First release: provider registry, OAuth onboarding for Claude Code, Codex, Antigravity and Gemini CLI, API key providers, fill-first and sticky round robin selection with a quota guard on the 5 hour and weekly windows, combos, translators for the Claude, Responses, Gemini and OpenAI dialects, usage with list-price value, hashed client keys, shadcn dashboard, Docker image and CI.
