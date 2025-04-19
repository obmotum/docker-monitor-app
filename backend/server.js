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

if (!TARGET_CONTAINER_ID) {
    console.error("Error: TARGET_CONTAINER_ID environment variable is not set.");
    process.exit(1);
}

// --- Initialization ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
// Connect to Docker daemon (adjust if using TCP socket)
const docker = new Docker({ socketPath: '/var/run/docker.sock' }); // or { host: '127.0.0.1', port: 2375 }

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

// --- WebSocket Logic ---
wss.on('connection', async (ws) => {
    console.log('Client connected');
    let statsStream = null;
    let logStream = null;

    const container = await getContainer();
    if (!container) {
        safeSend(ws, { type: 'error', message: `Container "${TARGET_CONTAINER_ID}" not found.` });
        ws.close();
        return;
    }

    // Send initial info
    if (containerInfoCache) {
        safeSend(ws, {
            type: 'info',
            containerName: containerInfoCache.Name?.substring(1) || TARGET_CONTAINER_ID,
            containerId: containerInfoCache.Id?.substring(0, 12) || 'N/A',
            image: containerInfoCache.Config?.Image || 'N/A',
            status: containerInfoCache.State?.Status || 'N/A',
        });
    }

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

    // --- Function to start Stats Streaming ---
    async function startStatsStreaming() {
        if (statsStream) statsStream.destroy(); // Stop existing stream if any
        statsStream = null;

        const currentContainer = await getContainer(); // Re-fetch container reference
        if (!currentContainer) {
            console.log("Stats stream: Container not found.");
            return;
        }

        try {
            console.log("Starting stats stream...");
            statsStream = await currentContainer.stats({ stream: true });
            statsStream.on('data', (chunk) => {
                try {
                    const statsData = JSON.parse(chunk.toString('utf-8'));
                    const formatted = formatStats(statsData);
                    safeSend(ws, formatted);
                } catch (parseError) {}
            });
            statsStream.on('end', () => { console.log('Stats stream ended'); statsStream = null; });
            statsStream.on('error', (err) => { console.error('Stats stream error:', err.message); statsStream = null; });
        } catch (streamError) {
            console.error("Error getting stats stream:", streamError.message || streamError);
            safeSend(ws, { type: 'error', message: `Failed to get stats: ${streamError.message}` });
        }
    }

    // --- Function to start Log Streaming ---
    async function startLogStreaming() {
        if (logStream) logStream.destroy(); // Stop existing stream if any
        logStream = null;

        const currentContainer = await getContainer(); // Re-fetch container reference
        if (!currentContainer) {
             console.log("Log stream: Container not found.");
            return;
        }

        try {
            const streamOpts = {
                stdout: true,
                stderr: true,
                follow: true,
                tail: LOG_TAIL_COUNT
            };
            console.log(`Starting log stream (tail: ${LOG_TAIL_COUNT})...`);
            logStream = await currentContainer.logs(streamOpts);

            logStream.on('data', (chunk) => {
                 if (chunk instanceof Buffer && chunk.length > 8) {
                     try {
                        const type = chunk[0]; // 1 = stdout, 2 = stderr
                        // NOTE: Following assumes LENGTH specifies bytes, check Docker docs if issues
                        // Size is often ignored in simple streams, we just read the payload
                        const payload = chunk.slice(8).toString('utf-8');
                        const source = type === 1 ? 'stdout' : type === 2 ? 'stderr' : 'unknown';

                        payload.split('\n').forEach(line => {
                           if (line) { // Avoid sending empty lines created by split
                               safeSend(ws, { type: 'log', source: source, line: line });
                           }
                        });
                     } catch (bufferError) {
                          console.error("Error processing log chunk buffer:", bufferError);
                           safeSend(ws, { type: 'log', source: 'error', line: `Error processing log chunk: ${bufferError.message}` });
                     }
                 } else {
                     // Fallback for unexpected chunk format
                     safeSend(ws, { type: 'log', source: 'raw', line: chunk.toString('utf-8').trim() });
                 }
             });

            logStream.on('end', () => {
                console.log('Log stream ended');
                safeSend(ws, { type: 'status', message: 'Log stream ended.' });
                logStream = null;
            });

            logStream.on('error', (err) => {
                console.error('Log stream error:', err.message);
                safeSend(ws, { type: 'error', message: `Log stream error: ${err.message}` });
                logStream = null;
            });

        } catch (logError) {
            console.error("Error getting log stream:", logError.message || logError);
            safeSend(ws, { type: 'error', message: `Failed to get logs: ${logError.message}` });
        }
    }

    // --- Start initial streams ---
    await startStatsStreaming();
    await startLogStreaming();

    // --- Stop streams helper ---
    function stopStreams() {
        if (statsStream) { statsStream.destroy(); statsStream = null; console.log("Stats stream stopped.");}
        if (logStream) { logStream.destroy(); logStream = null; console.log("Log stream stopped."); }
    }

    // --- Handle messages from client (Actions) ---
    ws.on('message', async (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
            console.log('Received action:', parsedMessage.action);

            const currentContainer = await getContainer(); // Re-fetch in case it changed
            if (!currentContainer) {
                safeSend(ws, { type: 'error', message: 'Container not found for action.' });
                return;
            }

            if (parsedMessage.action === 'restart') {
                safeSend(ws, { type: 'status', message: `Restarting container ${TARGET_CONTAINER_ID}...` });
                try {
                    stopStreams(); // Stop streams before restart
                    await currentContainer.restart();
                    // Re-inspect after restart to update cache and send info
                    containerInfoCache = await currentContainer.inspect();
                    safeSend(ws, { type: 'status', message: 'Restart command sent. Re-fetching info & restarting streams...' });
                    safeSend(ws, { // Send updated info
                        type: 'info',
                        containerName: containerInfoCache.Name?.substring(1) || TARGET_CONTAINER_ID,
                        containerId: containerInfoCache.Id?.substring(0, 12) || 'N/A',
                        image: containerInfoCache.Config?.Image || 'N/A',
                        status: containerInfoCache.State?.Status || 'N/A',
                    });
                    // Restart streams after a short delay to allow container to come up
                    setTimeout(() => {
                         startStatsStreaming();
                         startLogStreaming();
                    }, 1500); // Delay 1.5 seconds (adjust if needed)

                } catch (err) {
                    console.error("Error restarting container:", err.message || err);
                    safeSend(ws, { type: 'error', message: `Restart failed: ${err.message}` });
                     // Try restarting streams even on failure, container might still exist
                    setTimeout(() => {
                        startStatsStreaming();
                        startLogStreaming();
                    }, 1500);
                }
            } else if (parsedMessage.action === 'upgrade') {
                safeSend(ws, { type: 'status', message: `Attempting upgrade for ${TARGET_CONTAINER_ID}...` });
                stopStreams(); // Stop streams before upgrade attempt
                await handleUpgrade(ws, currentContainer); // handleUpgrade defined below

                // After handleUpgrade attempts, check container status and restart streams
                 const potentiallyNewContainer = await getContainer(); // getContainer updates internal cache
                 if (potentiallyNewContainer) {
                     safeSend(ws, { type: 'status', message: 'Upgrade finished or attempted. Restarting streams...' });
                      // Send potentially updated info
                     safeSend(ws, {
                        type: 'info',
                        containerName: containerInfoCache.Name?.substring(1) || TARGET_CONTAINER_ID,
                        containerId: containerInfoCache.Id?.substring(0, 12) || 'N/A',
                        image: containerInfoCache.Config?.Image || 'N/A',
                        status: containerInfoCache.State?.Status || 'N/A',
                     });
                    setTimeout(() => {
                        startStatsStreaming();
                        startLogStreaming();
                    }, 1500);
                 } else {
                      safeSend(ws, { type: 'error', message: 'Container not found after upgrade attempt.' });
                 }

            } // ... other actions?

        } catch (e) {
            console.error('Failed to parse message or execute action:', e);
            safeSend(ws, { type: 'error', message: 'Invalid command received.' });
        }
    });

    // --- Handle Disconnect ---
    ws.on('close', () => {
        console.log('Client disconnected');
        stopStreams(); // Clean up streams
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        stopStreams(); // Clean up streams
    });


    // --- Upgrade Logic (Simplified V1 using Dockerode) ---
    async function handleUpgrade(ws, container) {
        let originalConfig;
        let imageName;
        let containerName;
        let success = false;

        try {
            safeSend(ws, { type: 'status', message: 'Inspecting current container...' });
            originalConfig = await container.inspect();
            imageName = originalConfig.Config.Image;
            containerName = originalConfig.Name.substring(1);

            const imageBaseName = imageName.includes(':') ? imageName.split(':')[0] : imageName;
            const imageToPull = `${imageBaseName}:latest`;

            safeSend(ws, { type: 'status', message: `Pulling image ${imageToPull}...` });
            await new Promise((resolve, reject) => {
                docker.pull(imageToPull, (err, stream) => {
                    if (err) return reject(err);
                    docker.modem.followProgress(stream, (err, output) => {
                        if (err) return reject(err);
                        resolve(output);
                    }, (event) => {
                         if(event.status && ws.readyState === WebSocket.OPEN) {
                             safeSend(ws, { type: 'status', message: `Pull: ${event.status} ${event.progress || ''}` });
                         }
                    });
                });
            });
            safeSend(ws, { type: 'status', message: `Image ${imageToPull} pulled.` });

            safeSend(ws, { type: 'status', message: 'Stopping current container...' });
            await container.stop();

            safeSend(ws, { type: 'status', message: 'Removing current container...' });
            await container.remove();
            targetContainer = null; // Invalidate cache immediately
            containerInfoCache = null;


            safeSend(ws, { type: 'status', message: 'Creating new container...' });
            const createOptions = {
                name: containerName,
                Image: imageToPull,
                Cmd: originalConfig.Config.Cmd,
                Env: originalConfig.Config.Env,
                Labels: originalConfig.Config.Labels,
                ExposedPorts: originalConfig.Config.ExposedPorts,
                HostConfig: originalConfig.HostConfig
            };
            const newContainer = await docker.createContainer(createOptions);

            safeSend(ws, { type: 'status', message: 'Starting new container...' });
            await newContainer.start();

            // --- Update internal state (important!) ---
            targetContainer = newContainer; // Update the global reference
            containerInfoCache = await newContainer.inspect(); // Update global cache

            safeSend(ws, { type: 'status', message: 'Upgrade process completed successfully.' });
            console.log(`Container ${containerName} upgraded to image ${imageToPull}`);
            success = true;

        } catch (err) {
            console.error("Upgrade failed:", err.message || err);
            safeSend(ws, { type: 'error', message: `Upgrade failed: ${err.message || err}` });
            // Attempt to re-establish reference if possible (container might exist if stop/rm failed)
            targetContainer = null;
            await getContainer(); // This will try to find the original or potentially a new one if creation failed late
        }
        // No return needed, streams restarted in caller
    }

});

// --- Static File Server & Server Start ---
console.log(`Serving frontend files from: ${FRONTEND_PATH}`);
app.use(express.static(FRONTEND_PATH));

// --- Start Server ---
server.listen(PORT, async () => {
    console.log(`Server started on port ${PORT}`);
    await getContainer(); // Try to get container info on startup
});

process.on('SIGINT', () => {
    console.log("Shutting down server...");
    wss.close(() => { console.log("WebSocket server closed."); });
    server.close(() => {
        console.log("HTTP server closed.");
        process.exit(0);
    });
    // Force exit after timeout if servers don't close gracefully
    setTimeout(() => {
      console.error("Could not close connections gracefully, forcing shutdown");
      process.exit(1);
    }, 5000);
});