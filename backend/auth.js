// Native OIDC login (Authorization Code Flow + PKCE) against Keycloak via openid-client.
// Access is restricted to members of OIDC_REQUIRED_GROUP (Keycloak "groups" claim).
import * as oidc from 'openid-client';
import session from 'express-session';
import express from 'express';

const {
    OIDC_ISSUER,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    OIDC_REQUIRED_GROUP = 'valheim-monitoring',
    OIDC_SCOPES = 'openid profile email groups',
    APP_BASE_URL,
    SESSION_SECRET,
    SESSION_MAX_AGE_HOURS = '8',
} = process.env;

const required = { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, APP_BASE_URL, SESSION_SECRET };
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
    console.error(`Error: missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}
if (SESSION_SECRET.length < 32) {
    console.error('Error: SESSION_SECRET must be at least 32 characters long.');
    process.exit(1);
}

export const baseUrl = new URL(APP_BASE_URL);
const redirectUri = new URL('/auth/callback', baseUrl).href;
const sessionMaxAgeMs = Number(SESSION_MAX_AGE_HOURS) * 60 * 60 * 1000;

// --- OIDC discovery (lazy, retried on failure so a Keycloak outage doesn't kill the app) ---
let configPromise = null;
function getConfig() {
    if (!configPromise) {
        configPromise = oidc.discovery(new URL(OIDC_ISSUER), OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)
            .then((config) => { console.log(`OIDC discovery done for issuer ${OIDC_ISSUER}`); return config; })
            .catch((err) => { configPromise = null; throw err; });
    }
    return configPromise;
}

// Keycloak sends group paths ("/valheim-monitoring") unless "Full group path" is off.
function normalizeGroups(groups) {
    if (!Array.isArray(groups)) return [];
    return [...new Set(groups.map((g) => String(g).replace(/^\//, '')))];
}

export function isAuthorized(user) {
    return Boolean(user && user.groups.includes(OIDC_REQUIRED_GROUP));
}

// --- Session ---
// MemoryStore is fine for a single instance; sessions are lost on container restart (users simply log in again).
export const sessionParser = session({
    name: 'vhmon.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
        httpOnly: true,
        secure: baseUrl.protocol === 'https:',
        sameSite: 'lax',
        maxAge: sessionMaxAgeMs,
    },
});

function forbiddenPage(user) {
    const name = escapeHtml(user?.displayName || user?.username || 'Unbekannt');
    return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kein Zugriff</title><link rel="stylesheet" href="/style.css"></head>
<body class="auth-page"><div class="card auth-card"><h2>Kein Zugriff</h2>
<p>Angemeldet als <strong>${name}</strong>, aber nicht Mitglied der Gruppe <code>${escapeHtml(OIDC_REQUIRED_GROUP)}</code>.</p>
<form method="post" action="/auth/logout"><button type="submit">Abmelden</button></form></div></body></html>`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Only allow relative, same-origin return paths (prevents open redirects).
function safeReturnTo(value) {
    return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

// --- Routes: /auth/login, /auth/callback, /auth/logout ---
export function authRouter() {
    const router = express.Router();

    router.get('/login', async (req, res, next) => {
        try {
            const config = await getConfig();
            const codeVerifier = oidc.randomPKCECodeVerifier();
            const state = oidc.randomState();
            const nonce = oidc.randomNonce();
            req.session.oidc = { codeVerifier, state, nonce, returnTo: safeReturnTo(req.query.returnTo) };

            const url = oidc.buildAuthorizationUrl(config, {
                redirect_uri: redirectUri,
                scope: OIDC_SCOPES,
                code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
                code_challenge_method: 'S256',
                state,
                nonce,
            });
            req.session.save((err) => (err ? next(err) : res.redirect(url.href)));
        } catch (err) {
            next(err);
        }
    });

    router.get('/callback', async (req, res, next) => {
        const pending = req.session.oidc;
        if (!pending) return res.redirect('/auth/login');
        try {
            const config = await getConfig();
            // Build the callback URL from the public base URL (we sit behind Traefik).
            const currentUrl = new URL(req.originalUrl, baseUrl);
            const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
                pkceCodeVerifier: pending.codeVerifier,
                expectedState: pending.state,
                expectedNonce: pending.nonce,
                idTokenExpected: true,
            });
            const claims = tokens.claims();

            // Prefer the groups claim from the ID token; fall back to the UserInfo endpoint.
            let groups = claims.groups;
            if (!Array.isArray(groups)) {
                const userInfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
                groups = userInfo.groups;
            }

            const user = {
                sub: claims.sub,
                username: claims.preferred_username || claims.sub,
                displayName: claims.name || claims.preferred_username || claims.sub,
                email: claims.email || '',
                groups: normalizeGroups(groups),
            };

            // New session id after login (session fixation protection).
            req.session.regenerate((err) => {
                if (err) return next(err);
                req.session.user = user;
                req.session.idToken = tokens.id_token;
                console.log(`Login: ${user.username} (authorized=${isAuthorized(user)}, groups=${user.groups.join(',') || '-'})`);
                req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect(pending.returnTo)));
            });
        } catch (err) {
            console.error('OIDC callback failed:', err.message || err);
            delete req.session.oidc;
            res.status(400).type('text').send('Login fehlgeschlagen. Bitte erneut versuchen: /auth/login');
        }
    });

    router.post('/logout', async (req, res) => {
        const idToken = req.session.idToken;
        const username = req.session.user?.username;
        req.session.destroy(() => {});
        res.clearCookie('vhmon.sid');
        if (username) console.log(`Logout: ${username}`);
        try {
            const config = await getConfig();
            const url = oidc.buildEndSessionUrl(config, {
                post_logout_redirect_uri: new URL('/', baseUrl).href,
                ...(idToken ? { id_token_hint: idToken } : { client_id: OIDC_CLIENT_ID }),
            });
            res.redirect(url.href);
        } catch {
            res.redirect('/');
        }
    });

    return router;
}

// --- Gate for everything except /auth/* and /healthz ---
export function requireAuth(req, res, next) {
    const user = req.session.user;
    if (!user) {
        if (req.method === 'GET' && req.accepts('html')) {
            return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
        }
        return res.status(401).json({ error: 'unauthenticated' });
    }
    if (!isAuthorized(user)) {
        return res.status(403).type('html').send(forbiddenPage(user));
    }
    next();
}
