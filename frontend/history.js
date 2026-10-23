// CPU / RAM history: main chart for the selected window + overview of the whole stored period
// with a two-handle range slider (drag handles to set start/end, drag the band to pan).
/* global Chart */

const SLIDER_STEPS = 1000;
const MIN_WINDOW_MS = 2 * 60 * 1000;       // smallest selectable window
const LIVE_REFRESH_MS = 10 * 1000;         // matches the server's sample interval
const GB = 1024 ** 3;

const $ = (id) => document.getElementById(id);
const els = {
    chart: $('history-chart'),
    overview: $('history-overview-chart'),
    slider: $('range-slider'),
    band: $('range-selection'),
    start: $('range-start'),
    end: $('range-end'),
    live: $('history-live'),
    label: $('history-range-label'),
    summary: $('history-summary'),
    presets: document.querySelectorAll('.history-presets button'),
};

const state = {
    domain: { min: Date.now() - 60 * 60 * 1000, max: Date.now() }, // whole stored period (overview)
    sel: { from: Date.now() - 60 * 60 * 1000, to: Date.now() },    // selected window (main chart)
    retentionMs: 7 * 24 * 60 * 60 * 1000,
};

let mainChart = null;
let overviewChart = null;
let fetchTimer = null;
let fetchSeq = 0;

// --- Helpers ---
const fmt = (ms) => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtGb = (bytes) => `${(bytes / GB).toFixed(2)} GB`;

function toSlider(ms) {
    const { min, max } = state.domain;
    return Math.round(((ms - min) / Math.max(1, max - min)) * SLIDER_STEPS);
}
function fromSlider(v) {
    const { min, max } = state.domain;
    return min + (Number(v) / SLIDER_STEPS) * (max - min);
}

