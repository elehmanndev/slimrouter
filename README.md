# slimrouter

A small, self-hosted gateway that puts your AI subscriptions and API keys behind one OpenAI, Anthropic and Responses compatible endpoint. Sign in with Claude Code, Codex or Antigravity once, add API keys for anything else, then point Claude Code, Codex CLI, Cursor, OpenCode or any SDK at it.

It is a stripped-down rewrite of the ideas in 9router: the same OAuth clients and request shaping the official CLIs use, with a much smaller surface and a clean dashboard.

## What it does

- **Provider onboarding**: OAuth sign-in for Claude Code, OpenAI Codex, Antigravity and Gemini CLI. API keys for Anthropic, OpenAI, Gemini, OpenRouter and any OpenAI compatible server (Ollama, vLLM, LM Studio).
- **Endpoints**: `/v1/chat/completions`, `/v1/messages`, `/v1/responses` and `/v1/models`. Each one speaks the caller's dialect and translates to whatever the upstream needs, tool calls included.
- **Multiple accounts per provider**: fill-first (drain one account, then the next) or round robin with a sticky count.
- **Quota guard**: reads the 5 hour and weekly windows of each subscription and takes an account out of rotation when less than N percent remains on either window. Thresholds are per provider.
- **Combos**: a model name of your choosing that tries members in order or rotates between them. Name one `claude-opus-5-5` and Claude Code will never know it is talking to GPT.
- **Usage and quota panel**: requests, tokens, cache hit rate and the pay-as-you-go value of what you used, per model, account and API key. Live meters for every subscription window with reset countdowns.
- **API keys** for your clients, hashed at rest, optionally limited to a list of models.

## One click setup

```sh
git clone https://github.com/elehmanndev/slimrouter.git && cd slimrouter
cp .env.example .env            # set DASHBOARD_PASSWORD
docker compose up -d
```

Open `http://localhost:20128`, sign in, connect a provider, create an API key. Done.

Without cloning:

```sh
docker run -d --name slimrouter -p 20128:20128 \
  -e DASHBOARD_PASSWORD=change-me \
  -v slimrouter-data:/data \
  ghcr.io/elehmanndev/slimrouter:latest
```

The published image is `linux/amd64`. On ARM, build it yourself with `docker compose build`.

Data (SQLite database, session secret) lives in `/data`. Back up that directory and you have everything.

### Unraid

Add a container from the Docker tab with repository `ghcr.io/elehmanndev/slimrouter:latest`, port `20128`, a path mapping `/mnt/user/appdata/slimrouter` to `/data`, and the variable `DASHBOARD_PASSWORD`. Or use UnraidClaw and ask it to install the image.

## Connect your tools

Create an API key in the dashboard, then:

**Claude Code**

```sh
export ANTHROPIC_BASE_URL=http://localhost:20128
export ANTHROPIC_AUTH_TOKEN=sk-slim-...
export ANTHROPIC_MODEL=cc/claude-opus-5-5     # or a combo name
claude
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
model_provider = "slimrouter"
model = "cx/gpt-6-sol"

[model_providers.slimrouter]
name = "slimrouter"
base_url = "http://localhost:20128/v1"
env_key = "SLIM_KEY"
wire_api = "responses"
```

**OpenAI or Anthropic SDK**: base URL `http://localhost:20128/v1` (or without `/v1` for the Anthropic SDK), the slimrouter key as the API key, and any id from the Models page.

Model ids are `alias/model`: `cc/` Claude Code, `cx/` Codex, `ag/` Antigravity, `gc/` Gemini CLI, `anthropic/`, `openai/`, `gemini/`, `openrouter/`, `oc/` for OpenAI compatible servers. Combos are called by their bare name.

## OAuth notes

- **Claude**: works like 9router. Anthropic only accepts a localhost redirect, so after you approve, the browser goes to `http://localhost:<dashboard port>/callback` (Anthropic rejects any other path). On the server itself that page completes the sign-in. From another machine it fails to load: copy its address and the dialog finishes by itself (or paste it).
- **Codex**: OpenAI only accepts `http://localhost:1455/auth/callback`. Run the dashboard on the machine where the browser is, or sign in, copy the full callback URL from the address bar of the error page, and paste it into the dialog. slimrouter extracts the code.
- **Antigravity and Gemini CLI**: standard Google sign-in; the callback returns to `/oauth/callback` on this server, so use the hostname you opened the dashboard with.

Tokens are refreshed automatically. When a refresh fails permanently the account shows an error and you sign in again.

## Routing in detail

For every request the gateway resolves the model (combo or `alias/model`), lists the active accounts of that provider in priority order, drops the ones in cooldown or below the quota threshold, then picks one:

- **fill-first**: the first account in the list.
- **round-robin**: the account used least recently, after the current one has served `sticky` requests in a row.

A 429 or a quota error locks that account for that model with exponential backoff (2 s doubling up to 5 min, or the reset time the provider reports, capped at 30 min) and the next account is tried immediately. Auth errors lock the whole account for 2 minutes after a token refresh attempt. A 400 that the request itself caused is returned as is and the account is not punished.

Quota snapshots are refreshed every 5 minutes (configurable) from the same endpoints the official CLIs use. The thresholds default to 10 percent left on either window and can be set per provider on the Providers page or globally in Settings.

## Development

```sh
npm install
npm run dev          # http://localhost:3000
npm test             # vitest
npm run typecheck
npm run build
```

Requires Node 22 or newer (the database uses the built-in `node:sqlite`, so there are no native modules to compile).

Layout: `src/server` is the gateway (registry, OAuth, quota, router, translators, executors), `src/app/api/v1` the client endpoints, `src/app/api/admin` the dashboard API, `src/app/(dashboard)` the UI.

## Security

- Put a password on the dashboard before exposing it anywhere beyond your LAN. Put the whole thing behind a reverse proxy with TLS if you expose `/v1` to the internet.
- Provider tokens and API keys are stored in plain text in the SQLite file inside `/data`. Treat that directory like a credentials file.
- Client API keys are stored hashed; the plaintext is shown once.

## License

MIT. The OAuth client ids and request shaping mirror the public 9router project, also MIT.
