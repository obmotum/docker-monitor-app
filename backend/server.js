const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Docker = require('dockerode');
const path = require('path');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
// IMPORTANT: Set this environment variable to the ID or Name of the container to monitor
const TARGET_CONTAINER_ID = process.env.TARGET_CONTAINER_ID;
const FRONTEND_PATH = process.env.FRONTEND_PATH || path.join(__dirname, '../frontend');
const LOG_TAIL_COUNT = process.env.LOG_TAIL_COUNT || 100; // How many past lines to show initially
const APP_TITLE = process.env.APP_TITLE || 'Docker Monitor';

if (!TARGET_CONTAINER_ID) {
    console.error("Error: TARGET_CONTAINER_ID environment variable is not set.");
    process.exit(1);
}

// --- Initialization ---
const app = express();
const server = http.createServer(app);
// Modify WebSocket Server initialization to access upgrade request headers
const wss = new WebSocket.Server({
    noServer: true // We'll handle the upgrade manually
});
// Connect to Docker daemon (adjust if using TCP socket)
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

let targetContainer = null;
let containerInfoCache = null;

// --- Helper Functions ---

// Find the container by ID or Name
async function getContainer() {
    if (targetContainer) { // Basic caching, ensure it's still valid if needed elsewhere
        try {
            // Quick check if container still exists (inspect is heavier)
            await targetContainer.inspect();
            return targetContainer;
        } catch (e) {
             console.warn("Cached container reference seems invalid, re-fetching...");
             targetContainer = null; // Clear cache
             containerInfoCache = null;
        }
    }

    // If no valid cache, find it
    try {
        const container = docker.getContainer(TARGET_CONTAINER_ID);
        containerInfoCache = await container.inspect(); // Cache initial info
        console.log(`Monitoring container: ${containerInfoCache.Name} (${containerInfoCache.Id.substring(0,12)})`);
        targetContainer = container;
        return container;
    } catch (err) {
        console.error(`Error finding container "${TARGET_CONTAINER_ID}":`, err.message || err);
        targetContainer = null; // Reset if not found
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
    } catch (e) { /* ignore parse errors */ }
    return '0.00';
}