async function fetchMetrics(from, to, points) {
    const params = new URLSearchParams({ from: Math.round(from), to: Math.round(to), points });
    const res = await fetch(`/api/metrics?${params}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) { window.location.reload(); throw new Error('session expired'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// --- Charts ---
function createCharts() {
    mainChart = new Chart(els.chart.getContext('2d'), {
        type: 'line',
        data: {
            datasets: [
                { label: 'CPU Ø (%)', data: [], yAxisID: 'cpu', borderColor: 'rgb(255, 99, 132)', backgroundColor: 'rgba(255, 99, 132, 0.15)', fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
                { label: 'CPU Peak (%)', data: [], yAxisID: 'cpu', borderColor: 'rgba(255, 99, 132, 0.45)', borderDash: [4, 3], borderWidth: 1, pointRadius: 0, tension: 0.2 },
                { label: 'RAM (GB)', data: [], yAxisID: 'mem', borderColor: 'rgb(26, 83, 92)', backgroundColor: 'rgba(78, 205, 196, 0.15)', fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            normalized: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { type: 'time', ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, time: { tooltipFormat: 'dd.MM. HH:mm:ss', displayFormats: { second: 'HH:mm:ss', minute: 'HH:mm', hour: 'dd.MM. HH:mm', day: 'dd.MM.' } } },
                cpu: { position: 'left', beginAtZero: true, suggestedMax: 100, title: { display: true, text: 'CPU %' } },
                mem: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'RAM GB' } },
            },
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
        },
    });

    overviewChart = new Chart(els.overview.getContext('2d'), {
        type: 'line',
        data: { datasets: [{ data: [], borderColor: 'rgba(255, 99, 132, 0.8)', backgroundColor: 'rgba(255, 99, 132, 0.12)', fill: true, borderWidth: 1, pointRadius: 0, tension: 0.2 }] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            events: [], // purely decorative, the slider on top handles input
            scales: {
                x: { type: 'time', ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 10 } }, time: { displayFormats: { minute: 'HH:mm', hour: 'dd.MM. HH:mm', day: 'dd.MM.' } } },
                y: { display: false, beginAtZero: true },
            },
            layout: { padding: 0 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
        },
    });
}

// --- Slider / selection rendering ---
function renderSelection() {
    els.start.value = toSlider(state.sel.from);
    els.end.value = toSlider(state.sel.to);
    const left = (els.start.value / SLIDER_STEPS) * 100;
    const right = (els.end.value / SLIDER_STEPS) * 100;
    els.band.style.left = `${left}%`;
    els.band.style.width = `${Math.max(0, right - left)}%`;
    // Overlapping handles at the right edge: the end handle can't move further right,
    // so put the start handle on top there (otherwise it could never be grabbed).
    els.start.style.zIndex = Number(els.start.value) > SLIDER_STEPS - 30 ? 3 : 1;
    els.label.textContent = `${fmt(state.sel.from)} – ${els.live.checked ? 'jetzt (live)' : fmt(state.sel.to)}`;
}

function clampSelection(from, to) {
    const { min, max } = state.domain;
    let f = Math.max(min, Math.min(from, max - MIN_WINDOW_MS));
    let t = Math.min(max, Math.max(to, f + MIN_WINDOW_MS));
    if (t - f < MIN_WINDOW_MS) f = Math.max(min, t - MIN_WINDOW_MS);
    return { from: f, to: t };
}

function setSelection(from, to, { live } = {}) {
    state.sel = clampSelection(from, to);
    if (live !== undefined) els.live.checked = live;
    renderSelection();
    scheduleMainFetch();
}

// --- Data loading ---
async function loadOverview() {
    const now = Date.now();
    const data = await fetchMetrics(now - state.retentionMs, now, 300);
    state.retentionMs = data.retentionMs || state.retentionMs;
    const firstSample = data.range?.min ?? now - 60 * 60 * 1000;
    // Domain = from the oldest stored sample (at least 10 min back) up to now
    state.domain = { min: Math.min(firstSample, now - 10 * 60 * 1000), max: now };
    overviewChart.data.datasets[0].data = data.points.map((p) => ({ x: p.t, y: p.cpu }));
    overviewChart.options.scales.x.min = state.domain.min;
    overviewChart.options.scales.x.max = state.domain.max;
    overviewChart.update('none');
}

function scheduleMainFetch(delay = 150) {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(loadMain, delay);
}

async function loadMain() {
    const seq = ++fetchSeq;
    const { from, to } = state.sel;
    let data;
    try {
        data = await fetchMetrics(from, to, 600);
    } catch (err) {
        els.summary.textContent = `Fehler beim Laden: ${err.message}`;
        return;
    }
    if (seq !== fetchSeq) return; // a newer request superseded this one

    const pts = data.points;
    mainChart.data.datasets[0].data = pts.map((p) => ({ x: p.t, y: p.cpu }));
    mainChart.data.datasets[1].data = pts.map((p) => ({ x: p.t, y: p.cpuMax }));
    mainChart.data.datasets[2].data = pts.map((p) => ({ x: p.t, y: p.mem / GB }));
    mainChart.options.scales.x.min = from;
    mainChart.options.scales.x.max = to;
    const limit = pts.reduce((m, p) => Math.max(m, p.memLimit || 0), 0);
    mainChart.options.scales.mem.suggestedMax = limit ? limit / GB : undefined;
    mainChart.update('none');

    if (!pts.length) {
        els.summary.textContent = 'Keine Daten im gewählten Zeitraum (Erfassung alle 10 s).';
        return;
    }
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const cpuAvg = avg(pts.map((p) => p.cpu));
    const cpuPeak = Math.max(...pts.map((p) => p.cpuMax));
    const memAvg = avg(pts.map((p) => p.mem));
    const memPeak = Math.max(...pts.map((p) => p.mem));
    els.summary.textContent = `CPU Ø ${cpuAvg.toFixed(1)} % · Peak ${cpuPeak.toFixed(1)} % | RAM Ø ${fmtGb(memAvg)} · Peak ${fmtGb(memPeak)}${limit ? ` / ${fmtGb(limit)}` : ''}`;
}

// --- Interaction ---
function onHandleInput(which) {
    let from = fromSlider(els.start.value);
    let to = fromSlider(els.end.value);
    const minGap = (MIN_WINDOW_MS / Math.max(1, state.domain.max - state.domain.min)) * SLIDER_STEPS;
    if (which === 'start' && Number(els.start.value) > Number(els.end.value) - minGap) from = to - MIN_WINDOW_MS;
    if (which === 'end' && Number(els.end.value) < Number(els.start.value) + minGap) to = from + MIN_WINDOW_MS;
    // Live = end handle dragged (almost) to the right edge
    const live = which === 'end' ? Number(els.end.value) >= SLIDER_STEPS - 2 : els.live.checked && to >= state.domain.max - 1000;
    setSelection(from, live ? state.domain.max : to, { live });
}

function enableBandDrag() {
    let dragStart = null;
    els.band.addEventListener('pointerdown', (e) => {
        dragStart = { x: e.clientX, from: state.sel.from, to: state.sel.to };
        els.band.setPointerCapture(e.pointerId);
        els.band.classList.add('dragging');
    });
    els.band.addEventListener('pointermove', (e) => {
        if (!dragStart) return;
        const width = els.slider.getBoundingClientRect().width || 1;
        const span = state.domain.max - state.domain.min;
        const winLen = dragStart.to - dragStart.from;
        let from = dragStart.from + ((e.clientX - dragStart.x) / width) * span;
        from = Math.max(state.domain.min, Math.min(from, state.domain.max - winLen));
        const to = from + winLen;
        setSelection(from, to, { live: to >= state.domain.max - 1000 });
    });
    const end = () => { dragStart = null; els.band.classList.remove('dragging'); };
    els.band.addEventListener('pointerup', end);
    els.band.addEventListener('pointercancel', end);
}

async function liveTick() {
    try {
        await loadOverview();
    } catch { return; }
    if (els.live.checked) {
        const winLen = state.sel.to - state.sel.from;
        setSelection(state.domain.max - winLen, state.domain.max);
    } else {
        renderSelection(); // domain grew: handles move slightly left
    }
}

async function init() {
    if (!els.chart || typeof Chart === 'undefined') return;
    createCharts();
    els.start.addEventListener('input', () => onHandleInput('start'));
    els.end.addEventListener('input', () => onHandleInput('end'));
    enableBandDrag();
    els.presets.forEach((btn) => btn.addEventListener('click', () => {
        const range = Number(btn.dataset.range);
        setSelection(state.domain.max - range, state.domain.max, { live: true });
    }));
    els.live.addEventListener('change', () => {
        if (els.live.checked) {
            const winLen = state.sel.to - state.sel.from;
            setSelection(state.domain.max - winLen, state.domain.max);
        } else {
            renderSelection();
        }
    });

    try {
        await loadOverview();
    } catch (err) {
        els.summary.textContent = `Fehler beim Laden: ${err.message}`;
    }
    setSelection(state.domain.max - 60 * 60 * 1000, state.domain.max, { live: true });
    setInterval(liveTick, LIVE_REFRESH_MS);
}

init();
