import { AnsiUp } from './vendor/ansi_up.js';

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
    const joinCodeRow = document.getElementById('join-code-row');
    const joinCode = document.getElementById('join-code');
    const joinAddress = document.getElementById('join-address');
    const copyJoinCodeBtn = document.getElementById('copy-join-code-btn');
    const restartBtn = document.getElementById('restart-btn');
    const tabButtons = document.querySelectorAll('.tab-button');
    const views = document.querySelectorAll('.view');
    const logOutput = document.getElementById('log-output');
    const statusLogOutput = document.getElementById('status-log-output');
    const logTailSelect = document.getElementById('log-tail-select');
    const userDisplayName = document.getElementById('user-display-name');
    const appTitleElement = document.querySelector('.app-title');
    // +++ ANSI Up Initialisierung +++
    const ansi_up = new AnsiUp();
    ansi_up.use_classes = true; // Basic colours as CSS classes instead of inline styles (CSP)

    // --- WebSocket and State ---
    let ws = null;
    let maxLogLines = 500; // raised to the selected history size on 'log_reset'

    // Remember the chosen log history per browser (convenience only; falls back to 100).
    const LOG_TAIL_KEY = 'vhmon.logTail';
    try {
        const saved = localStorage.getItem(LOG_TAIL_KEY);
        if (saved && [...logTailSelect.options].some(o => o.value === saved)) logTailSelect.value = saved;
    } catch { /* storage unavailable */ }
    let reconnectInterval = null;
    let userInfo = { username: '...' }; // Placeholder for user info

    // --- Tab Switching Logic ---
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetId = button.getAttribute('data-target');
            switchTab(targetId);
        });
    });

    // --- Log auto-scroll ---
    // Follow the newest line unless the user scrolled up to read; "↓ Neueste" jumps back and resumes.
    const jumpLatestBtn = document.getElementById('jump-latest-btn');
    let followLogs = true;
    let scrollPending = false;
    function scrollLogsToBottom() {
        if (scrollPending) return;
        scrollPending = true;
        requestAnimationFrame(() => { // one scroll per frame, even for bursts of lines
            scrollPending = false;
            if (followLogs) logOutput.scrollTop = logOutput.scrollHeight;
        });
    }
    logOutput.addEventListener('scroll', () => {
        if (!logOutput.clientHeight) return; // hidden tab
        followLogs = logOutput.scrollHeight - logOutput.clientHeight - logOutput.scrollTop <= 10;
        jumpLatestBtn.hidden = followLogs;
    });
    jumpLatestBtn.addEventListener('click', () => {
        followLogs = true;
        jumpLatestBtn.hidden = true;
        scrollLogsToBottom();
    });

    function switchTab(targetId) {
        tabButtons.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-target') === targetId));
        views.forEach(view => view.classList.toggle('active', view.id === targetId));
        if (targetId === 'logs-view') scrollLogsToBottom(); // layout exists only once the tab is visible
    }

    // --- WebSocket Connection Logic ---
    function connectWebSocket() {
        if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) { return; }

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}/?logs=${encodeURIComponent(logTailSelect.value)}`;
        ws = new WebSocket(wsUrl);

        updateStatus('Connecting...', 'connecting');
        logStatusMessage('Attempting to connect to WebSocket...');

        ws.onopen = () => {
            updateStatus('Connected', 'connected');
            logStatusMessage('WebSocket connection established.');
            enableButtons(true);
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

                        break;
                    case 'container_info': // Renamed type
                        updateInfo(data);
                        break;
                    case 'join_info':
                        updateJoinInfo(data);
                        break;
                    case 'user_info': // Handle new user info type
                        userInfo.username = data.username || 'anonymous';
                        userDisplayName.textContent = userInfo.username; // Update header
                        console.log("Received user info:", userInfo.username);
                        break;
                    case 'log':
                        logContainerMessage(data.line, data.source);
                        break;
                    case 'log_reset': // server (re)starts the log stream with the chosen history
                        maxLogLines = Math.max(500, Number(data.limit) || 500);
                        logOutput.innerHTML = '';
                        followLogs = true;
                        jumpLatestBtn.hidden = true;
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
            // 4001 = session expired on the server; otherwise check whether we are still logged in.
            if (event.code === 4001) { window.location.reload(); return; }
            checkSession().then((loggedIn) => {
                if (!loggedIn) { window.location.reload(); return; } // Reload -> server redirects to the Keycloak login
                if (!reconnectInterval) {
                    logStatusMessage('Attempting to reconnect in 5 seconds...');
                    reconnectInterval = setInterval(() => { console.log("Attempting reconnect..."); connectWebSocket(); }, 5000);
                }
            });
        };
    }

    // Returns false only if the server explicitly says the session is gone (401/403); network errors count as logged in.
    async function checkSession() {
        try {
            const res = await fetch('/api/me', { headers: { Accept: 'application/json' }, cache: 'no-store' });
            return !(res.status === 401 || res.status === 403);
        } catch {
            return true;
        }
    }

    // --- UI Update Functions ---
    function updateStatus(text, className) { wsStatus.textContent = text; wsStatus.className = className; }
    function updateInfo(data) {
        containerName.textContent = data.containerName || 'N/A';
        containerId.textContent = data.containerId || 'N/A';
        containerImage.textContent = data.image || 'N/A';
        containerStatus.textContent = data.status || 'N/A';
    }
    function updateJoinInfo(data) {
        joinCodeRow.hidden = !data.code;
        joinCode.textContent = data.code || '-';
        joinAddress.textContent = data.address ? `(${data.address})` : '';
    }
    function updateStats(data) {
        cpuUsage.textContent = data.cpuPercent || '--';
        memUsage.textContent = data.memUsage || '--';
        memLimit.textContent = data.memLimit || '--';
        memPercent.textContent = data.memPercent || '--';
        netIo.textContent = `${data.netRx || '--'} Rx / ${data.netTx || '--'} Tx`;
        diskIo.textContent = `${data.diskRead || '--'} Read / ${data.diskWrite || '--'} Write`;
    }
    function enableButtons(enabled) { restartBtn.disabled = !enabled; }

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
        // Konvertiere die Nachricht mit ANSI-Codes in HTML
        // Wichtig: escape_for_html sollte aktiviert sein (Standard), um XSS zu verhindern,
        // falls die Logs vom Container selbst HTML enthalten könnten.
        // supervisord/syslog (e.g. lloesche/valheim-server) prints ESC in caret notation ("^[[0m");
        // turn it back into a real ESC so ansi_up recognises the colour codes.
        const text = message.replace(/\^\[\[/g, '\x1b[');
        let htmlMessage = ansi_up.ansi_to_html(text);

        // Light highlighting for lines without own colours (Valheim/SteamCMD only emit resets).
        const hasOwnColours = /\x1b\[[0-9;]*[1-9][0-9;]*m/.test(text);
        if (!hasOwnColours) {
            // Dim the "Oct 23 13:00:12 supervisord: valheim-server" / "10/23/2026 13:00:12:" prefixes
            htmlMessage = htmlMessage.replace(/^(\w{3} +\d+ [\d:]+ supervisord: [\w-]+)/, '<span class="log-prefix">$1</span>');
            htmlMessage = htmlMessage.replace(/(\d{2}\/\d{2}\/\d{4} [\d:]+:)/, '<span class="log-prefix">$1</span>');
        }
        let lineClass = '';
        // PlayFab/crossplay join code lines get their own highlight (same patterns as the backend parser)
        const joinCodeMatch = /(?:registered with|with) join code (\d+)/.exec(text);
        if (joinCodeMatch) {
            lineClass = 'log-joincode';
            htmlMessage = htmlMessage.replace(`join code ${joinCodeMatch[1]}`, `join code <span class="log-joincode-value">${joinCodeMatch[1]}</span>`);
        } else if (!hasOwnColours) {
            if (source === 'stderr' || /\b(error|exception|failed|fatal)\b/i.test(text)) lineClass = 'log-error';
            else if (/\bwarn(ing)?\b/i.test(text)) lineClass = 'log-warn';
            else if (/\b(success|connected)\b/i.test(text)) lineClass = 'log-ok';
        }

        // Erstelle ein neues Element für die Zeile (span oder div)
        // Verwende span, da es sich eher wie eine Textzeile verhält
        const logLineElement = document.createElement('span');
        if (lineClass) logLineElement.className = lineClass;

        // Setze den *konvertierten HTML-Inhalt*
        logLineElement.innerHTML = htmlMessage;

        // Füge optional eine Klasse für die Quelle hinzu (obwohl Farben jetzt von ansi_up kommen)
        // logLineElement.classList.add('log-line', source); // Kann man entfernen, wenn man keine Extra-Styles braucht

        logOutput.appendChild(logLineElement);
        logOutput.appendChild(document.createTextNode('\n')); // Sorge für Zeilenumbruch im <pre>

        // Limit log lines DOM nodes for performance
        // Multipliziere mit 2, da wir jetzt ein Element + TextNode pro Zeile hinzufügen
        while (logOutput.childNodes.length > maxLogLines * 2) {
            logOutput.removeChild(logOutput.firstChild);
        }

        // Auto-scroll if it was previously at the bottom
        if (followLogs) scrollLogsToBottom();
    }

    // --- Action Functions ---
    function sendAction(action, payload = {}) {
        if (ws && ws.readyState === WebSocket.OPEN) { logStatusMessage(`Sending action: ${action}`); ws.send(JSON.stringify({ action, ...payload })); }
        else { logStatusMessage('Cannot send action: WebSocket is not connected.', true); }
    }

    // Logout is a plain form POST to /auth/logout (see index.html), which also ends the Keycloak session.

    // --- Event Listeners ---
    restartBtn.addEventListener('click', () => { if (confirm('Are you sure you want to restart the container?')) sendAction('restart'); });
    logTailSelect.addEventListener('change', () => {
        try { localStorage.setItem(LOG_TAIL_KEY, logTailSelect.value); } catch { /* storage unavailable */ }
        sendAction('set_log_tail', { tail: logTailSelect.value });
    });
    copyJoinCodeBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(joinCode.textContent);
            copyJoinCodeBtn.textContent = 'Copied!';
        } catch {
            copyJoinCodeBtn.textContent = 'Copy failed';
        }
        setTimeout(() => { copyJoinCodeBtn.textContent = 'Copy'; }, 1500);
    });

    // --- Initial setup ---
    switchTab('info-stats-view');
    connectWebSocket();
});