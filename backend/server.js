import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import Docker from 'dockerode';
import helmet from 'helmet';
import { sessionParser, authRouter, requireAuth, isAuthorized, baseUrl } from './auth.js';
import { MetricsStore } from './metrics.js';

// --- Configuration ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// Name (preferred, survives re-creation) or ID of the container to monitor.
// TARGET_CONTAINER_ID is still accepted for backwards compatibility.
const TARGET_CONTAINER = process.env.TARGET_CONTAINER || process.env.TARGET_CONTAINER_ID;
const FRONTEND_PATH = process.env.FRONTEND_PATH || path.join(__dirname, '../frontend');
const LOG_TAIL_COUNT = Number(process.env.LOG_TAIL_COUNT || 100); // Default number of past lines to show initially
// Log history the client may choose (dropdown). 'start' = everything since the last container start,
// capped so a long-running container with a huge log cannot flood the browser.
const LOG_TAIL_OPTIONS = ['100', '500', '1000', 'start'];
const LOG_SINCE_START_CAP = Number(process.env.LOG_SINCE_START_CAP || 10000);

// CPU / RAM history (SQLite file in a volume)
const METRICS_DB_PATH = process.env.METRICS_DB_PATH || path.join(__dirname, '../data/metrics.db');
const METRICS_INTERVAL_MS = Number(process.env.METRICS_INTERVAL_SECONDS || 10) * 1000;
const METRICS_RETENTION_MS = Number(process.env.METRICS_RETENTION_DAYS || 7) * 24 * 60 * 60 * 1000;

function normalizeLogTail(value) {
    return LOG_TAIL_OPTIONS.includes(String(value)) ? String(value) : String(LOG_TAIL_COUNT);
}
const APP_TITLE = process.env.APP_TITLE || 'Docker Monitor';

if (!TARGET_CONTAINER) {
    console.error('Error: TARGET_CONTAINER environment variable is not set.');
    process.exit(1);
}

// --- Initialization ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true }); // Upgrade is handled manually after the session check
// Uses DOCKER_HOST (e.g. tcp://socket-proxy:2375) if set, otherwise /var/run/docker.sock
const docker = new Docker();

let targetContainer = null;
let containerInfoCache = null;

// --- Detect restarts / re-creation of the target container ---
// Log/stats streams through docker-socket-proxy don't reliably end when the container is recreated
// (new ID, e.g. `docker compose up -d`), so poll by name and compare ID + start time.
const CONTAINER_POLL_MS = Number(process.env.CONTAINER_POLL_SECONDS || 30) * 1000;
const containerChangeListeners = new Set(); // one per WebSocket connection: restarts its streams
let lastContainerKey = null;

const containerKey = (info) => (info ? `${info.Id}|${info.State?.StartedAt}` : null);

async function checkContainerChange() {
    let fresh = null, info = null;
    try {
        fresh = docker.getContainer(TARGET_CONTAINER);
        info = await fresh.inspect();
    } catch { /* container currently missing (e.g. mid-recreate) */ }
    const key = containerKey(info);
    if (!key || key === lastContainerKey) return;

    const firstRun = lastContainerKey === null;
    lastContainerKey = key;
    targetContainer = fresh;
    containerInfoCache = info;
    if (firstRun) return;

    console.log(`Target container changed: ${info.Id.substring(0, 12)}, started ${info.State.StartedAt}`);
    joinWatcher?.stream?.destroy();
    joinWatcher = null;
    await refreshJoinInfoFromLogs(fresh);
    await ensureJoinWatcher(fresh);
    await ensureCollector(fresh, true);
    containerChangeListeners.forEach((fn) => fn());
}

// --- Background metrics collector (independent of connected clients) ---
const metrics = new MetricsStore(METRICS_DB_PATH, METRICS_RETENTION_MS);
let collector = null;      // { key, stream, lastDataAt }
let pendingSamples = [];   // raw samples since the last write

