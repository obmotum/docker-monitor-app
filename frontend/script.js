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
    const statusLogOutput = document.getElementById('status-log-output');
    const clearLogsBtn = document.getElementById('clear-logs-btn');
    const userDisplayName = document.getElementById('user-display-name');
    const logoutBtn = document.getElementById('logout-btn');
    const appTitleElement = document.querySelector('.app-title');
    const cpuChartCanvas = document.getElementById('cpu-chart');

    // --- Chart State ---
    let cpuChartInstance = null; // Hält die Chart.js Instanz
    const chartLabels = [];      // Array für Zeitstempel (X-Achse)
    const chartCpuData = [];     // Array für CPU-Werte (Y-Achse)
    const CHART_TIME_WINDOW_MS = 5 * 60 * 1000; // 5 Minuten in Millisekunden

    // +++ ANSI Up Initialisierung +++
    const ansi_up = new AnsiUp();

    // --- WebSocket and State ---
    let ws = null;
    const MAX_LOG_LINES = 500;
    let reconnectInterval = null;
    let userInfo = { username: '...' }; // Placeholder for user info

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
        if (!cpuChartCanvas) return; // Canvas nicht gefunden

        // Zerstöre existierendes Chart, falls vorhanden (bei Reconnect)
        if (cpuChartInstance) {
            cpuChartInstance.destroy();
            cpuChartInstance = null;
            // Arrays leeren
            chartLabels.length = 0;
            chartCpuData.length = 0;
        }

        const ctx = cpuChartCanvas.getContext('2d');
        cpuChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: chartLabels, // Verbinde mit unserem Zeitstempel-Array
                datasets: [{
                    label: 'CPU Usage (%)',
                    data: chartCpuData, // Verbinde mit unserem CPU-Daten-Array
                    borderColor: 'rgb(255, 99, 132)', // Rote Linie
                    backgroundColor: 'rgba(255, 99, 132, 0.2)', // Leichte Füllung darunter
                    borderWidth: 1.5,
                    pointRadius: 0.5, // Kleine Punkte
                    tension: 0.1 // Leichte Kurvenglättung
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false, // Erlaube dem Chart, die Höhe anzupassen
                animation: {
                    duration: 0 // Keine (oder sehr kurze) Animation für Echtzeit-Gefühl
                },
                scales: {
                    x: {
                        type: 'time', // Zeitachse aktivieren
                        time: {
                            unit: 'second', // Zeige Sekunden
                            tooltipFormat: 'HH:mm:ss', // Format im Tooltip
                            displayFormats: {
                                second: 'HH:mm:ss' // Format auf der Achse
                            }
                        },
                        title: {
                            display: false // Titel nicht nötig, steht über dem Chart
                        },
                        ticks: {
                            maxRotation: 0, // Keine gedrehten Labels
                            autoSkip: true, // Labels überspringen, wenn zu dicht
                            maxTicksLimit: 10 // Begrenze Anzahl sichtbarer Ticks
                        }
                    },
                    y: {
                        beginAtZero: true, // Starte bei 0%
                        max: 105, // Gehe leicht über 100%, falls es Spitzen gibt
                        title: {
                            display: true,
                            text: '%'
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false // Legende nicht nötig bei nur einer Linie
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                interaction: { // Performance-Optimierung
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
            initCpuChart(); // Initialisiere das Chart bei Verbindung
            if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                switch (data.type) {
                    case 'app_config':
                        console.log("Received app config:", data.title);
                        // Aktualisiere den Browser-Tab-Titel
                        document.title = data.title;
                        // Aktualisiere den sichtbaren Titel im Header
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

                            // Entferne alte Datenpunkte (älter als 5 Minuten)
                            while (chartLabels.length > 0 && now - chartLabels[0] > CHART_TIME_WINDOW_MS) {
                                chartLabels.shift(); // Entferne ältesten Zeitstempel
                                chartCpuData.shift(); // Entferne ältesten CPU-Wert
                            }

                            // Aktualisiere das Chart (ohne Animation)
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

        // Konvertiere die Nachricht mit ANSI-Codes in HTML
        // Wichtig: escape_for_html sollte aktiviert sein (Standard), um XSS zu verhindern,
        // falls die Logs vom Container selbst HTML enthalten könnten.
        const htmlMessage = ansi_up.ansi_to_html(message);

        // Erstelle ein neues Element für die Zeile (span oder div)
        // Verwende span, da es sich eher wie eine Textzeile verhält
        const logLineElement = document.createElement('span');

        // Setze den *konvertierten HTML-Inhalt*
        logLineElement.innerHTML = htmlMessage;

        // Füge optional eine Klasse für die Quelle hinzu (obwohl Farben jetzt von ansi_up kommen)
        // logLineElement.classList.add('log-line', source); // Kann man entfernen, wenn man keine Extra-Styles braucht

        logOutput.appendChild(logLineElement);
        logOutput.appendChild(document.createTextNode('\n')); // Sorge für Zeilenumbruch im <pre>

        // Limit log lines DOM nodes for performance
        // Multipliziere mit 2, da wir jetzt ein Element + TextNode pro Zeile hinzufügen
        while (logOutput.childNodes.length > MAX_LOG_LINES * 2) {
            logOutput.removeChild(logOutput.firstChild);
        }

        // Auto-scroll if it was previously at the bottom
        if (shouldScroll) {
            logOutput.scrollTop = logOutput.scrollHeight;
        }
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
    clearLogsBtn.addEventListener('click', () => { logOutput.innerHTML = ''; logContainerMessage('[Logs Cleared by User]', 'status'); });

    // --- Initial setup ---
    switchTab('info-stats-view');
    connectWebSocket();
});