// Format Memory
function formatMemory(bytes) {
    if (bytes === 0) return '0 Bytes';
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
        if(statsData.networks) {
            Object.values(statsData.networks).forEach(net => {
                netRx += net.rx_bytes;
                netTx += net.tx_bytes;
            });
        }

        // Disk I/O (summing read/write across devices)
        let diskRead = 0, diskWrite = 0;
        if (statsData.blkio_stats?.io_service_bytes_recursive) {
             statsData.blkio_stats.io_service_bytes_recursive.forEach(entry => {
                if (entry.op === 'Read') diskRead += entry.value;
                if (entry.op === 'Write') diskWrite += entry.value;
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
            containerName: containerInfoCache?.Name?.substring(1) || TARGET_CONTAINER_ID, // Remove leading '/'
            containerId: containerInfoCache?.Id?.substring(0,12) || 'N/A'
        };
    } catch (e) {
        console.error("Error formatting stats:", e);
        return { type: 'error', message: 'Error processing stats' };
    }
}


// --- WebSocket Upgrade Handling ---
server.on('upgrade', async (request, socket, head) => {
    // Extract user information from headers passed by the proxy (Caddy)
    const username = request.headers['remote-user'] || 'anonymous';
    const groups = request.headers['remote-groups'] || '';
    const displayName = request.headers['remote-name'] || username; // Use display name if available
    const email = request.headers['remote-email'] || '';

    // Optional: Add authentication/authorization check here if needed

    console.log(`WebSocket upgrade request for user: ${username} (Display: ${displayName})`);

    // Handle the WebSocket upgrade using the 'ws' library
    wss.handleUpgrade(request, socket, head, (ws) => {
        // Attach user info to the WebSocket connection object
        ws.userInfo = { username, groups, displayName, email };
        // Emit the connection event, now passing the ws and the request
        wss.emit('connection', ws, request);
    });
});


// --- WebSocket Connection Handler ---
wss.on('connection', async (ws, request) => {
    console.log(`Client connected: User='${ws.userInfo.username}', Name='${ws.userInfo.displayName}', Groups='${ws.userInfo.groups}'`);
    let statsStream = null;
    let logStream = null;

    // --- Function to safely send messages ---
    function safeSend(wsInstance, data) {
        if (wsInstance.readyState === WebSocket.OPEN) {
            try {
                wsInstance.send(JSON.stringify(data));
            } catch (e) {
                console.error("Failed to send message:", e);
            }
        }
    }

    // Send initial user info along with container info
    async function sendInitialInfo() {
        if (ws.readyState === WebSocket.OPEN) {
            safeSend(ws, {
                type: 'app_config',
                title: APP_TITLE // Sende den ausgelesenen Titel
            });
        }

        const container = await getContainer();
        if (!container && ws.readyState === WebSocket.OPEN) {
            safeSend(ws, { type: 'error', message: `Container "${TARGET_CONTAINER_ID}" not found.` });
            safeSend(ws, { type: 'user_info', username: ws.userInfo.displayName }); // Send display name
            // Consider not closing immediately, let user see error? ws.close();
            return false;
        }

        let containerInfoSent = false;
        if (containerInfoCache && ws.readyState === WebSocket.OPEN) {
            safeSend(ws, {
                type: 'container_info', // Renamed type
                containerName: containerInfoCache.Name?.substring(1) || TARGET_CONTAINER_ID,
                containerId: containerInfoCache.Id?.substring(0, 12) || 'N/A',
                image: containerInfoCache.Config?.Image || 'N/A',
                status: containerInfoCache.State?.Status || 'N/A',
            });
            containerInfoSent = true;
        }

        // Always send user info if connection is open
        if (ws.readyState === WebSocket.OPEN) {
             safeSend(ws, {
                type: 'user_info',
                username: ws.userInfo.displayName // Send display name
            });
        }
        return container !== null; // Return true if container exists
    }


    // --- Streaming Functions ---
    async function startStatsStreaming() {
        if (statsStream) statsStream.destroy();
        statsStream = null;
        const currentContainer = await getContainer();
        if (!currentContainer) return;
        try {
            statsStream = await currentContainer.stats({ stream: true });
            statsStream.on('data', (chunk) => { try { const d = JSON.parse(chunk.toString('utf-8')); safeSend(ws, formatStats(d)); } catch (e) {} });
            statsStream.on('end', () => { console.log('Stats stream ended'); statsStream = null; });
            statsStream.on('error', (err) => { console.error('Stats stream error:', err.message); statsStream = null; });
        } catch (err) { console.error("Error getting stats stream:", err.message || err); safeSend(ws, { type: 'error', message: `Failed to get stats: ${err.message}` }); }
    }
    async function startLogStreaming() {
        if (logStream) logStream.destroy();
        logStream = null;
        const currentContainer = await getContainer();
        if (!currentContainer) return;
        try {
            const streamOpts = { stdout: true, stderr: true, follow: true, tail: LOG_TAIL_COUNT };
            logStream = await currentContainer.logs(streamOpts);
            console.log(`Started log stream (tail: ${LOG_TAIL_COUNT})...`);
            logStream.on('data', (chunk) => {
                if (chunk instanceof Buffer && chunk.length > 8) {
                    try {
                        const type = chunk[0];
                        const payload = chunk.slice(8).toString('utf-8');
                        const source = type === 1 ? 'stdout' : type === 2 ? 'stderr' : 'unknown';
                        payload.split('\n').forEach(line => { if (line) safeSend(ws, { type: 'log', source: source, line: line }); });
                    } catch (e) { console.error("Error processing log chunk:", e); safeSend(ws, { type: 'log', source: 'error', line: `Log chunk error: ${e.message}` });}
                } else { safeSend(ws, { type: 'log', source: 'raw', line: chunk.toString('utf-8').trim() }); }
            });
            logStream.on('end', () => { console.log('Log stream ended'); safeSend(ws, { type: 'status', message: 'Log stream ended.' }); logStream = null; });
            logStream.on('error', (err) => { console.error('Log stream error:', err.message); safeSend(ws, { type: 'error', message: `Log stream error: ${err.message}` }); logStream = null; });
        } catch (err) { console.error("Error getting log stream:", err.message || err); safeSend(ws, { type: 'error', message: `Failed to get logs: ${err.message}` }); }
    }
    function stopStreams() {
        if (statsStream) { statsStream.destroy(); statsStream = null; console.log("Stats stream stopped.");}
        if (logStream) { logStream.destroy(); logStream = null; console.log("Log stream stopped."); }
    }

    // --- Start initial info sending and streams ---
    const canStartStreams = await sendInitialInfo();
    if (canStartStreams) {
        await startStatsStreaming();
        await startLogStreaming();
    }

    // --- Handle messages from client (Actions) ---
    ws.on('message', async (message) => {
        // Optional: Permission check based on ws.userInfo
        // const userGroups = ws.userInfo.groups.split(',');
        // if (!userGroups.includes('admins')) { ... return error ... }

        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
            console.log(`Received action '${parsedMessage.action}' from user '${ws.userInfo.username}'`);

            const currentContainer = await getContainer();
            if (!currentContainer) { safeSend(ws, { type: 'error', message: 'Container not found for action.' }); return; }

            if (parsedMessage.action === 'restart') {
                safeSend(ws, { type: 'status', message: `Restarting container ${TARGET_CONTAINER_ID}...` });
                try {
                    stopStreams();
                    await currentContainer.restart();
                    containerInfoCache = await currentContainer.inspect();
                    safeSend(ws, { type: 'status', message: 'Restart command sent. Re-fetching info & restarting streams...' });
                    await sendInitialInfo(); // Resend info (includes user)
                    setTimeout(() => { startStatsStreaming(); startLogStreaming(); }, 1500);
                } catch (err) { console.error("Error restarting:", err.message||err); safeSend(ws, { type: 'error', message: `Restart failed: ${err.message}` }); setTimeout(() => { startStatsStreaming(); startLogStreaming(); }, 1500); }
            } else if (parsedMessage.action === 'upgrade') {
                safeSend(ws, { type: 'status', message: `Attempting upgrade for ${TARGET_CONTAINER_ID}...` });
                stopStreams();
                await handleUpgrade(ws, currentContainer);
                const potentiallyNewContainer = await getContainer();
                if (potentiallyNewContainer) {
                    safeSend(ws, { type: 'status', message: 'Upgrade finished or attempted. Restarting streams...' });
                    await sendInitialInfo(); // Resend info (includes user)
                    setTimeout(() => { startStatsStreaming(); startLogStreaming(); }, 1500);
                } else { safeSend(ws, { type: 'error', message: 'Container not found after upgrade attempt.' }); }
            }
        } catch (e) { console.error('Failed to parse message or execute action:', e); safeSend(ws, { type: 'error', message: 'Invalid command received.' }); }
    });

    // --- Handle Disconnect / Error ---
    ws.on('close', () => { console.log('Client disconnected'); stopStreams(); });
    ws.on('error', (error) => { console.error('WebSocket error:', error.message); stopStreams(); });

    // --- Upgrade Logic (Simplified V1 using Dockerode) ---
    async function handleUpgrade(ws, container) {
        let originalConfig, imageName, containerName;
        try {
            safeSend(ws, { type: 'status', message: 'Inspecting current container...' });
            originalConfig = await container.inspect();
            imageName = originalConfig.Config.Image;
            containerName = originalConfig.Name.substring(1);
            const imageBaseName = imageName.includes(':') ? imageName.split(':')[0] : imageName;
            const imageToPull = `${imageBaseName}:latest`;
            safeSend(ws, { type: 'status', message: `Pulling image ${imageToPull}...` });
            await new Promise((resolve, reject) => { /* ... docker.pull logic ... */ });
            safeSend(ws, { type: 'status', message: `Image ${imageToPull} pulled.` });
            safeSend(ws, { type: 'status', message: 'Stopping current container...' });
            await container.stop();
            safeSend(ws, { type: 'status', message: 'Removing current container...' });
            await container.remove();
            targetContainer = null; containerInfoCache = null; // Invalidate cache
            safeSend(ws, { type: 'status', message: 'Creating new container...' });
            const createOptions = { /* ... create options ... */ };
            const newContainer = await docker.createContainer(createOptions);
            safeSend(ws, { type: 'status', message: 'Starting new container...' });
            await newContainer.start();
            targetContainer = newContainer; // Update global reference
            containerInfoCache = await newContainer.inspect(); // Update global cache
            safeSend(ws, { type: 'status', message: 'Upgrade process completed successfully.' });
        } catch (err) { console.error("Upgrade failed:", err.message||err); safeSend(ws, { type: 'error', message: `Upgrade failed: ${err.message}` }); targetContainer = null; await getContainer(); }
    }
});

// --- Static File Server ---
console.log(`Serving frontend files from: ${FRONTEND_PATH}`);
app.use(express.static(FRONTEND_PATH));

// --- Start Server ---
server.listen(PORT, async () => {
    console.log(`Server started on port ${PORT}`);
    console.log(`Application Title set to: "${APP_TITLE}"`); // Logge den verwendeten Titel
    await getContainer();
});

process.on('SIGINT', () => {
    console.log("Shutting down server...");
    wss.close(() => { console.log("WebSocket server closed."); });
    server.close(() => { console.log("HTTP server closed."); process.exit(0); });
    setTimeout(() => { console.error("Graceful shutdown timeout, forcing exit."); process.exit(1); }, 5000);
});