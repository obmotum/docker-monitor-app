document.addEventListener('DOMContentLoaded', () => {
    const wsStatus = document.getElementById('ws-status');
    const containerName = document.getElementById('container-name');
    const containerId = document.getElementById('container-id');
    const containerImage = document.getElementById('container-image');
    const containerStatus = document.getElementById('container-status');
    const cpuUsage = document.getElementById('cpu-usage');
    const memUsage = document.getElementById('mem-usage');
    const memLimit = document.getElementById('mem-limit');
    const memPercent = document.getElementById('mem-percent');
    const netIo = document.getElementById('net-io');
    const diskIo = document.getElementById('disk-io');
    const restartBtn = document.getElementById('restart-btn');
    const upgradeBtn = document.getElementById('upgrade-btn');
    const logOutput = document.getElementById('log-output');

    let ws = null;

    function connectWebSocket() {
        // Use wss:// if your server uses HTTPS/WSS
        const wsUrl = `ws://${window.location.host}`;
        ws = new WebSocket(wsUrl);

        updateStatus('Connecting...', 'connecting');
        logMessage('Attempting to connect to WebSocket...');

        ws.onopen = () => {
            updateStatus('Connected', 'connected');
            logMessage('WebSocket connection established.');
            enableButtons(true);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // console.log("Received data:", data); // For debugging

                switch (data.type) {
                    case 'stats':
                        updateStats(data);
                        break;
                    case 'info':
                        updateInfo(data);
                        break;
                    case 'status':
                        logMessage(`Status: ${data.message}`);
                        break;
                    case 'error':
                         logMessage(`Error: ${data.message}`, true);
                        break;
                    default:
                        logMessage(`Unknown message type: ${data.type}`);
                }
            } catch (e) {
                logMessage(`Error parsing message: ${e}`, true);
                console.error("Error parsing message: ", event.data);
            }
        };

        ws.onerror = (error) => {
            logMessage(`WebSocket Error: ${error.message || 'An error occurred'}`, true);
            console.error('WebSocket Error: ', error);
            updateStatus('Error', 'disconnected');
            enableButtons(false);
        };

        ws.onclose = (event) => {
            const reason = event.reason || `code ${event.code}`;
            updateStatus(`Closed (${reason})`, 'disconnected');
            logMessage(`WebSocket connection closed: ${reason}`);
            enableButtons(false);
            ws = null; // Clear reference
            // Optional: Attempt to reconnect after a delay
            setTimeout(connectWebSocket, 5000); // Reconnect after 5 seconds
        };
    }

    function updateStatus(text, className) {
        wsStatus.textContent = text;
        wsStatus.className = className; // Update class for styling
    }

    function updateInfo(data) {
        containerName.textContent = data.containerName || 'N/A';
        containerId.textContent = data.containerId || 'N/A';
        containerImage.textContent = data.image || 'N/A';
        containerStatus.textContent = data.status || 'N/A';
    }

    function updateStats(data) {
        cpuUsage.textContent = data.cpuPercent || '--';
        memUsage.textContent = data.memUsage || '--';
        memLimit.textContent = data.memLimit || '--';
        memPercent.textContent = data.memPercent || '--';
        netIo.textContent = `${data.netRx || '--'} Rx / ${data.netTx || '--'} Tx`;
        diskIo.textContent = `${data.diskRead || '--'} Read / ${data.diskWrite || '--'} Write`;
    }

    function logMessage(message, isError = false) {
        const time = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.textContent = `[${time}] ${message}`;
        if (isError) {
            logEntry.style.color = '#ff6b6b'; // Error color
        }
        logOutput.appendChild(logEntry);
        // Scroll to bottom
        logOutput.scrollTop = logOutput.scrollHeight;
    }

    function enableButtons(enabled) {
        restartBtn.disabled = !enabled;
        upgradeBtn.disabled = !enabled;
    }

    function sendAction(action) {
        if (ws && ws.readyState === WebSocket.OPEN) {
             logMessage(`Sending action: ${action}`);
            ws.send(JSON.stringify({ action: action }));
            // Optionally disable buttons briefly after click
            // enableButtons(false);
            // setTimeout(() => enableButtons(true), 2000); // Re-enable after 2s
        } else {
            logMessage('Cannot send action: WebSocket is not connected.', true);
        }
    }

    // Event Listeners
    restartBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to restart the container?')) {
            sendAction('restart');
        }
    });

    upgradeBtn.addEventListener('click', () => {
         if (confirm('Are you sure you want to attempt an upgrade? This will pull the latest image tag, stop, remove, and recreate the container.')) {
            sendAction('upgrade');
        }
    });

    // Initial connection
    connectWebSocket();
});