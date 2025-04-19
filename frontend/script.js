document.addEventListener('DOMContentLoaded', () => {
    // --- Element References ---
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
    const tabButtons = document.querySelectorAll('.tab-button');
    const views = document.querySelectorAll('.view');
    const logOutput = document.getElementById('log-output'); // For container logs
    const statusLogOutput = document.getElementById('status-log-output'); // For status messages
    const clearLogsBtn = document.getElementById('clear-logs-btn');

    // --- WebSocket and State ---
    let ws = null;
    const MAX_LOG_LINES = 500; // Limit number of lines in container log view
    let reconnectInterval = null;

    // --- Tab Switching Logic ---
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetId = button.getAttribute('data-target');
            switchTab(targetId);
        });
    });

    function switchTab(targetId) {
        // Update button active state
        tabButtons.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-target') === targetId);
        });

        // Update view visibility
        views.forEach(view => {
            view.classList.toggle('active', view.id === targetId);
        });
    }

    // --- WebSocket Connection Logic ---
    function connectWebSocket() {
        // Clear any existing reconnect interval
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
        // Prevent multiple connections if already connecting/open
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            console.log("WebSocket already connecting or open.");
            return;
        }

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}`;
        ws = new WebSocket(wsUrl);

        updateStatus('Connecting...', 'connecting');
        logStatusMessage('Attempting to connect to WebSocket...');

        ws.onopen = () => {
            updateStatus('Connected', 'connected');
            logStatusMessage('WebSocket connection established.');
            enableButtons(true);
            // Clear reconnect interval on successful connection
            if (reconnectInterval) {
                 clearInterval(reconnectInterval);
                 reconnectInterval = null;
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                switch (data.type) {
                    case 'stats':
                        updateStats(data);
                        break;
                    case 'info':
                        updateInfo(data);
                        break;
                    case 'log':
                        logContainerMessage(data.line, data.source);
                        break;
                    case 'status':
                        logStatusMessage(`Status: ${data.message}`);
                        break;
                    case 'error':
                         logStatusMessage(`Error: ${data.message}`, true);
                        break;
                    default:
                        logStatusMessage(`Unknown message type: ${data.type}`);
                }
            } catch (e) {
                 logStatusMessage(`Error parsing message: ${e}`, true);
                 console.error("Error parsing message data: ", event.data);
             }
        };

        ws.onerror = (error) => {
             // Don't log generic event object, just that an error occurred
             logStatusMessage('WebSocket Error occurred.', true);
             console.error('WebSocket Error Event: ', error);
             // onclose will handle status update and reconnect attempt
        };

        ws.onclose = (event) => {
            const reason = event.reason || `code ${event.code}`;
            updateStatus(`Closed (${reason})`, 'disconnected');
            logStatusMessage(`WebSocket connection closed: ${reason}`);
            enableButtons(false);
            ws = null; // Clear reference

            // Schedule reconnect attempt if not already scheduled
            if (!reconnectInterval) {
                logStatusMessage('Attempting to reconnect in 5 seconds...');
                reconnectInterval = setInterval(() => {
                    console.log("Attempting reconnect...");
                    connectWebSocket();
                }, 5000); // Reconnect every 5 seconds
            }
        };
    }

    // --- UI Update Functions ---
    function updateStatus(text, className) {
        wsStatus.textContent = text;
        wsStatus.className = className;
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

    function enableButtons(enabled) {
        restartBtn.disabled = !enabled;
        upgradeBtn.disabled = !enabled;
    }

    // --- Logging Functions ---
    function logStatusMessage(message, isError = false) {
        const time = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.textContent = `[${time}] ${message}`;
        if (isError) {
            logEntry.style.color = '#cc0000';
            logEntry.style.fontWeight = 'bold';
        }
        statusLogOutput.appendChild(logEntry);
        // Auto-scroll
        statusLogOutput.scrollTop = statusLogOutput.scrollHeight;
    }

    function logContainerMessage(message, source = 'raw') {
        // Determine if the view is currently scrolled to the bottom
        const shouldScroll = logOutput.scrollHeight - logOutput.clientHeight <= logOutput.scrollTop + 5; // Add tolerance

        const logLine = document.createElement('span');
        logLine.classList.add('log-line', source);
        logLine.textContent = message; // Backend adds newline potentially, handle here if needed

        logOutput.appendChild(logLine);
        logOutput.appendChild(document.createTextNode('\n')); // Ensure newline in <pre>

        // Limit log lines DOM nodes for performance
        while (logOutput.childNodes.length > MAX_LOG_LINES * 2) { // *2 because of text nodes
            logOutput.removeChild(logOutput.firstChild);
        }

        // Auto-scroll if it was previously at the bottom
        if (shouldScroll) {
            logOutput.scrollTop = logOutput.scrollHeight;
        }
    }

    // --- Action Functions ---
    function sendAction(action) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            logStatusMessage(`Sending action: ${action}`);
            ws.send(JSON.stringify({ action: action }));
        } else {
            logStatusMessage('Cannot send action: WebSocket is not connected.', true);
        }
    }

    // --- Event Listeners ---
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

    clearLogsBtn.addEventListener('click', () => {
        logOutput.innerHTML = ''; // Clear the container log view
        logContainerMessage('[Logs Cleared by User]', 'status');
    });

    // --- Initial setup ---
    switchTab('info-stats-view'); // Start on the info/stats tab
    connectWebSocket(); // Initial connection attempt
});