async function ensureCollector(container, force = false) {
    const key = containerKey(containerInfoCache);
    const stale = !collector || Date.now() - collector.lastDataAt > 60000;
    if (!force && collector && collector.key === key && !stale) return;

    collector?.stream?.destroy();
    collector = { key, stream: null, lastDataAt: Date.now() };
    pendingSamples = [];
    const mine = collector;
    try {
        const stream = await container.stats({ stream: true });
        if (collector !== mine) { stream.destroy(); return; }
        mine.stream = stream;
        let rest = '';
        stream.on('data', (chunk) => {
            const parts = (rest + chunk.toString('utf-8')).split('\n');
            rest = parts.pop();
            for (const part of parts) {
                if (!part.trim()) continue;
                try {
                    const d = JSON.parse(part);
                    if (!d.precpu_stats?.system_cpu_usage) continue; // first sample has no baseline
                    mine.lastDataAt = Date.now();
                    pendingSamples.push({
                        cpu: Number(calculateCPUPercent(d)),
                        mem: d.memory_stats.usage - (d.memory_stats.stats?.inactive_file || 0),
                        memLimit: d.memory_stats.limit,
                    });
                } catch { /* ignore malformed chunk */ }
            }
        });
        stream.on('error', (err) => console.error('Metrics stats stream error:', err.message));
    } catch (err) {
        console.error('Error starting metrics collector:', err.message || err);
    }
}

function flushMetrics() {
    if (!pendingSamples.length) return;
    const samples = pendingSamples;
    pendingSamples = [];
    const cpus = samples.map((s) => s.cpu);
    const last = samples[samples.length - 1];
    try {
        metrics.insert({
            ts: Date.now(),
            cpu: cpus.reduce((a, b) => a + b, 0) / cpus.length,
            cpuMax: Math.max(...cpus),
            mem: last.mem,
            memLimit: last.memLimit,
        });
    } catch (err) {
        console.error('Failed to write metrics:', err.message || err);
    }
}

// Crossplay (PlayFab) join code, parsed from the target's logs (Valheim prints it on session registration).
// Reset whenever the container restarts, because Valheim gets a new code then.
const JOIN_CODE_PATTERNS = [
    /registered with join code (\d+)/,
    /with join code (\d+) and IP (\S+) is active/,
];
let joinInfo = { code: null, address: null, startedAt: null };

function parseJoinCode(line) {
    for (const re of JOIN_CODE_PATTERNS) {
        const m = re.exec(line);
        if (m) return { code: m[1], address: m[2] || null };
    }
    return null;
}

// Returns true if the join info changed.
function updateJoinInfo(line) {
    const found = parseJoinCode(line);
    if (!found) return false;
    const next = { ...joinInfo, code: found.code, address: found.address || (found.code === joinInfo.code ? joinInfo.address : null) };
    if (next.code === joinInfo.code && next.address === joinInfo.address) return false;
    joinInfo = next;
    return true;
}

// Split a non-TTY Docker log buffer (8-byte frame headers) into text.
function demuxBuffer(buf) {
    let out = '';
    for (let i = 0; i + 8 <= buf.length;) {
        const size = buf.readUInt32BE(i + 4);
        out += buf.subarray(i + 8, i + 8 + size).toString('utf-8');
        i += 8 + size;
    }
    return out;
}

// Scan the logs since the last container start once per start, so the code is known
// even if the registration line is older than the live log tail.
async function refreshJoinInfoFromLogs(container) {
    const startedAt = containerInfoCache?.State?.StartedAt;
    if (!startedAt || joinInfo.startedAt === startedAt) return;
    joinInfo = { code: null, address: null, startedAt };
    try {
        const since = Math.floor(new Date(startedAt).getTime() / 1000);
        const buf = await container.logs({ stdout: true, stderr: true, follow: false, since });
        const text = containerInfoCache.Config?.Tty ? buf.toString('utf-8') : demuxBuffer(buf);
        text.split('\n').forEach(updateJoinInfo);
        if (joinInfo.code) console.log(`Join code found in logs: ${joinInfo.code}`);
    } catch (err) {
        console.error('Error scanning logs for join code:', err.message || err);
    }
    broadcast(joinInfoMessage()); // new run: replace the old code in all open browsers
}

