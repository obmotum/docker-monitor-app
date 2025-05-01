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
    const logOutput = document.getElementById('log-output');
    const logSearchInput = document.getElementById('log-search-input'); // Add reference for search input
    const statusLogOutput = document.getElementById('status-log-output');
    const clearLogsBtn = document.getElementById('clear-logs-btn');
    const userDisplayName = document.getElementById('user-display-name');
    const logoutBtn = document.getElementById('logout-btn');
    const appTitleElement = document.querySelector('.app-title');
    const cpuChartCanvas = document.getElementById('cpu-chart');

    // --- Chart State ---
    let cpuChartInstance = null; // Holds the Chart.js instance
    const chartLabels = [];      // Array for timestamps (X-axis)
    const chartCpuData = [];     // Array for CPU values (Y-axis)
    const CHART_TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

    // +++ ANSI Up Initialization +++
    const ansi_up = new AnsiUp();

    // --- WebSocket and State ---
    let ws = null;
    const MAX_LOG_LINES = 500;
    let reconnectInterval = null;
    let userInfo = { username: '...' }; // Placeholder for user info
    let currentLogSearchTerm = ''; // Variable to store the current search term

    // --- Tab Switching Logic ---
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetId = button.getAttribute('data-target');
            switchTab(targetId);
        });
    });

    function switchTab(targetId) {
        tabButtons.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-target') === targetId));
        views.forEach(view => view.classList.toggle('active', view.id === targetId));
    }

    // --- Chart Initialization Function ---
    function initCpuChart() {
        if (!cpuChartCanvas) return; // Canvas not found

        // Destroy existing chart if present (on reconnect)
        if (cpuChartInstance) {
            cpuChartInstance.destroy();
            cpuChartInstance = null;
            // Clear arrays
            chartLabels.length = 0;
            chartCpuData.length = 0;
        }

        const ctx = cpuChartCanvas.getContext('2d');
        cpuChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: chartLabels, // Link to our timestamp array
                datasets: [{
                    label: 'CPU Usage (%)',
                    data: chartCpuData, // Link to our CPU data array
                    borderColor: 'rgb(255, 99, 132)', // Red line
                    backgroundColor: 'rgba(255, 99, 132, 0.2)', // Light fill below
                    borderWidth: 1.5,
                    pointRadius: 0.5, // Small points
                    tension: 0.1 // Slight curve smoothing
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false, // Allow chart to adjust height
                animation: {
                    duration: 0 // No (or very short) animation for real-time feel
                },
                scales: {
                    x: {
                        type: 'time', // Enable time axis
                        time: {
                            unit: 'second', // Show seconds
                            tooltipFormat: 'HH:mm:ss', // Format in tooltip
                            displayFormats: {
                                second: 'HH:mm:ss' // Format on axis
                            }
                        },
                        title: {
                            display: false // No title needed, it's above the chart
                        },
                        ticks: {
                            maxRotation: 0, // No rotated labels
                            autoSkip: true, // Skip labels if too dense
                            maxTicksLimit: 10 // Limit number of visible ticks
                        }
                    },
                    y: {
                        beginAtZero: true, // Start at 0%
                        max: 105, // Go slightly above 100% for spikes
                        title: {
                            display: true,
                            text: '%'
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false // No legend needed for single line
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                interaction: { // Performance optimization
                    mode: 'nearest',
                    axis: 'x',
                    intersect: false
                }
            }
        });
        console.log("CPU Chart initialized.");
    }

    // --- WebSocket Connection Logic ---
    function connectWebSocket() {
        if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) { return; }

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}`;
        ws = new WebSocket(wsUrl);

        updateStatus('Connecting...', 'connecting');
        logStatusMessage('Attempting to connect to WebSocket...');

        ws.onopen = () => {
            updateStatus('Connected', 'connected');
            logStatusMessage('WebSocket connection established.');
            enableButtons(true);
            initCpuChart(); // Initialize the chart on connection
            if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                switch (data.type) {
                    case 'app_config':
                        console.log("Received app config:", data.title);
                        // Update the browser tab title
                        document.title = data.title;
                        // Update the visible title in the header
                        if (appTitleElement) {
                            appTitleElement.textContent = data.title;
                        }
                        break;
                    case 'stats':
                        updateStats(data);

                        const now = Date.now();
                        const cpuValue = parseFloat(data.cpuPercent);

                        if (!isNaN(cpuValue) && cpuChartInstance) {
                            chartLabels.push(now);
                            chartCpuData.push(cpuValue);

                            // Remove old data points (older than 5 minutes)
                            while (chartLabels.length > 0 && now - chartLabels[0] > CHART_TIME_WINDOW_MS) {
                                chartLabels.shift(); // Remove oldest timestamp
                                chartCpuData.shift(); // Remove oldest CPU value
                            }

                            // Update the chart (without animation)
                            cpuChartInstance.update('none');
                        }

                        break;
                    case 'container_info': // Renamed type
                        updateInfo(data);
                        break;
                    case 'user_info': // Handle new user info type
                        userInfo.username = data.username || 'anonymous';
                        userDisplayName.textContent = userInfo.username; // Update header
                        console.log("Received user info:", userInfo.username);
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
            } catch (e) { logStatusMessage(`Error parsing message: ${e}`, true); console.error("Error parsing message data: ", event.data); }
        };

        ws.onerror = (error) => {
             logStatusMessage('WebSocket Error occurred.', true);
             console.error('WebSocket Error Event: ', error);
        };

        ws.onclose = (event) => {
            const reason = event.reason || `code ${event.code}`;
            updateStatus(`Closed (${reason})`, 'disconnected');
            logStatusMessage(`WebSocket connection closed: ${reason}`);
            enableButtons(false);
            userDisplayName.textContent = '...'; // Reset username on disconnect
            ws = null;
            logStatusMessage("Chart updates paused due to disconnect.");
            if (!reconnectInterval) {
                logStatusMessage('Attempting to reconnect in 5 seconds...');
                reconnectInterval = setInterval(() => { console.log("Attempting reconnect..."); connectWebSocket(); }, 5000);
            }
        };
    }

    // --- UI Update Functions ---
    function updateStatus(text, className) { wsStatus.textContent = text; wsStatus.className = className; }
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
    function enableButtons(enabled) { restartBtn.disabled = !enabled; upgradeBtn.disabled = !enabled; }

    // --- Logging Functions ---
    function logStatusMessage(message, isError = false) {
        const time = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.textContent = `[${time}] ${message}`;
        if (isError) { logEntry.style.color = '#cc0000'; logEntry.style.fontWeight = 'bold'; }
        statusLogOutput.appendChild(logEntry);
        statusLogOutput.scrollTop = statusLogOutput.scrollHeight;
    }
    // Logs messages to the Container Logs area (<pre>), converting ANSI codes
    function logContainerMessage(message, source = 'raw') {
        const shouldScroll = logOutput.scrollHeight - logOutput.clientHeight <= logOutput.scrollTop + 5;

        // Convert the message with ANSI codes to HTML
        // Important: escape_for_html should be enabled (default) to prevent XSS
        // in case the logs from the container contain HTML themselves.
        const htmlMessage = ansi_up.ansi_to_html(message);

        // Create a new element for the line (span or div)
        // Use span, as it behaves more like a text line
        const logLineElement = document.createElement('span');

        // Set the *converted HTML content*
        logLineElement.innerHTML = htmlMessage;

        // Optionally add a class for the source (though colors now come from ansi_up)
        // logLineElement.classList.add('log-line', source); // Can be removed if no extra styles needed

        logOutput.appendChild(logLineElement);
        logOutput.appendChild(document.createTextNode('\n')); // Ensure line break in <pre>

        // Limit log lines DOM nodes for performance
        // Multiply by 2, since we now add an element + TextNode per line
        while (logOutput.childNodes.length > MAX_LOG_LINES * 2) {
            logOutput.removeChild(logOutput.firstChild);
        }

        // Auto-scroll if it was previously at the bottom
        if (shouldScroll) {
            logOutput.scrollTop = logOutput.scrollHeight;
        }
    }

    // --- Log Filtering Logic ---
    function filterLogs() {
        currentLogSearchTerm = logSearchInput.value.toLowerCase();
        const logLines = logOutput.querySelectorAll('span'); // Get all log line elements

        logLines.forEach(line => {
            const lineText = line.textContent.toLowerCase(); // Use textContent for filtering existing lines
            if (currentLogSearchTerm && !lineText.includes(currentLogSearchTerm)) {
                line.style.display = 'none'; // Hide if it doesn't match
            } else {
                line.style.display = ''; // Show if it matches or if search is empty
            }
        });

        // Scroll to bottom after filtering if the user was already there
        // (Optional, might be slightly annoying if user was scrolled up intentionally)
        // logOutput.scrollTop = logOutput.scrollHeight;
    }

    // --- Action Functions ---
    function sendAction(action) {
        if (ws && ws.readyState === WebSocket.OPEN) { logStatusMessage(`Sending action: ${action}`); ws.send(JSON.stringify({ action: action })); }
        else { logStatusMessage('Cannot send action: WebSocket is not connected.', true); }
    }

    // --- Logout Functionality (using POST to /api/logout) ---
    logoutBtn.addEventListener('click', () => {
        // ** IMPORTANT: Verify this is the correct public URL for your Authelia instance **
        const autheliaLogoutUrl = `https://auth.trkulja.it/api/logout`;

        // Define where to redirect *after* the POST request is successful
        const redirectUrlAfterLogout = window.location.href; // Back to the monitor app

        logStatusMessage("Sending logout request...");

        // Send a POST request using fetch
        fetch(autheliaLogoutUrl, {
            method: 'POST',
            // Body is usually not needed for logout
            // Headers might not be needed if the browser sends cookies automatically
            // based on the domain settings. Ensure 'credentials: "include"' if needed,
            // but often the browser handles cookies correctly for the target domain.
            credentials: 'include' // Ensures cookies are sent even for cross-origin if allowed
        })
        .then(response => {
            if (response.ok) {
                // Status 200 OK - Logout likely successful server-side
                logStatusMessage("Logout successful on server. Reloading page...");
                 // Manually redirect or reload the page. Reloading often triggers
                 // the login flow again because the cookie should now be invalid/gone.
                 // Option 1: Simple Reload
                 window.location.reload();

                 // Option 2: Redirect explicitly (safer if reload causes issues)
                 // window.location.href = redirectUrlAfterLogout;
            } else {
                // Logout failed server-side (e.g., 401 if cookie was already invalid)
                logStatusMessage(`Logout request failed: ${response.status} ${response.statusText}`, true);
                // Still try reloading, maybe the cookie is invalid anyway
                setTimeout(() => { window.location.reload(); }, 1000);
            }
        })
        .catch(error => {
            logStatusMessage(`Logout network error: ${error}`, true);
            console.error('Logout fetch error:', error);
            // Optionally try reloading even on network error
             setTimeout(() => { window.location.reload(); }, 1000);
        });
    });
    
    // --- Event Listeners ---
    restartBtn.addEventListener('click', () => { if (confirm('Are you sure you want to restart the container?')) sendAction('restart'); });
    upgradeBtn.addEventListener('click', () => { if (confirm('Are you sure you want to attempt an upgrade?')) sendAction('upgrade'); });
    clearLogsBtn.addEventListener('click', () => {
        logOutput.innerHTML = '';
        logContainerMessage('[Logs Cleared by User]', 'status');
        // Re-apply filter in case search term exists but logs were cleared
        filterLogs();
    });
    logSearchInput.addEventListener('input', filterLogs); // Add event listener for search input

    // --- Initial setup ---
    switchTab('info-stats-view');
    connectWebSocket();
});