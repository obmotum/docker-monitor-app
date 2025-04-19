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
async function getContainer() {
    if (targetContainer) return targetContainer;
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

// Basic CPU Percentage Calculation (more accurate methods exist)
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

function formatMemory(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

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
            containerName: containerInfoCache?.Name?.substring(1) || TARGET_CONTAINER_ID, // Remove leading '/' from Name
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

    const container = await getContainer(); // Ensure we have the container object
    if (!container) {
        ws.send(JSON.stringify({ type: 'error', message: `Container "${TARGET_CONTAINER_ID}" not found.` }));
        ws.close();
        return;
    }

    // Send initial info
     if (containerInfoCache) {
         ws.send(JSON.stringify({
             type: 'info',
             containerName: containerInfoCache.Name?.substring(1) || TARGET_CONTAINER_ID,
             containerId: containerInfoCache.Id?.substring(0, 12) || 'N/A',
             image: containerInfoCache.Config?.Image || 'N/A',
             status: containerInfoCache.State?.Status || 'N/A',
         }));
     }

    // Stream stats
    try {
        statsStream = await container.stats({ stream: true });

        statsStream.on('data', (chunk) => {
            try {
                const statsData = JSON.parse(chunk.toString('utf-8'));
                const formatted = formatStats(statsData);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(formatted));
                }
            } catch (parseError) {
                // Docker stats stream might send incomplete JSON initially, ignore parse errors silently or log if needed
                // console.warn("Could not parse stats chunk:", parseError);
            }
        });

        statsStream.on('end', () => {
            console.log('Stats stream ended');
            if (ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({ type: 'status', message: 'Stats stream ended.' }));
            }
        });

        statsStream.on('error', (err) => {
            console.error('Stats stream error:', err);
             if (ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({ type: 'error', message: `Stats stream error: ${err.message}` }));
             }
        });

    } catch (streamError) {
        console.error("Error getting stats stream:", streamError);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: `Failed to get stats: ${streamError.message}` }));
        }
        ws.close();
        return;
    }

    // Handle messages from client (Restart/Upgrade)
    ws.on('message', async (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
            console.log('Received action:', parsedMessage.action);

            const currentContainer = await getContainer(); // Re-fetch in case it was recreated
            if (!currentContainer) {
                ws.send(JSON.stringify({ type: 'error', message: 'Container not found.' }));
                return;
            }

            if (parsedMessage.action === 'restart') {
                ws.send(JSON.stringify({ type: 'status', message: `Restarting container ${TARGET_CONTAINER_ID}...` }));
                try {
                    await currentContainer.restart();
                    // Re-inspect after restart to update cache and send info
                    containerInfoCache = await currentContainer.inspect();
                    ws.send(JSON.stringify({ type: 'status', message: 'Restart command sent successfully.' }));
                     ws.send(JSON.stringify({ // Send updated info
                        type: 'info',
                        containerName: containerInfoCache.Name?.substring(1) || TARGET_CONTAINER_ID,
                        containerId: containerInfoCache.Id?.substring(0, 12) || 'N/A',
                        image: containerInfoCache.Config?.Image || 'N/A',
                        status: containerInfoCache.State?.Status || 'N/A',
                    }));
                } catch (err) {
                    console.error("Error restarting container:", err);
                    ws.send(JSON.stringify({ type: 'error', message: `Restart failed: ${err.message}` }));
                }
            } else if (parsedMessage.action === 'upgrade') {
                ws.send(JSON.stringify({ type: 'status', message: `Attempting upgrade for ${TARGET_CONTAINER_ID}...` }));
                await handleUpgrade(ws, currentContainer);
            }

        } catch (e) {
            console.error('Failed to parse message or execute action:', e);
             ws.send(JSON.stringify({ type: 'error', message: 'Invalid command received.' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        if (statsStream) {
            console.log('Stopping stats stream...');
            statsStream.destroy(); // IMPORTANT: Stop the stream when client disconnects
            statsStream = null;
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
         if (statsStream) {
            statsStream.destroy();
            statsStream = null;
        }
    });
});

// --- Upgrade Logic (Simplified - Use Docker Compose for robust upgrades) ---
async function handleUpgrade(ws, container) {
    let originalConfig;
    let imageName;
    let containerName;

    try {
        ws.send(JSON.stringify({ type: 'status', message: 'Inspecting current container...' }));
        originalConfig = await container.inspect();
        imageName = originalConfig.Config.Image; // e.g., "myimage:latest" or "nginx"
        containerName = originalConfig.Name.substring(1); // Remove leading '/'
        const currentId = originalConfig.Id;

        // Ensure we use the base image name + potentially 'latest' if no tag specified
        const imageBaseName = imageName.includes(':') ? imageName.split(':')[0] : imageName;
        const imageToPull = `${imageBaseName}:latest`; // Assume upgrade means 'latest'

        ws.send(JSON.stringify({ type: 'status', message: `Pulling image ${imageToPull}...` }));
        await new Promise((resolve, reject) => {
            docker.pull(imageToPull, (err, stream) => {
                if (err) return reject(err);
                docker.modem.followProgress(stream, (err, output) => { // Show pull progress
                    if (err) return reject(err);
                    resolve(output);
                }, (event) => { // Progress event handler (optional: send to client)
                    // console.log(event.status, event.progress || '');
                     if(event.status && ws.readyState === WebSocket.OPEN) {
                         ws.send(JSON.stringify({ type: 'status', message: `Pull: ${event.status} ${event.progress || ''}` }));
                     }
                });
            });
        });
        ws.send(JSON.stringify({ type: 'status', message: `Image ${imageToPull} pulled.` }));

        ws.send(JSON.stringify({ type: 'status', message: 'Stopping current container...' }));
        await container.stop();

        ws.send(JSON.stringify({ type: 'status', message: 'Removing current container...' }));
        await container.remove();

        ws.send(JSON.stringify({ type: 'status', message: 'Creating new container...' }));

        // --- Recreate container with OLD configuration but NEW image ---
        // WARNING: This is complex and might miss settings. Docker Compose 'up' handles this better.
        const createOptions = {
            name: containerName,
            Image: imageToPull, // Use the newly pulled image
            Cmd: originalConfig.Config.Cmd,
            Env: originalConfig.Config.Env,
            Labels: originalConfig.Config.Labels,
            ExposedPorts: originalConfig.Config.ExposedPorts,
            HostConfig: originalConfig.HostConfig // Reuse volumes, port bindings, network mode etc.
            // Note: Network settings might need specific handling if not default bridge
        };

        const newContainer = await docker.createContainer(createOptions);

        ws.send(JSON.stringify({ type: 'status', message: 'Starting new container...' }));
        await newContainer.start();

        // --- Update internal state ---
        targetContainer = newContainer; // Update the reference
        containerInfoCache = await newContainer.inspect(); // Update cache

        ws.send(JSON.stringify({ type: 'status', message: 'Upgrade process completed successfully.' }));
        ws.send(JSON.stringify({ // Send updated info
            type: 'info',
            containerName: containerInfoCache.Name?.substring(1) || TARGET_CONTAINER_ID,
            containerId: containerInfoCache.Id?.substring(0, 12) || 'N/A',
            image: containerInfoCache.Config?.Image || 'N/A',
            status: containerInfoCache.State?.Status || 'N/A',
        }));
        console.log(`Container ${containerName} upgraded to image ${imageToPull}`);

    } catch (err) {
        console.error("Upgrade failed:", err);
        ws.send(JSON.stringify({ type: 'error', message: `Upgrade failed: ${err.message || err}` }));
        // Attempt to restore targetContainer reference if creation failed mid-way
        targetContainer = null; // Force re-fetch on next action/connection
        await getContainer();
    }
}


// --- Static File Server ---
console.log(`Serving frontend files from: ${FRONTEND_PATH}`);
app.use(express.static(FRONTEND_PATH));

// --- Start Server ---
server.listen(PORT, async () => {
    console.log(`Server started on port ${PORT}`);
    await getContainer(); // Try to get container info on startup
});

process.on('SIGINT', () => {
    console.log("Shutting down server...");
    wss.close();
    server.close(() => {
        console.log("Server closed.");
        process.exit(0);
    });
});