// One background follower per container start (tail 0 = only new lines), independent of connected clients,
// so old codes from the log history of a previous run can never overwrite the current one.
let joinWatcher = null; // { startedAt, stream }
async function ensureJoinWatcher(container) {
    const startedAt = containerInfoCache?.State?.StartedAt;
    if (!startedAt || joinWatcher?.startedAt === startedAt) return;
    joinWatcher?.stream?.destroy();
    joinWatcher = { startedAt, stream: null };
    try {
        const stream = await container.logs({ stdout: true, stderr: true, follow: true, tail: 0 });
        joinWatcher.stream = stream;
        let rest = '';
        const onText = (buf) => {
            const lines = (rest + buf.toString('utf-8')).split('\n');
            rest = lines.pop();
            if (lines.some(updateJoinInfo)) broadcast(joinInfoMessage());
        };
        const sink = new PassThrough();
        sink.on('data', onText);
        if (containerInfoCache.Config?.Tty) stream.pipe(sink);
        else docker.modem.demuxStream(stream, sink, sink);
        // Stream ends when the container stops/restarts (e.g. nightly RESTART_CRON): re-arm for the next run.
        const reset = () => {
            if (joinWatcher?.stream !== stream) return;
            joinWatcher = null;
            setTimeout(async () => {
                const c = await getContainer();
                if (c) { await refreshJoinInfoFromLogs(c); await ensureJoinWatcher(c); }
            }, 15000).unref();
        };
        stream.on('end', reset);
        stream.on('error', reset);
    } catch (err) {
        console.error('Error starting join code watcher:', err.message || err);
        joinWatcher = null;
    }
}

function joinInfoMessage() {
    return { type: 'join_info', code: joinInfo.code, address: joinInfo.address };
}

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.send(payload); });
}

// --- Helper Functions ---

// Find the container by name or ID
async function getContainer() {
    if (targetContainer) {
        try {
            containerInfoCache = await targetContainer.inspect();
            return targetContainer;
        } catch {
            console.warn('Cached container reference seems invalid, re-fetching...');
            targetContainer = null;
            containerInfoCache = null;
        }
    }

    try {
        const container = docker.getContainer(TARGET_CONTAINER);
        containerInfoCache = await container.inspect();
        console.log(`Monitoring container: ${containerInfoCache.Name} (${containerInfoCache.Id.substring(0, 12)})`);
        targetContainer = container;
        return container;
    } catch (err) {
        console.error(`Error finding container "${TARGET_CONTAINER}":`, err.message || err);
        targetContainer = null;
        containerInfoCache = null;
        return null;
    }
}

// Basic CPU Percentage Calculation
function calculateCPUPercent(statsData) {
    try {
        const cpuDelta = statsData.cpu_stats.cpu_usage.total_usage - (statsData.precpu_stats.cpu_usage?.total_usage || 0);
        const systemDelta = statsData.cpu_stats.system_cpu_usage - (statsData.precpu_stats?.system_cpu_usage || 0);
        const numberCPUs = statsData.cpu_stats.online_cpus || statsData.cpu_stats.cpu_usage.percpu_usage?.length || 1;

        if (systemDelta > 0.0 && cpuDelta > 0.0) {
            return ((cpuDelta / systemDelta) * numberCPUs * 100.0).toFixed(2);
        }
    } catch { /* ignore parse errors */ }
    return '0.00';
}

