# Docker Real-Time Monitor

A small web application to monitor a *single* Docker container's stats and logs in real time over WebSockets, with a restart button. Login is handled **natively via OpenID Connect** (e.g. Keycloak) – no auth proxy required – and access can be restricted to members of one group.

## Features

*   **Real-time Stats:** CPU (%), memory usage / limit, network I/O, disk I/O, plus a 5-minute CPU chart.
*   **Real-time Logs:** Streams the container's `stdout`/`stderr` (ANSI colours supported).
*   **Container Info:** Name, short ID, image and status.
*   **Restart:** Restarts the monitored container.
*   **Native OIDC login:** Authorization Code Flow with PKCE (`openid-client`), server-side sessions, RP-initiated logout (also ends the Keycloak SSO session).
*   **Group-based access:** Only users whose `groups` claim contains `OIDC_REQUIRED_GROUP` get in; everyone else sees a 403 page. The WebSocket is authenticated with the same session.

## Tech Stack

*   **Backend:** Node.js 24 (ESM), Express 5, `ws`, `dockerode`, `openid-client` 6, `express-session`, `helmet`
*   **Frontend:** Vanilla JS, Chart.js, ansi_up – all served locally (no CDN)
*   **Runtime:** Docker Compose, with [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) in front of the Docker socket

## Architecture

```
Browser ──HTTPS──> Traefik ──> docker-monitor (OIDC + session) ──tcp──> socket-proxy ──ro──> /var/run/docker.sock
                                     │
                                     └── OIDC ──> Keycloak (login.trkulja.it)
```

The app never sees the Docker socket directly. The socket proxy only allows reading containers, logs and stats plus `stop`/`restart`/`kill` – no create, delete, exec or image pulls.

## Keycloak setup

1.  **Client** (`Clients → Create client`):
    *   Client type `OpenID Connect`, Client ID `valheim-monitor`
    *   Client authentication **On** (confidential), Standard flow **On**, everything else off
    *   Valid redirect URIs: `https://monitor.vh.trkulja.it/auth/callback`
    *   Valid post logout redirect URIs: `https://monitor.vh.trkulja.it/`
    *   Web origins: `https://monitor.vh.trkulja.it`
    *   Advanced → PKCE method `S256` (optional, the app always sends PKCE)
2.  **Groups claim:** Client → Client scopes → add `groups` as *Default*. If the realm has no `groups` scope, create a mapper *Group Membership* with token claim name `groups`, **Full group path off**, *Add to ID token* on.
3.  **Group:** create `valheim-monitoring` and add the users who should have access.

## Configuration

| Variable | Required | Description |
|:--|:--|:--|
| `TARGET_CONTAINER` | ✅ | Name (preferred) or ID of the container to monitor. `TARGET_CONTAINER_ID` still works. |
| `APP_BASE_URL` | ✅ | Public URL, e.g. `https://monitor.vh.trkulja.it` (used for the redirect URI and the WebSocket origin check). |
| `OIDC_ISSUER` | ✅ | e.g. `https://login.trkulja.it/realms/trkulja.it` |
| `OIDC_CLIENT_ID` | ✅ | e.g. `valheim-monitor` |
| `OIDC_CLIENT_SECRET` | ✅ | From the client's *Credentials* tab – put it in `.env`. |
| `SESSION_SECRET` | ✅ | Random, ≥ 32 characters (`openssl rand -hex 32`) – put it in `.env`. |
| `OIDC_REQUIRED_GROUP` | | Default `valheim-monitoring`. A leading `/` (full group path) is ignored. |
| `OIDC_SCOPES` | | Default `openid profile email groups` |
| `SESSION_MAX_AGE_HOURS` | | Default `8`. Open WebSockets are closed when the session expires. |
| `DOCKER_HOST` | | Default: local socket. In Compose: `tcp://socket-proxy:2375` |
| `APP_TITLE`, `LOG_TAIL_COUNT`, `PORT` | | Title, initial log lines (100), port (3000) |

Secrets go into `.env` (see `.env.example`, `chmod 600`). Values containing `$` or `#` must be wrapped in single quotes.

## Deployment

```bash
cp .env.example .env && chmod 600 .env   # fill in OIDC_CLIENT_SECRET and SESSION_SECRET
docker compose up -d --build
docker compose logs -f docker-monitor
```

Traefik routes `monitor.vh.trkulja.it` to the app (labels in `compose.yml`). The old `sso-auth` forward-auth middleware is no longer used.

## Local development

```bash
cd backend
npm install
# Vendor files are normally copied at image build time:
mkdir -p ../frontend/vendor
cp node_modules/chart.js/dist/chart.umd.min.js node_modules/chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js node_modules/ansi_up/ansi_up.js ../frontend/vendor/
# Set the variables from the table above, then:
npm run dev
```

The Keycloak client needs `http://localhost:3000/auth/callback` as an additional redirect URI for local testing.

## Security notes

*   The socket proxy limits the Docker API, but log output and container metadata of the target are still visible to every authorized user.
*   Sessions are kept in memory: a container restart logs everybody out (they are sent through the Keycloak login again, usually without re-entering credentials).
*   The former "Upgrade" action was removed – it stopped and deleted the target container without being able to recreate it. Let the target update itself (e.g. `UPDATE_CRON` in `lloesche/valheim-server`) or use Compose.