// Format Memory
function formatMemory(bytes) {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format Stats Data for Frontend
function formatStats(statsData) {
    try {
        const memUsage = statsData.memory_stats.usage - (statsData.memory_stats.stats?.inactive_file || 0); // More accurate usage
        const memLimit = statsData.memory_stats.limit;
        const memPercent = ((memUsage / memLimit) * 100.0).toFixed(2);

        // Network stats might need summing across interfaces if present
        let netRx = 0, netTx = 0;
        if (statsData.networks) {
            Object.values(statsData.networks).forEach(net => {
                netRx += net.rx_bytes;
                netTx += net.tx_bytes;
            });
        }

        // Disk I/O (summing read/write across devices; cgroup v2 reports lowercase ops)
        let diskRead = 0, diskWrite = 0;
        if (statsData.blkio_stats?.io_service_bytes_recursive) {
            statsData.blkio_stats.io_service_bytes_recursive.forEach(entry => {
                const op = entry.op.toLowerCase();
                if (op === 'read') diskRead += entry.value;
                if (op === 'write') diskWrite += entry.value;
            });
        }

        return {
            type: 'stats',
            cpuPercent: calculateCPUPercent(statsData),
            memUsage: formatMemory(memUsage),
            memLimit: formatMemory(memLimit),
            memPercent: isNaN(memPercent) ? '0.00' : memPercent,
            netRx: formatMemory(netRx),
            netTx: formatMemory(netTx),
            diskRead: formatMemory(diskRead),
            diskWrite: formatMemory(diskWrite),
            containerName: containerInfoCache?.Name?.substring(1) || TARGET_CONTAINER, // Remove leading '/'
            containerId: containerInfoCache?.Id?.substring(0, 12) || 'N/A'
        };
    } catch (e) {
        console.error('Error formatting stats:', e);
        return { type: 'error', message: 'Error processing stats' };
    }
}

function rejectUpgrade(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

// --- WebSocket Upgrade Handling (session-authenticated) ---
server.on('upgrade', (request, socket, head) => {
    // Cross-site WebSocket hijacking protection: only accept our own origin.
    if (request.headers.origin !== baseUrl.origin) {
        console.warn(`WebSocket rejected: bad origin "${request.headers.origin}"`);
        return rejectUpgrade(socket, 403, 'Forbidden');
    }

    sessionParser(request, {}, () => {
        const user = request.session?.user;
        if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
        if (!isAuthorized(user)) return rejectUpgrade(socket, 403, 'Forbidden');

        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.userInfo = user;
            ws.sessionExpires = request.session.cookie.expires;
            ws.logTail = normalizeLogTail(new URL(request.url, baseUrl).searchParams.get('logs'));
            wss.emit('connection', ws, request);
        });
    });
});


// --- WebSocket Connection Handler ---
wss.on('connection', async (ws) => {
    console.log(`Client connected: User='${ws.userInfo.username}', Name='${ws.userInfo.displayName}'`);
    let statsStream = null;
    let logStream = null;
    let logGeneration = 0; // drops late chunks of a replaced log stream (e.g. after switching the history size)

    // Close the socket when the login session expires, so the client has to re-authenticate.
    const msUntilExpiry = ws.sessionExpires ? new Date(ws.sessionExpires).getTime() - Date.now() : 0;
    const expiryTimer = msUntilExpiry > 0 ? setTimeout(() => ws.close(4001, 'Session expired'), msUntilExpiry) : null;

    // --- Function to safely send messages ---
    function safeSend(wsInstance, data) {
        if (wsInstance.readyState === WebSocket.OPEN) {
            try {
                wsInstance.send(JSON.stringify(data));
            } catch (e) {
                console.error('Failed to send message:', e);
            }
        }
    }

    // Send initial user info along with container info
    async function sendInitialInfo() {
        safeSend(ws, { type: 'app_config', title: APP_TITLE });
        safeSend(ws, { type: 'user_info', username: ws.userInfo.displayName });

        const container = await getContainer();
        if (!container) {
            safeSend(ws, { type: 'error', message: `Container "${TARGET_CONTAINER}" not found.` });
            return false;
        }

        safeSend(ws, {
            type: 'container_info',
            containerName: containerInfoCache.Name?.substring(1) || TARGET_CONTAINER,
            containerId: containerInfoCache.Id?.substring(0, 12) || 'N/A',
            image: containerInfoCache.Config?.Image || 'N/A',
            status: containerInfoCache.State?.Status || 'N/A',
        });
        await refreshJoinInfoFromLogs(container);
        await ensureJoinWatcher(container);
        safeSend(ws, joinInfoMessage());
        return true;
    }


    // --- Streaming Functions ---
    async function startStatsStreaming() {
        if (statsStream) statsStream.destroy();
        statsStream = null;
        const currentContainer = await getContainer();
        if (!currentContainer) return;
        try {
            statsStream = await currentContainer.stats({ stream: true });
            statsStream.on('data', (chunk) => { try { const d = JSON.parse(chunk.toString('utf-8')); safeSend(ws, formatStats(d)); } catch { /* partial chunk */ } });
            statsStream.on('end', () => { console.log('Stats stream ended'); statsStream = null; });
            statsStream.on('error', (err) => { console.error('Stats stream error:', err.message); statsStream = null; });
        } catch (err) { console.error('Error getting stats stream:', err.message || err); safeSend(ws, { type: 'error', message: `Failed to get stats: ${err.message}` }); }
    }
    async function startLogStreaming() {
        if (logStream) logStream.destroy();
        logStream = null;
        const generation = ++logGeneration;
        const currentContainer = await getContainer();
        if (!currentContainer) return;
        try {
            const opts = { stdout: true, stderr: true, follow: true };
            if (ws.logTail === 'start') {
                const startedAt = containerInfoCache?.State?.StartedAt;
                if (startedAt) opts.since = Math.floor(new Date(startedAt).getTime() / 1000);
                opts.tail = LOG_SINCE_START_CAP;
            } else {
                opts.tail = Number(ws.logTail);
            }
            const stream = await currentContainer.logs(opts);
            if (generation !== logGeneration) { stream.destroy(); return; } // replaced while connecting
            logStream = stream;
            safeSend(ws, { type: 'log_reset', tail: ws.logTail, limit: opts.tail });
            console.log(`Started log stream (tail: ${ws.logTail})...`);

            // Demultiplex Docker's stdout/stderr frames properly (a chunk can contain several frames).
            const forward = (source) => {
                const out = new PassThrough();
                let rest = '';
                out.on('data', (buf) => {
                    if (generation !== logGeneration) return;
                    const lines = (rest + buf.toString('utf-8')).split('\n');
                    rest = lines.pop();
                    lines.forEach(line => { if (line) safeSend(ws, { type: 'log', source, line }); });
                });
                return out;
            };
            if (containerInfoCache?.Config?.Tty) {
                logStream.pipe(forward('stdout'));
            } else {
                docker.modem.demuxStream(logStream, forward('stdout'), forward('stderr'));
            }

            stream.on('end', () => { if (generation !== logGeneration) return; console.log('Log stream ended'); safeSend(ws, { type: 'status', message: 'Log stream ended.' }); logStream = null; });
            stream.on('error', (err) => { if (generation !== logGeneration) return; console.error('Log stream error:', err.message); safeSend(ws, { type: 'error', message: `Log stream error: ${err.message}` }); logStream = null; });
        } catch (err) { console.error('Error getting log stream:', err.message || err); safeSend(ws, { type: 'error', message: `Failed to get logs: ${err.message}` }); }
    }
    function stopStreams() {
        if (statsStream) { statsStream.destroy(); statsStream = null; console.log('Stats stream stopped.'); }
        if (logStream) { logStream.destroy(); logStream = null; console.log('Log stream stopped.'); }
    }

    // Container restarted or recreated: refresh info + join code and reattach the streams.
    async function onContainerChange() {
        safeSend(ws, { type: 'status', message: 'Container restarted/recreated – reattaching streams...' });
        stopStreams();
        if (await sendInitialInfo()) {
            await startStatsStreaming();
            await startLogStreaming();
        }
    }
    containerChangeListeners.add(onContainerChange);

    // --- Start initial info sending and streams ---
    if (await sendInitialInfo()) {
        await startStatsStreaming();
        await startLogStreaming();
    }

    // --- Handle messages from client (Actions) ---
    ws.on('message', async (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch {
            return safeSend(ws, { type: 'error', message: 'Invalid command received.' });
        }
        console.log(`Received action '${parsedMessage.action}' from user '${ws.userInfo.username}'`);

        if (parsedMessage.action === 'set_log_tail') {
            ws.logTail = normalizeLogTail(parsedMessage.tail);
            return startLogStreaming();
        }

        if (parsedMessage.action !== 'restart') {
            return safeSend(ws, { type: 'error', message: `Unknown action "${parsedMessage.action}".` });
        }

        const currentContainer = await getContainer();
        if (!currentContainer) return safeSend(ws, { type: 'error', message: 'Container not found for action.' });

        safeSend(ws, { type: 'status', message: `Restarting container ${TARGET_CONTAINER}...` });
        try {
            await currentContainer.restart();
            console.log(`Container ${TARGET_CONTAINER} restarted by ${ws.userInfo.username}`);
            safeSend(ws, { type: 'status', message: 'Restart command sent.' });
        } catch (err) {
            console.error('Error restarting:', err.message || err);
            safeSend(ws, { type: 'error', message: `Restart failed: ${err.message}` });
        }
        // Notifies all connected clients (incl. this one), which reattach their streams.
        await checkContainerChange();
    });

    // --- Handle Disconnect / Error ---
    const cleanup = () => { containerChangeListeners.delete(onContainerChange); clearTimeout(expiryTimer); stopStreams(); };
    ws.on('close', () => { console.log(`Client disconnected: ${ws.userInfo.username}`); cleanup(); });
    ws.on('error', (error) => { console.error('WebSocket error:', error.message); cleanup(); });
});

// --- HTTP: security headers, session, auth, static frontend ---
app.disable('x-powered-by');
app.set('trust proxy', 1); // Traefik terminates TLS
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            'default-src': ["'self'"],
            'script-src': ["'self'"],
            'style-src': ["'self'"],
            'style-src-attr': ["'unsafe-inline'"], // ansi_up 256/true-colour spans
            'connect-src': ["'self'"],
            'img-src': ["'self'", 'data:'],
            'form-action': ["'self'", new URL(process.env.OIDC_ISSUER).origin],
        },
    },
}));

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/style.css', (req, res) => res.sendFile(path.join(FRONTEND_PATH, 'style.css'))); // also used by the 403 page
app.use(sessionParser);
app.use('/auth', authRouter());
app.use(requireAuth);
// Lets the frontend detect an expired session after a WebSocket disconnect (401 -> reload -> login).
app.get('/api/me', (req, res) => res.json({ username: req.session.user.username, displayName: req.session.user.displayName }));
// CPU / RAM history: ?from=<ms>&to=<ms>&points=<n> (defaults: last hour, 600 points)
app.get('/api/metrics', (req, res) => {
    const now = Date.now();
    const to = Math.min(Number(req.query.to) || now, now);
    const from = Math.max(Number(req.query.from) || to - 60 * 60 * 1000, now - METRICS_RETENTION_MS);
    if (!(from < to)) return res.status(400).json({ error: 'invalid range' });
    res.json({
        now,
        intervalMs: METRICS_INTERVAL_MS,
        retentionMs: METRICS_RETENTION_MS,
        range: metrics.range(),
        points: metrics.query(from, to, Number(req.query.points) || 600),
    });
});
app.use(express.static(FRONTEND_PATH));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('Request error:', err.message || err);
    res.status(500).type('text').send('Interner Fehler.');
});

// --- Start Server ---
server.listen(PORT, async () => {
    console.log(`Server started on port ${PORT}, public URL ${baseUrl.origin}`);
    console.log(`Application Title set to: "${APP_TITLE}"`);
    const container = await getContainer();
    if (container) { await refreshJoinInfoFromLogs(container); await ensureJoinWatcher(container); }
    await checkContainerChange(); // remember the current ID + start time
    if (targetContainer) await ensureCollector(targetContainer);
    setInterval(async () => {
        try {
            await checkContainerChange();
            if (targetContainer) await ensureCollector(targetContainer); // restarts a stalled stats stream
        } catch (err) { console.error('Container poll failed:', err.message || err); }
    }, CONTAINER_POLL_MS).unref();
    setInterval(flushMetrics, METRICS_INTERVAL_MS).unref();
    const prune = () => { try { const n = metrics.prune(); if (n) console.log(`Pruned ${n} old metric samples`); } catch (err) { console.error('Prune failed:', err.message); } };
    prune();
    setInterval(prune, 60 * 60 * 1000).unref();
    console.log(`Metrics: ${METRICS_DB_PATH}, every ${METRICS_INTERVAL_MS / 1000}s, keep ${METRICS_RETENTION_MS / 86400000} days`);
});

function shutdown(signal) {
    console.log(`${signal} received, shutting down server...`);
    wss.clients.forEach((client) => client.close(1001, 'Server shutting down'));
    wss.close();
    flushMetrics();
    collector?.stream?.destroy();
    server.close(() => { console.log('HTTP server closed.'); try { metrics.close(); } catch { /* already closed */ } process.exit(0); });
    setTimeout(() => { console.error('Graceful shutdown timeout, forcing exit.'); process.exit(1); }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
