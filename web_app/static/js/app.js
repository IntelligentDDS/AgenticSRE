/* ═════════════════════════════════════════════
   AgenticSRE Dashboard — Main SPA Logic
   ═════════════════════════════════════════════ */

// ── State ──
const state = {
    currentView: 'overview',
    refreshTimer: null,
    refreshInterval: 0,
    sseConnections: {},
    rcaRunId: null,
    daemonLogSSE: null,
    detectionSSE: null,
    podChart: null,
    runtime: {
        offlineMode: false,
        observabilityBackend: 'native',
        offlineProblemId: '',
        offlineDataType: '',
    },
};

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
    initNavigation();
    initOfflineProblemSwitcher();
    initRefresh();
    await healthCheck();
    loadOverview();
    setInterval(healthCheck, 30000);
});

// ─────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────

function initNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            switchView(view);
        });
    });

    document.getElementById('toggle-sidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('collapsed');
    });
}

function initOfflineProblemSwitcher() {
    const select = document.getElementById('offline-problem-select');
    if (!select) return;
    select.addEventListener('change', switchOfflineProblem);
}

function switchView(viewId) {
    if (isOfflineMode() && viewId === 'events') {
        viewId = 'overview';
    }

    // Update nav
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-view="${viewId}"]`)?.classList.add('active');

    // Update content
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.getElementById(`view-${viewId}`)?.classList.add('active');

    // Update title
    document.getElementById('view-title').textContent = getViewTitle(viewId);

    state.currentView = viewId;
    refreshCurrentView();
}

function getViewTitle(viewId) {
    const titles = isOfflineMode() ? {
        overview: '离线概览', metrics: '离线指标',
        logs: '离线日志', alerts: '告警中心', rca: '根因分析',
        traces: '离线链路', daemon: '守护进程',
        alidata: 'AliData (阿里云)', events: '事件追踪'
    } : {
        overview: '集群概览', metrics: '指标监控', logs: '日志查询',
        alerts: '告警中心', rca: '根因分析', traces: '链路追踪',
        daemon: '守护进程', alidata: 'AliData (阿里云)', events: '事件追踪'
    };
    return titles[viewId] || viewId;
}

function refreshCurrentView() {
    const loaders = {
        overview: loadOverview,
        metrics: loadMetrics,
        logs: loadLogsView,
        alerts: () => { loadAlertList(); loadDetectionConfig(); },
        rca: loadRCAHistory,
        traces: loadTracesView,
        daemon: loadDaemonStatus,
        alidata: loadAliDataView,
        events: () => { Promise.all([loadNamespaces('event-ns'), loadEvents()]); },
    };
    (loaders[state.currentView] || (() => {}))();
}

// ── Auto-Refresh ──

function initRefresh() {
    const refreshSelect = document.getElementById('refresh-interval');
    state.refreshInterval = parseInt(refreshSelect?.value || '0', 10);

    refreshSelect.addEventListener('change', (e) => {
        state.refreshInterval = parseInt(e.target.value, 10);
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
        if (state.refreshInterval > 0) {
            state.refreshTimer = setInterval(refreshCurrentView, state.refreshInterval * 1000);
        }
    });

    if (state.refreshInterval > 0) {
        state.refreshTimer = setInterval(refreshCurrentView, state.refreshInterval * 1000);
    }
}

// ─────────────────────────────────────────
// API Helpers
// ─────────────────────────────────────────

async function api(path, options = {}) {
    try {
        const res = await fetch(path, options);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.error(`API error [${path}]:`, e);
        return null;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(ts) {
    if (!ts) return '-';
    try {
        return new Date(ts).toLocaleString('zh-CN');
    } catch { return ts; }
}

function badgeClass(phase) {
    const map = { Running: 'success', Succeeded: 'success', Pending: 'warning', Failed: 'danger', Unknown: 'gray' };
    return map[phase] || 'gray';
}

function isOfflineMode() {
    return !!state.runtime.offlineMode;
}

function normalizeOfflineProblemId(value) {
    const raw = String(value || '').trim();
    return raw.startsWith('problem_') ? raw.slice('problem_'.length) : raw;
}

function currentOfflineDataType() {
    const val = state.runtime.offlineDataType || 'failure';
    return val === 'auto' ? 'failure' : val;
}

function currentOfflineLabel() {
    if (!isOfflineMode()) return '';
    const pid = state.runtime.offlineProblemId || '?';
    return `problem_${pid}/${currentOfflineDataType()}`;
}

async function syncOfflineProblemSwitcher(forceReload = false) {
    const wrapper = document.getElementById('offline-problem-switcher');
    const select = document.getElementById('offline-problem-select');
    if (!wrapper || !select) return;

    if (!isOfflineMode()) {
        wrapper.style.display = 'none';
        select.dataset.loaded = '';
        select.innerHTML = '<option value="">离线模式未开启</option>';
        return;
    }

    wrapper.style.display = 'inline-flex';

    if (forceReload || select.dataset.loaded !== 'true') {
        await loadOfflineProblemOptions();
        return;
    }

    if (state.runtime.offlineProblemId) {
        select.value = state.runtime.offlineProblemId;
    }
}

async function loadOfflineProblemOptions() {
    const select = document.getElementById('offline-problem-select');
    if (!select) return;

    const previousValue = state.runtime.offlineProblemId || select.value || '';
    const data = await api('/api/offline/problems');
    const problems = data?.problems || [];

    if (!problems.length) {
        const currentValue = normalizeOfflineProblemId(data?.current_problem_id || previousValue);
        const label = currentValue ? `problem_${currentValue}` : '无可用数据';
        select.innerHTML = `<option value="${currentValue}">${label}</option>`;
        select.value = currentValue;
        select.disabled = !currentValue;
        select.dataset.loaded = 'true';
        select.title = data?.error || '未发现可用的离线 problem 数据集';
        return;
    }

    select.innerHTML = problems.map(problem => {
        const flags = [
            problem.has_failure ? 'F' : '',
            problem.has_baseline ? 'B' : '',
        ].filter(Boolean).join('/');
        const suffix = flags ? ` (${flags})` : '';
        return `<option value="${problem.problem_id}">${problem.label}${suffix}</option>`;
    }).join('');

    const nextValue = normalizeOfflineProblemId(data?.current_problem_id || previousValue || problems[0]?.problem_id);
    select.value = nextValue;
    select.disabled = false;
    select.dataset.loaded = 'true';
    select.title = data?.error || '切换当前离线 problem 数据集';
}

async function switchOfflineProblem(event) {
    const select = event?.target || document.getElementById('offline-problem-select');
    if (!select) return;

    const nextProblemId = normalizeOfflineProblemId(select.value);
    const currentProblemId = normalizeOfflineProblemId(state.runtime.offlineProblemId);
    if (!nextProblemId || nextProblemId === currentProblemId) {
        select.value = currentProblemId;
        return;
    }

    const previousValue = currentProblemId;
    select.disabled = true;

    try {
        const res = await fetch('/api/offline/problem', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offline_problem_id: nextProblemId }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(payload?.detail || `HTTP ${res.status}`);
        }

        state.runtime.offlineProblemId = normalizeOfflineProblemId(payload.offline_problem_id || nextProblemId);
        state.runtime.offlineDataType = payload.offline_data_type || state.runtime.offlineDataType;
        await syncOfflineProblemSwitcher(true);
        await healthCheck();
        refreshCurrentView();
    } catch (error) {
        console.error('Failed to switch offline dataset:', error);
        select.value = previousValue;
        window.alert(`切换离线数据失败：${error.message}`);
    } finally {
        select.disabled = false;
    }
}

function _safeNumber(val, fallback = 0) {
    const num = Number(val);
    return Number.isFinite(num) ? num : fallback;
}

function _truncate(text, maxLen = 14) {
    const str = String(text || '');
    return str.length > maxLen ? str.substring(0, maxLen - 2) + '..' : str;
}

function currentMetricValue(metrics, keys) {
    for (const key of keys) {
        const value = metrics?.[key]?.current;
        if (value != null) return _safeNumber(value);
    }
    return 0;
}

const OFFLINE_POD_KPI_PRIORITY = [
    'pod_cpu_usage_rate',
    'pod_cpu_usage_rate_vs_request',
    'pod_cpu_usage_rate_vs_limit',
    'pod_memory_usage_bytes',
    'pod_memory_working_set_bytes',
    'pod_memory_usage_vs_request',
    'pod_memory_usage_vs_limit',
];

function orderOfflinePodKpis(kpis) {
    const pending = new Set(kpis);
    const ordered = [];

    OFFLINE_POD_KPI_PRIORITY.forEach(kpi => {
        if (pending.has(kpi)) {
            ordered.push(kpi);
            pending.delete(kpi);
        }
    });

    return ordered.concat([...pending].sort());
}

function setPodTableHeadings(headings) {
    const thead = document.querySelector('#pod-table thead');
    if (!thead) return;
    thead.innerHTML = `<tr>${headings.map(heading => `<th>${escapeHtml(heading)}</th>`).join('')}</tr>`;
}

function setPodTableLayoutMode(offlineSummary) {
    const card = document.getElementById('pod-summary-card');
    const table = document.getElementById('pod-table');
    const title = document.getElementById('metrics-title-6');
    if (!card || !table || !title) return;

    card.classList.toggle('offline-pod-summary-card', offlineSummary);
    table.classList.toggle('pod-summary-table', offlineSummary);
    title.classList.toggle('offline-summary-title', offlineSummary);
}

function offlineKpiDisplayUnit(metricName) {
    if (metricName.includes('memory') && metricName.includes('bytes')) return 'MB';
    if (metricName.includes('latency')) return 'ms';
    if (metricName.includes('cpu') || metricName.endsWith('_vs_limit') || metricName.endsWith('_vs_request')) return '%';
    return '';
}

function formatOfflineKpiHeading(metricName) {
    const unit = offlineKpiDisplayUnit(metricName);
    return unit ? `${metricName} (${unit})` : metricName;
}

function formatOfflineKpiValue(metricName, value) {
    if (value == null || !Number.isFinite(value)) return '-';

    if (metricName.includes('memory') && metricName.includes('bytes')) {
        return (value / (1024 * 1024)).toFixed(1);
    }
    if (metricName.includes('latency')) {
        return (value * 1000).toFixed(1);
    }
    if (metricName.includes('cpu') || metricName.endsWith('_vs_limit') || metricName.endsWith('_vs_request')) {
        return value.toFixed(1);
    }
    return value.toFixed(2);
}

function collectOfflinePodKpis(pods) {
    const kpis = new Set();
    (pods || []).forEach(pod => {
        Object.keys(pod.metrics || {}).forEach(metricName => kpis.add(metricName));
    });
    return orderOfflinePodKpis(kpis);
}

function renderOfflinePodSummaryTable(pods) {
    const tbody = document.querySelector('#pod-table tbody');
    if (!tbody) return;

    const kpis = collectOfflinePodKpis(pods);
    setPodTableHeadings(['Pod', '服务', ...kpis.map(formatOfflineKpiHeading)]);

    if (!pods.length) {
        tbody.innerHTML = `<tr><td colspan="${Math.max(2 + kpis.length, 2)}" class="text-muted" style="text-align:center">暂无离线 Pod 数据</td></tr>`;
        return;
    }

    const sortValue = pod => {
        if (Number.isFinite(pod.cpu) && pod.cpu > 0) return pod.cpu;
        if (Number.isFinite(pod.memRatio) && pod.memRatio > 0) return pod.memRatio;
        for (const kpi of kpis) {
            const value = pod.metrics?.[kpi];
            if (Number.isFinite(value)) return value;
        }
        return 0;
    };

    tbody.innerHTML = [...pods].sort((a, b) => sortValue(b) - sortValue(a)).map(pod => `
        <tr>
            <td><span class="pod-summary-sticky-label" title="${escapeHtml(pod.pod)}">${escapeHtml(pod.pod)}</span></td>
            <td><span class="pod-summary-sticky-label" title="${escapeHtml(pod.service)}">${escapeHtml(pod.service)}</span></td>
            ${kpis.map(metricName => {
                const rawValue = pod.metrics?.[metricName];
                const formatted = formatOfflineKpiValue(metricName, rawValue);
                return `<td class="metric-cell">${formatted === '-' ? '<span class="text-muted">-</span>' : escapeHtml(formatted)}</td>`;
            }).join('')}
        </tr>
    `).join('');
}

function getOfflineK8sPods(k8s) {
    const pods = [];
    for (const [service, podMap] of Object.entries(k8s || {})) {
        for (const [pod, metrics] of Object.entries(podMap || {})) {
            const metricSnapshot = {};
            for (const [metricName, metricSeries] of Object.entries(metrics || {})) {
                if (metricName === 'entity_id' || typeof metricSeries !== 'object' || metricSeries == null) {
                    continue;
                }
                if (metricSeries.current != null) {
                    metricSnapshot[metricName] = _safeNumber(metricSeries.current, 0);
                }
            }

            pods.push({
                service,
                pod,
                cpu: currentMetricValue(metrics, ['pod_cpu_usage_rate', 'pod_cpu_usage_rate_vs_limit', 'pod_cpu_usage_rate_vs_request']),
                memMB: currentMetricValue(metrics, ['pod_memory_working_set_bytes', 'pod_memory_usage_bytes']) / (1024 * 1024),
                memRatio: currentMetricValue(metrics, ['pod_memory_usage_vs_limit', 'pod_memory_usage_vs_request']),
                metrics: metricSnapshot,
            });
        }
    }
    return pods;
}

function getOfflineApmServices(apm) {
    return Object.entries(apm || {}).map(([service, metrics]) => ({
        service,
        requestCount: currentMetricValue(metrics, ['request_count']),
        errorCount: currentMetricValue(metrics, ['error_count']),
        latencyMs: currentMetricValue(metrics, ['avg_request_latency_seconds']) * 1000,
    }));
}

function buildPseudoResults(items, valueKey, metricBuilder) {
    return {
        results: (items || []).map(item => ({
            metric: metricBuilder(item),
            value: [Date.now() / 1000, String(_safeNumber(item[valueKey]))],
        })),
    };
}

function renderSimpleBarChart(canvasId, items, labelKey, valueKey, color = '#38bdf8') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const entries = (items || []).slice(0, 6);
    if (!entries.length) {
        ctx.fillStyle = '#5b5f73';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('暂无数据', canvas.width / 2, canvas.height / 2);
        return;
    }

    const barW = Math.min(42, (canvas.width - 40) / entries.length - 8);
    const maxH = canvas.height - 50;
    const maxVal = Math.max(...entries.map(item => _safeNumber(item[valueKey])), 1);

    entries.forEach((item, i) => {
        const value = _safeNumber(item[valueKey]);
        const x = 20 + i * (barW + 8);
        const h = (value / maxVal) * maxH;
        const y = canvas.height - 30 - h;

        ctx.fillStyle = color;
        ctx.fillRect(x, y, barW, h);

        ctx.fillStyle = '#8b8fa3';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(_truncate(item[labelKey], 10), x + barW / 2, canvas.height - 15);
        ctx.fillText(value.toFixed(0), x + barW / 2, y - 5);
    });
}

// ─────────────────────────────────────────
// Overview
// ─────────────────────────────────────────

async function loadOverview() {
    if (isOfflineMode()) {
        return loadOfflineOverview();
    }

    document.getElementById('overview-stat-label-1').textContent = '节点数';
    document.getElementById('overview-stat-label-2').textContent = 'Pod总数';
    document.getElementById('overview-stat-label-3').textContent = '命名空间';
    document.getElementById('overview-stat-label-4').textContent = '重启次数';
    document.getElementById('overview-grid-title').textContent = '节点状态';
    document.getElementById('overview-chart-title').textContent = 'Pod状态分布';
    document.getElementById('overview-alert-title').textContent = '最近告警';

    // Fire all 3 API calls in parallel
    const [data, nodesData, events] = await Promise.all([
        api('/api/cluster/overview'),
        api('/api/cluster/nodes'),
        api('/api/cluster/events?limit=5'),
    ]);

    if (data) {
        document.getElementById('stat-nodes').textContent = data.nodes || 0;
        document.getElementById('stat-pods').textContent = data.pods_total || 0;
        document.getElementById('stat-ns').textContent = data.namespaces || 0;
        document.getElementById('stat-restarts').textContent = data.total_restarts || 0;

        if (data.pod_phases) {
            renderPodChart(data.pod_phases);
        }
    }

    // Node grid
    if (nodesData?.nodes) {
        document.getElementById('node-grid').innerHTML = nodesData.nodes.map(n => `
            <div class="node-card">
                <div class="node-name">${escapeHtml(n.name)}</div>
                <div class="node-meta">
                    <span class="badge badge-${n.ready === 'True' ? 'success' : 'danger'}">${n.ready === 'True' ? 'Ready' : 'NotReady'}</span>
                    ${n.roles.map(r => `<span class="badge badge-info">${r}</span>`).join(' ')}
                </div>
                <div class="node-meta" style="margin-top:4px">CPU: ${n.cpu} | Mem: ${n.memory} | ${n.version}</div>
            </div>
        `).join('');
    }

    // Alert preview
    if (events?.events) {
        const warnings = events.events.filter(e => e.type === 'Warning');
        document.getElementById('alert-preview').innerHTML = warnings.length
            ? warnings.map(e => `
                <div class="signal-item">
                    <span><span class="badge badge-warning">${e.reason}</span> ${escapeHtml(e.message?.substring(0, 100) || '')}</span>
                    <span class="text-muted">${e.object}</span>
                </div>
            `).join('')
            : '<p class="text-muted">暂无告警</p>';
    }
}

async function loadOfflineOverview() {
    const [metricsData, logData, alertsData] = await Promise.all([
        api('/api/alidata/metrics'),
        api('/api/alidata/logs?time_range=1h&size=20'),
        api('/api/alerts/list'),
    ]);

    const k8s = metricsData?.k8s_metrics || {};
    const apm = metricsData?.apm_metrics || {};
    const pods = getOfflineK8sPods(k8s);
    const services = getOfflineApmServices(apm).sort((a, b) => b.requestCount - a.requestCount);
    const alerts = alertsData?.alerts || [];

    document.getElementById('overview-stat-label-1').textContent = '服务数';
    document.getElementById('overview-stat-label-2').textContent = 'Pod数';
    document.getElementById('overview-stat-label-3').textContent = '数据集';
    document.getElementById('overview-stat-label-4').textContent = '日志条数';
    document.getElementById('overview-grid-title').textContent = '服务摘要';
    document.getElementById('overview-chart-title').textContent = '请求量 Top6';
    document.getElementById('overview-alert-title').textContent = '离线异常信号';

    document.getElementById('stat-nodes').textContent = services.length;
    document.getElementById('stat-pods').textContent = pods.length;
    document.getElementById('stat-ns').textContent = currentOfflineLabel();
    document.getElementById('stat-restarts').textContent = logData?.total_hits || logData?.returned || 0;

    const nodeGrid = document.getElementById('node-grid');
    if (services.length) {
        nodeGrid.innerHTML = services.slice(0, 8).map(s => {
            const svcPods = pods.filter(p => p.service === s.service).length;
            return `
                <div class="node-card">
                    <div class="node-name">${escapeHtml(s.service)}</div>
                    <div class="node-meta">
                        <span class="badge badge-success">Offline</span>
                        <span class="badge badge-info">Pods ${svcPods}</span>
                    </div>
                    <div class="node-meta" style="margin-top:4px">Req: ${s.requestCount.toFixed(0)} | Latency: ${s.latencyMs.toFixed(1)} ms</div>
                </div>
            `;
        }).join('');
    } else {
        nodeGrid.innerHTML = '<p class="text-muted">暂无离线服务摘要</p>';
    }

    renderSimpleBarChart('pod-chart', services, 'service', 'requestCount', '#22c55e');

    const alertPreview = document.getElementById('alert-preview');
    if (alerts.length) {
        alertPreview.innerHTML = alerts.slice(0, 8).map(a => `
            <div class="signal-item">
                <span><span class="badge badge-${a.severity === 'critical' ? 'danger' : 'warning'}">${escapeHtml(a.source)}</span> ${escapeHtml((a.title || a.description || '').substring(0, 100))}</span>
                <span class="text-muted">${escapeHtml(a.service || currentOfflineLabel())}</span>
            </div>
        `).join('');
    } else {
        alertPreview.innerHTML = '<p class="text-muted">离线模式下暂无异常信号</p>';
    }
}

function renderPodChart(phases) {
    const canvas = document.getElementById('pod-chart');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const colors = { Running: '#22c55e', Succeeded: '#38bdf8', Pending: '#f59e0b', Failed: '#ef4444', Unknown: '#5b5f73' };
    const entries = Object.entries(phases);
    const total = entries.reduce((s, [, v]) => s + v, 0);

    // Simple bar chart
    const barW = Math.min(60, (canvas.width - 40) / entries.length - 10);
    const maxH = canvas.height - 50;
    const maxVal = Math.max(...entries.map(([, v]) => v), 1);

    entries.forEach(([phase, count], i) => {
        const x = 20 + i * (barW + 10);
        const h = (count / maxVal) * maxH;
        const y = canvas.height - 30 - h;

        ctx.fillStyle = colors[phase] || '#5b5f73';
        ctx.fillRect(x, y, barW, h);

        ctx.fillStyle = '#8b8fa3';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(phase, x + barW / 2, canvas.height - 15);
        ctx.fillText(count, x + barW / 2, y - 5);
    });
}

// ─────────────────────────────────────────
// Metrics (Enhanced with Prometheus)
// ─────────────────────────────────────────

async function loadMetrics() {
    applyMetricsModeUI();
    if (isOfflineMode()) {
        return loadOfflineMetrics();
    }

    const ns = document.getElementById('metrics-ns')?.value || '';

    // Load namespace options (non-blocking)
    loadNamespaces('metrics-ns');

    // Fetch Prometheus metrics + pods in parallel
    const [metrics, podData] = await Promise.all([
        api(`/api/prometheus/metrics_summary?namespace=${ns}`),
        api(`/api/cluster/pods?namespace=${ns}`),
    ]);

    // Render node metrics
    if (metrics) {
        renderMetricBars('metrics-node-cpu', metrics.node_cpu, '%');
        renderMetricBars('metrics-node-memory', metrics.node_memory, '%');
        renderMetricBars('metrics-node-disk', metrics.node_disk, '%');
        renderContainerTop('metrics-cpu-top', metrics.container_cpu_top, '%');
        renderContainerTop('metrics-mem-top', metrics.container_mem_top, 'MB');
    }

    // Render pod table
    if (podData?.pods) {
        const tbody = document.querySelector('#pod-table tbody');
        tbody.innerHTML = podData.pods.map(p => `
            <tr>
                <td>${escapeHtml(p.name)}</td>
                <td>${escapeHtml(p.namespace)}</td>
                <td><span class="badge badge-${badgeClass(p.phase)}">${p.phase}</span></td>
                <td>${p.ready}</td>
                <td class="${p.restarts > 5 ? 'text-danger' : ''}">${p.restarts}</td>
                <td>${escapeHtml(p.node || '')}</td>
            </tr>
        `).join('');
    }
}

function applyMetricsModeUI() {
    const offline = isOfflineMode();
    document.getElementById('metrics-filter-row').style.display = offline ? 'none' : 'flex';
    document.getElementById('promql-card').style.display = offline ? 'none' : 'block';
    setPodTableLayoutMode(offline);

    document.getElementById('metrics-title-1').textContent = offline ? 'Pod CPU 使用率 Top10 (%)' : '节点 CPU 使用率 (%)';
    document.getElementById('metrics-title-2').textContent = offline ? 'Pod 内存使用 Top10 (MB)' : '节点内存使用率 (%)';
    document.getElementById('metrics-title-3').textContent = offline ? '服务请求量 Top10' : '节点磁盘使用率 (%)';
    document.getElementById('metrics-title-4').textContent = offline ? 'Pod CPU Top10 (%)' : '容器 CPU Top10 (cores %)';
    document.getElementById('metrics-title-5').textContent = offline ? '服务延迟 Top10 (ms)' : '容器内存 Top10 (MB)';
    document.getElementById('metrics-title-6').textContent = offline ? `离线 Pod 摘要 (${currentOfflineLabel()})` : 'Pod 状态统计';

    if (offline) {
        setPodTableHeadings(['Pod', '服务', 'KPI 加载中']);
    } else {
        setPodTableHeadings(['名称', '命名空间', '状态', 'Ready', '重启', '节点']);
    }
}

async function loadOfflineMetrics() {
    const data = await api('/api/alidata/metrics');
    const k8s = data?.k8s_metrics || {};
    const apm = data?.apm_metrics || {};
    const pods = getOfflineK8sPods(k8s);
    const services = getOfflineApmServices(apm);

    const topCpuPods = [...pods].sort((a, b) => b.cpu - a.cpu).slice(0, 10);
    const topMemPods = [...pods].sort((a, b) => b.memMB - a.memMB).slice(0, 10);
    const topReqSvcs = [...services].sort((a, b) => b.requestCount - a.requestCount).slice(0, 10);
    const topLatencySvcs = [...services].sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 10);

    renderMetricBars(
        'metrics-node-cpu',
        buildPseudoResults(topCpuPods, 'cpu', item => ({ pod: item.pod, service: item.service })),
        '%'
    );
    renderMetricBars(
        'metrics-node-memory',
        buildPseudoResults(topMemPods, 'memMB', item => ({ pod: item.pod, service: item.service })),
        'MB'
    );
    renderMetricBars(
        'metrics-node-disk',
        buildPseudoResults(topReqSvcs, 'requestCount', item => ({ service: item.service })),
        'req'
    );

    renderContainerTop(
        'metrics-cpu-top',
        buildPseudoResults(topCpuPods, 'cpu', item => ({ pod: item.pod, namespace: item.service })),
        '%'
    );
    renderContainerTop(
        'metrics-mem-top',
        buildPseudoResults(topLatencySvcs, 'latencyMs', item => ({ service: item.service, namespace: currentOfflineLabel() })),
        'ms'
    );

    renderOfflinePodSummaryTable(pods);
}

function renderMetricBars(containerId, data, unit) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const results = data?.results || [];
    if (!results.length) {
        el.innerHTML = '<p class="text-muted" style="padding:8px">暂无数据</p>';
        return;
    }

    const values = results.map(r => parseFloat(r.value?.[1] || 0));
    const maxVal = Math.max(...values, 1);

    el.innerHTML = results.map(r => {
        const label = r.metric?.label || r.metric?.pod || r.metric?.service || r.metric?.instance || r.metric?.node || Object.values(r.metric || {})[0] || 'unknown';
        const shortLabel = label.replace(/:.*$/, '');
        const val = parseFloat(r.value?.[1] || 0).toFixed(1);
        const pct = unit === '%' ? Math.min(parseFloat(val), 100) : (parseFloat(val) / maxVal * 100);
        const color = pct > 90 ? 'var(--danger)' : pct > 75 ? 'var(--warning)' : 'var(--accent)';
        return `
            <div style="margin-bottom:6px">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">
                    <span>${escapeHtml(shortLabel)}</span>
                    <span style="font-weight:600">${val}${unit}</span>
                </div>
                <div style="background:var(--bg-secondary,#1e1e2e);border-radius:4px;height:16px;overflow:hidden">
                    <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width 0.3s"></div>
                </div>
            </div>
        `;
    }).join('');
}

function renderContainerTop(tableId, data, unit) {
    const tbody = document.querySelector(`#${tableId} tbody`);
    if (!tbody) return;

    const results = data?.results || [];
    if (!results.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-muted" style="text-align:center">暂无数据</td></tr>';
        return;
    }

    tbody.innerHTML = results.map(r => {
        const pod = r.metric?.pod || r.metric?.service || 'unknown';
        const ns = r.metric?.namespace || '-';
        const val = parseFloat(r.value?.[1] || 0).toFixed(2);
        return `<tr><td>${escapeHtml(pod)}</td><td>${escapeHtml(ns)}</td><td>${val} ${unit}</td></tr>`;
    }).join('');
}

async function runPromQL() {
    const query = document.getElementById('promql-input')?.value?.trim();
    const queryType = document.getElementById('promql-type')?.value || 'instant';
    const resultEl = document.getElementById('promql-result');

    if (!query) {
        resultEl.textContent = '请输入 PromQL 查询';
        return;
    }

    resultEl.textContent = '查询中...';
    const data = await api(`/api/prometheus/query?query=${encodeURIComponent(query)}&query_type=${queryType}`);

    if (!data || data.error) {
        resultEl.textContent = `错误: ${data?.error || '请求失败'}`;
        return;
    }

    resultEl.textContent = JSON.stringify(data.results || data, null, 2);
}

// ─────────────────────────────────────────
// Logs
// ─────────────────────────────────────────

async function loadNamespaces(selectId) {
    if (isOfflineMode()) return;
    const data = await api('/api/cluster/namespaces');
    if (!data?.namespaces) return;

    const sel = document.getElementById(selectId);
    const current = sel.value;
    sel.innerHTML = '<option value="">选择命名空间</option>' +
        data.namespaces.map(ns => `<option value="${ns}" ${ns === current ? 'selected' : ''}>${ns}</option>`).join('');
}

async function loadPodsByNs() {
    if (isOfflineMode()) return;
    const ns = document.getElementById('log-ns').value;
    if (!ns) return;

    const data = await api(`/api/cluster/pods?namespace=${ns}`);
    if (!data?.pods) return;

    const sel = document.getElementById('log-pod');
    sel.innerHTML = '<option value="">选择Pod</option>' +
        data.pods.map(p => `<option value="${p.name}">${p.name} (${p.phase})</option>`).join('');
}

async function loadLogsView() {
    applyLogsModeUI();
    if (isOfflineMode()) {
        return fetchLogs();
    }
    return loadNamespaces('log-ns');
}

function applyLogsModeUI() {
    const offline = isOfflineMode();
    document.getElementById('log-ns').style.display = offline ? 'none' : '';
    document.getElementById('log-pod').style.display = offline ? 'none' : '';
    document.getElementById('offline-log-query').style.display = offline ? '' : 'none';
    document.getElementById('offline-log-level').style.display = offline ? '' : 'none';
    document.getElementById('offline-log-timerange').style.display = offline ? '' : 'none';

    const viewer = document.getElementById('log-content');
    if (offline && !viewer.textContent.trim()) {
        viewer.textContent = '输入关键词后点击查询，或直接查看当前离线数据日志...';
    }
}

async function fetchLogs() {
    if (isOfflineMode()) {
        const query = document.getElementById('offline-log-query').value.trim();
        const level = document.getElementById('offline-log-level').value || '';
        const timeRange = document.getElementById('offline-log-timerange').value || '1h';
        const lines = document.getElementById('log-lines').value || 200;
        const viewer = document.getElementById('log-content');
        viewer.textContent = '加载中...';

        let url = `/api/alidata/logs?time_range=${encodeURIComponent(timeRange)}&size=${encodeURIComponent(lines)}`;
        if (query) url += `&query=${encodeURIComponent(query)}`;
        if (level) url += `&level=${encodeURIComponent(level)}`;

        const data = await api(url);
        if (!data || data.error) {
            viewer.textContent = `错误: ${data?.error || '请求失败'}`;
            return;
        }

        const entries = data.entries || [];
        if (!entries.length) {
            viewer.textContent = '无日志内容';
            return;
        }

        viewer.textContent = entries.map(e => {
            const ts = e.timestamp ? formatTime(typeof e.timestamp === 'number' && e.timestamp < 2e10 ? e.timestamp * 1000 : e.timestamp) : '-';
            const levelTag = (e.level || 'info').toUpperCase();
            const source = e.service || e.pod || currentOfflineLabel();
            return `[${ts}] [${levelTag}] [${source}] ${e.message || ''}`;
        }).join('\n');
        return;
    }

    const ns = document.getElementById('log-ns').value;
    const pod = document.getElementById('log-pod').value;
    const lines = document.getElementById('log-lines').value || 200;

    if (!ns || !pod) { alert('请选择命名空间和Pod'); return; }

    const viewer = document.getElementById('log-content');
    viewer.textContent = '加载中...';
    const data = await api(`/api/logs/${ns}/${pod}?lines=${lines}`);
    viewer.textContent = data?.logs || '无日志内容';
}

// ─────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────

let _alertData = [];  // cached alert data
let _filteredAlerts = [];

const SOURCE_CONFIG = {
    k8s_event:   { label: 'K8s事件',    icon: '📅', cls: 'source-k8s' },
    prometheus:  { label: 'Prometheus', icon: '📊', cls: 'source-prom' },
    pod_health:  { label: 'Pod健康',    icon: '🫛', cls: 'source-pod' },
    node_health: { label: '节点健康',   icon: '🖥️', cls: 'source-node' },
    metric_anomaly: { label: '指标异常', icon: '📈', cls: 'source-metric' },
};

async function loadAlertList() {
    const data = await api('/api/alerts/list');
    if (!data) return;
    _alertData = data.alerts || [];
    if (isOfflineMode()) {
        updateSourceFilterButtons({
            prometheus: false,
            k8s_event: false,
            pod_health: false,
            node_health: false,
            metric_anomaly: true,
        });
    }
    renderAlertSourceStats(_alertData);
    filterAlerts();  // apply current filters
}

function renderAlertSourceStats(alerts) {
    const stats = {};
    alerts.forEach(a => { stats[a.source] = (stats[a.source] || 0) + 1; });

    const container = document.getElementById('alert-source-stats');
    const sourceInfo = {
        k8s_event:   { label: 'K8s事件',    color: 'var(--info)' },
        prometheus:  { label: 'Prometheus', color: 'var(--accent)' },
        pod_health:  { label: 'Pod健康',    color: 'var(--danger)' },
        node_health: { label: '节点健康',   color: 'var(--warning)' },
        metric_anomaly: { label: '指标异常', color: 'var(--success)' },
    };

    container.innerHTML = Object.entries(stats).map(([src, count]) => {
        const info = sourceInfo[src] || { label: src, color: 'var(--text-muted)' };
        return `<div class="stat-card" style="border-left:3px solid ${info.color}">
            <div class="stat-label">${info.label}</div>
            <div class="stat-value">${count}</div>
        </div>`;
    }).join('') + `<div class="stat-card accent">
        <div class="stat-label">总告警</div>
        <div class="stat-value">${alerts.length}</div>
    </div>`;
}

function filterAlerts(source) {
    // Update source button highlight
    if (source) {
        document.querySelectorAll('.alert-source-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(`.alert-source-btn[data-source="${source}"]`)?.classList.add('active');
    }

    const activeSource = document.querySelector('.alert-source-btn.active')?.dataset.source || 'all';
    const severityFilter = document.getElementById('alert-severity-filter').value;

    let filtered = _alertData;
    if (activeSource !== 'all') {
        filtered = filtered.filter(a => a.source === activeSource);
    }
    if (severityFilter !== 'all') {
        filtered = filtered.filter(a => a.severity === severityFilter);
    }

    renderAlertTable(filtered);
}

function renderAlertTable(alerts) {
    _filteredAlerts = alerts;
    const tbody = document.getElementById('alert-table-body');
    const empty = document.getElementById('alert-empty');

    if (!alerts.length) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = alerts.map((a, i) => {
        const src = SOURCE_CONFIG[a.source] || { label: a.source, icon: '❓', cls: '' };
        const sevClass = a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warning' : 'info';
        return `<tr>
            <td><span class="source-badge ${src.cls}">${src.icon} ${src.label}</span></td>
            <td><span class="badge badge-${sevClass}">${a.severity}</span></td>
            <td title="${escapeHtml(a.description || '')}">${escapeHtml(a.title || (a.description || '').substring(0, 80) || '')}</td>
            <td>${escapeHtml(a.service || '')}</td>
            <td>${escapeHtml(a.namespace || '')}</td>
            <td>${formatTime(a.timestamp ? a.timestamp * 1000 : null)}</td>
            <td><button class="btn btn-sm btn-primary" onclick="startRCAFromAlert(${i})">🔍 分析</button></td>
        </tr>`;
    }).join('');
}

async function runAlertScan() {
    const container = document.getElementById('alert-scan-result');
    container.innerHTML = '<div class="loading">扫描中</div>';

    const data = await api('/api/alerts/scan');
    if (!data) { container.innerHTML = '<p class="text-danger">扫描失败</p>'; return; }

    let html = `<div style="margin-bottom:12px">
        <span class="badge badge-info">总告警: ${data.total_alerts || 0}</span>
        <span class="badge badge-success">分组数: ${data.compressed_groups || data.num_groups || 0}</span>
        <span class="badge badge-warning">压缩率: ${((data.compression_ratio || 0) * 100).toFixed(0)}%</span>
    </div>`;

    (data.groups || []).forEach((g, gi) => {
        const severity = (g.severity || '').toLowerCase();
        // Find raw alerts belonging to this group by matching indices
        const rawAlerts = data.raw_alerts || [];
        const groupAlerts = (g.alert_indices || []).map(i => rawAlerts[i]).filter(Boolean);

        html += `
            <div class="alert-group ${severity === 'critical' ? 'critical' : ''}">
                <div class="group-title">${escapeHtml(g.group_label || g.representative || g.common_pattern || '告警组 ' + (gi+1))}</div>
                <div class="group-meta">${g.alert_count || 0} 条告警 · ${escapeHtml(g.severity || 'unknown')}</div>
                ${g.root_cause || g.root_cause_recommendation ? `<div class="group-rca">💡 ${escapeHtml(g.root_cause || g.root_cause_recommendation)}</div>` : ''}
                ${groupAlerts.length ? `<details style="margin-top:8px;font-size:12px">
                    <summary style="cursor:pointer;color:var(--text-muted)">查看组内告警详情</summary>
                    <div style="margin-top:6px">
                    ${groupAlerts.map(a => {
                        const src = SOURCE_CONFIG[a.source] || { label: a.source, icon: '❓', cls: '' };
                        return `<div class="signal-item"><span><span class="source-badge ${src.cls}">${src.icon} ${src.label}</span> ${escapeHtml(a.name || '')} — ${escapeHtml((a.message || '').substring(0, 120))}</span></div>`;
                    }).join('')}
                    </div>
                </details>` : ''}
            </div>
        `;
    });

    container.innerHTML = html;
}

function toggleDetectionSSE() {
    if (state.detectionSSE) {
        state.detectionSSE.close();
        state.detectionSSE = null;
        return;
    }

    const feed = document.getElementById('detection-feed');
    state.detectionSSE = new EventSource('/api/detection/stream');
    state.detectionSSE.onmessage = (e) => {
        try {
            const signal = JSON.parse(e.data);
            const item = document.createElement('div');
            item.className = 'signal-item';
            item.innerHTML = `
                <span><span class="badge badge-${signal.severity === 'critical' ? 'danger' : 'warning'}">${signal.severity || 'info'}</span> ${escapeHtml(signal.description || signal.msg || JSON.stringify(signal).substring(0, 100))}</span>
                <span class="text-muted">${formatTime(signal.timestamp)}</span>
            `;
            feed.prepend(item);
        } catch {}
    };
}

async function clearSignals() {
    await api('/api/detection/signals', { method: 'DELETE' });
    document.getElementById('detection-feed').innerHTML = '';
}

// ─────────────────────────────────────────
// Detection Config Management
// ─────────────────────────────────────────

let _detectionConfig = null;

async function loadDetectionConfig() {
    const data = await api('/api/detection/config');
    if (!data) return;
    _detectionConfig = data;
    renderSourceToggles(data);
    renderCategoryToggles(data);
    renderServiceTags('business-services-tags', data.business_services || [], 'business_services');
    renderServiceTags('db-services-tags', data.db_services || [], 'db_services');
    renderMetricChecksTable(data.metric_checks || []);
    renderCriticalReasons('critical-event-reasons', data.critical_event_reasons || []);
    renderCriticalReasons('critical-pod-reasons', data.critical_pod_reasons || []);
    updateSourceFilterButtons(data.sources_enabled || {});
    // Populate global algorithm params
    const lbEl = document.getElementById('cfg-lookback-m');
    const ztEl = document.getElementById('cfg-z-threshold');
    const esEl = document.getElementById('cfg-ewma-span');
    if (lbEl) lbEl.value = data.default_lookback_m || 30;
    if (ztEl) ztEl.value = data.default_z_threshold || 3.0;
    if (esEl) esEl.value = data.default_ewma_span || 10;
}

function renderSourceToggles(config) {
    const container = document.getElementById('source-toggles');
    const sources = config.sources_enabled || {};
    const labels = {
        prometheus: 'Prometheus',
        k8s_event: 'K8s事件',
        pod_health: 'Pod健康',
        node_health: '节点健康',
        metric_anomaly: '指标异常',
    };

    container.innerHTML = Object.entries(sources).map(([key, enabled]) => `
        <label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:13px;cursor:pointer">
            <input type="checkbox" data-source="${escapeHtml(key)}" ${enabled ? 'checked' : ''}
                   onchange="toggleSource('${escapeHtml(key)}', this.checked)">
            ${labels[key] || key}
        </label>
    `).join('');
}

function toggleSource(key, enabled) {
    if (_detectionConfig && _detectionConfig.sources_enabled) {
        _detectionConfig.sources_enabled[key] = enabled;
    }
}

function renderCategoryToggles(config) {
    const container = document.getElementById('category-toggles');
    if (!container) return;
    const cats = config.categories_enabled || {};
    const labels = {
        infrastructure: '基础设施 (Infrastructure)',
        application: '应用 (Application)',
        business: '业务工作负载 (Business)',
        database: '数据库 (Database)',
        k8s_workload: 'K8s工作负载健康',
    };

    container.innerHTML = Object.entries(cats).map(([key, enabled]) => `
        <label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:13px;cursor:pointer">
            <input type="checkbox" data-category="${escapeHtml(key)}" ${enabled ? 'checked' : ''}
                   onchange="toggleCategory('${escapeHtml(key)}', this.checked)">
            ${labels[key] || key}
        </label>
    `).join('');
}

function toggleCategory(key, enabled) {
    if (_detectionConfig && _detectionConfig.categories_enabled) {
        _detectionConfig.categories_enabled[key] = enabled;
    }
}

function renderServiceTags(containerId, services, configKey) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = services.map((s, i) => `
        <span class="badge badge-info" style="margin:2px;font-size:12px">
            ${escapeHtml(s)}
            <span style="cursor:pointer;margin-left:4px" onclick="removeServiceTag('${containerId}', '${configKey}', ${i})">&times;</span>
        </span>
    `).join('') + `
        <button class="btn btn-sm" onclick="addServiceTag('${containerId}', '${configKey}')" style="font-size:11px">+ 添加</button>
    `;
}

function addServiceTag(containerId, configKey) {
    const name = prompt('输入服务名称:');
    if (!name) return;
    if (_detectionConfig) {
        _detectionConfig[configKey] = _detectionConfig[configKey] || [];
        _detectionConfig[configKey].push(name.trim());
        renderServiceTags(containerId, _detectionConfig[configKey], configKey);
    }
}

function removeServiceTag(containerId, configKey, index) {
    if (_detectionConfig && _detectionConfig[configKey]) {
        _detectionConfig[configKey].splice(index, 1);
        renderServiceTags(containerId, _detectionConfig[configKey], configKey);
    }
}

function renderMetricChecksTable(checks) {
    const tbody = document.getElementById('metric-checks-body');
    if (!checks.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-muted" style="text-align:center">暂无指标配置</td></tr>';
        return;
    }

    const allMethods = ['threshold', 'zscore', 'ewma', 'spectral_residual', 'pearson_onset', 'rate_change'];
    const defaultMethods = (_detectionConfig && _detectionConfig.default_detect_methods) || ['threshold', 'zscore'];

    tbody.innerHTML = checks.map((c, i) => {
        const methods = c.detect_methods || defaultMethods;
        const methodCheckboxes = allMethods.map(m => {
            const checked = methods.includes(m) ? 'checked' : '';
            return `<label style="display:inline-flex;align-items:center;gap:2px;font-size:11px;white-space:nowrap">
                <input type="checkbox" class="mc-method" data-idx="${i}" data-method="${m}" ${checked}> ${m}
            </label>`;
        }).join(' ');

        return `<tr>
            <td><input class="input-sm mc-name" value="${escapeHtml(c.name || '')}" style="width:120px" data-idx="${i}"></td>
            <td><select class="select-sm mc-level" data-idx="${i}">
                <option value="node" ${c.level === 'node' ? 'selected' : ''}>node</option>
                <option value="container" ${c.level === 'container' ? 'selected' : ''}>container</option>
            </select></td>
            <td><input type="number" class="input-sm mc-warn" value="${c.warn}" style="width:60px" data-idx="${i}"></td>
            <td><input type="number" class="input-sm mc-crit" value="${c.crit}" style="width:60px" data-idx="${i}"></td>
            <td>${escapeHtml(c.unit || '%')}</td>
            <td style="max-width:280px">${methodCheckboxes}</td>
            <td>
                <button class="btn btn-sm" onclick="editMetricCheck(${i})" title="编辑PromQL">✏️</button>
                <button class="btn btn-sm btn-danger" onclick="removeMetricCheck(${i})">🗑️</button>
            </td>
        </tr>`;
    }).join('');
}

function renderCriticalReasons(containerId, reasons) {
    const container = document.getElementById(containerId);
    container.innerHTML = reasons.map((r, i) => `
        <span class="badge badge-danger" style="margin:2px;font-size:12px">
            ${escapeHtml(r)}
            <span style="cursor:pointer;margin-left:4px" onclick="removeCriticalReason('${containerId}', ${i})">&times;</span>
        </span>
    `).join('') + `
        <button class="btn btn-sm" onclick="addCriticalReason('${containerId}')" style="font-size:11px">+ 添加</button>
    `;
}

function addCriticalReason(containerId) {
    const reason = prompt('输入原因名称:');
    if (!reason) return;
    const key = containerId === 'critical-event-reasons' ? 'critical_event_reasons' : 'critical_pod_reasons';
    if (_detectionConfig) {
        _detectionConfig[key] = _detectionConfig[key] || [];
        _detectionConfig[key].push(reason.trim());
        renderCriticalReasons(containerId, _detectionConfig[key]);
    }
}

function removeCriticalReason(containerId, index) {
    const key = containerId === 'critical-event-reasons' ? 'critical_event_reasons' : 'critical_pod_reasons';
    if (_detectionConfig && _detectionConfig[key]) {
        _detectionConfig[key].splice(index, 1);
        renderCriticalReasons(containerId, _detectionConfig[key]);
    }
}

function addMetricCheck() {
    const defaultMethods = (_detectionConfig && _detectionConfig.default_detect_methods) || ['threshold', 'zscore'];
    const newCheck = {
        name: 'new_metric',
        query: '',
        unit: '%',
        label_key: 'instance',
        ns_key: '',
        level: 'node',
        warn: 85,
        crit: 95,
        detect_methods: [...defaultMethods],
    };
    if (_detectionConfig) {
        _detectionConfig.metric_checks = _detectionConfig.metric_checks || [];
        _detectionConfig.metric_checks.push(newCheck);
        renderMetricChecksTable(_detectionConfig.metric_checks);
        // Auto-open edit for the new metric
        editMetricCheck(_detectionConfig.metric_checks.length - 1);
    }
}

function editMetricCheck(index) {
    if (!_detectionConfig || !_detectionConfig.metric_checks) return;
    const check = _detectionConfig.metric_checks[index];
    if (!check) return;

    const query = prompt('PromQL 查询表达式:', check.query || '');
    if (query === null) return;
    check.query = query;

    const labelKey = prompt('标签键 (label_key):', check.label_key || 'instance');
    if (labelKey !== null) check.label_key = labelKey;

    const nsKey = prompt('命名空间键 (ns_key, 可留空):', check.ns_key || '');
    if (nsKey !== null) check.ns_key = nsKey;

    renderMetricChecksTable(_detectionConfig.metric_checks);
}

function removeMetricCheck(index) {
    if (!_detectionConfig || !_detectionConfig.metric_checks) return;
    _detectionConfig.metric_checks.splice(index, 1);
    renderMetricChecksTable(_detectionConfig.metric_checks);
}

function _collectMetricChecksFromUI() {
    if (!_detectionConfig || !_detectionConfig.metric_checks) return;
    const checks = _detectionConfig.metric_checks;
    document.querySelectorAll('.mc-name').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        if (checks[idx]) checks[idx].name = el.value;
    });
    document.querySelectorAll('.mc-level').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        if (checks[idx]) checks[idx].level = el.value;
    });
    document.querySelectorAll('.mc-warn').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        if (checks[idx]) checks[idx].warn = parseFloat(el.value) || 0;
    });
    document.querySelectorAll('.mc-crit').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        if (checks[idx]) checks[idx].crit = parseFloat(el.value) || 0;
    });
    // Collect detect_methods per metric
    const methodsByIdx = {};
    document.querySelectorAll('.mc-method').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        if (!methodsByIdx[idx]) methodsByIdx[idx] = [];
        if (el.checked) methodsByIdx[idx].push(el.dataset.method);
    });
    for (const [idx, methods] of Object.entries(methodsByIdx)) {
        const i = parseInt(idx);
        if (checks[i]) checks[i].detect_methods = methods;
    }
}

async function saveDetectionConfig() {
    if (!_detectionConfig) return;
    _collectMetricChecksFromUI();

    // Collect global algorithm params from UI
    const lbEl = document.getElementById('cfg-lookback-m');
    const ztEl = document.getElementById('cfg-z-threshold');
    const esEl = document.getElementById('cfg-ewma-span');
    const lookbackM = lbEl ? parseInt(lbEl.value) || 30 : 30;
    const zThreshold = ztEl ? parseFloat(ztEl.value) || 3.0 : 3.0;
    const ewmaSpan = esEl ? parseInt(esEl.value) || 10 : 10;

    const payload = {
        sources_enabled: _detectionConfig.sources_enabled,
        metric_checks: _detectionConfig.metric_checks,
        critical_event_reasons: _detectionConfig.critical_event_reasons,
        critical_pod_reasons: _detectionConfig.critical_pod_reasons,
        default_lookback_m: lookbackM,
        default_z_threshold: zThreshold,
        default_ewma_span: ewmaSpan,
        categories_enabled: _detectionConfig.categories_enabled || {},
        business_services: _detectionConfig.business_services || [],
        db_services: _detectionConfig.db_services || [],
    };

    const statusEl = document.getElementById('detection-save-status');
    statusEl.textContent = '保存中...';

    const result = await api('/api/detection/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (result && result.status === 'ok') {
        statusEl.textContent = '✅ 已保存';
        // Update source filter buttons
        updateSourceFilterButtons(_detectionConfig.sources_enabled);
        // Reload alert list to reflect changes
        loadAlertList();
    } else {
        statusEl.textContent = '❌ 保存失败';
    }
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

function updateSourceFilterButtons(sourcesEnabled) {
    const filterContainer = document.getElementById('alert-source-filters');
    if (!filterContainer) return;
    // Show/hide source filter buttons based on enabled state
    filterContainer.querySelectorAll('.alert-source-btn[data-source]').forEach(btn => {
        const src = btn.dataset.source;
        if (src === 'all') return;
        btn.style.display = (sourcesEnabled[src] !== false) ? '' : 'none';
    });
}

function startRCAFromAlert(index) {
    const a = _filteredAlerts[index];
    if (!a) return;
    const query = `[${(a.severity || 'warning').toUpperCase()}] ${a.title || ''} — ${a.description || ''} (service=${a.service || ''}, namespace=${a.namespace || ''})`;
    switchView('rca');
    document.getElementById('rca-query').value = query;
    document.getElementById('rca-ns').value = a.namespace || '';
    startRCA();
}

// ─────────────────────────────────────────
// RCA
// ─────────────────────────────────────────

async function startRCA() {
    const query = document.getElementById('rca-query').value.trim();
    const ns = document.getElementById('rca-ns').value.trim();
    if (!query) { alert('请描述故障现象'); return; }

    const data = await api('/api/rca/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, namespace: ns }),
    });

    if (!data?.run_id) { alert('启动失败'); return; }

    state.rcaRunId = data.run_id;

    // Show progress card, hide result card
    const progress = document.getElementById('rca-progress');
    progress.style.display = 'block';
    const resultCard = document.getElementById('rca-result-card');
    resultCard.style.display = 'none';

    // Reset UI elements
    const logEl = document.getElementById('rca-log');
    logEl.textContent = '';
    document.getElementById('rca-phases').innerHTML = '';
    document.getElementById('rca-hyp-list').innerHTML = '';
    document.getElementById('rca-hypotheses').style.display = 'none';
    document.getElementById('rca-evidence-grid').innerHTML = '';
    document.getElementById('rca-evidence').style.display = 'none';
    document.getElementById('rca-iteration').style.display = 'none';
    document.getElementById('rca-result-content').innerHTML = '';

    // SSE stream
    const sse = new EventSource(`/api/rca/${data.run_id}/stream`);
    sse.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'log') {
                logEl.textContent += msg.msg + '\n';
                logEl.scrollTop = logEl.scrollHeight;
            } else if (msg.type === 'event') {
                handleRCAEvent(msg.data);
            } else if (msg.type === 'done') {
                sse.close();
                renderRCAFinalResult(msg.result);
                loadRCAHistory();
            }
        } catch {}
    };
    sse.onerror = () => { sse.close(); };
}

// ── RCA Event Dispatcher ──

function handleRCAEvent(evt) {
    switch (evt.event) {
        case 'phase_start':
            updatePhase(evt.phase, evt.name, 'active');
            break;
        case 'phase_complete':
            updatePhase(evt.phase, evt.name, 'done');
            break;
        case 'hypotheses':
            renderHypotheses(evt.items);
            break;
        case 'evidence':
            addEvidenceCard(evt.agent, evt.summary, evt.success);
            break;
        case 'iteration':
            updateIteration(evt.current, evt.total);
            break;
        case 'result':
            // Handled by 'done' SSE message
            break;
        case 'judge':
            renderJudge(evt.data);
            break;
        case 'remediation':
            renderRemediation(evt.data);
            break;
        case 'remediation_executed':
            renderRemediationResult(evt.data);
            break;
    }
}

// ── Phase Progress ──

const PHASE_NAMES = {
    0: '告警压缩',
    1: '上下文检索',
    2: '假设生成',
    3: '证据调查',
    4: '交叉关联',
    5: '图分析',
    6: '报告生成',
    7: '质量评估',
    8: '自动学习',
    9: '自愈修复',
};

function updatePhase(num, name, status) {
    const container = document.getElementById('rca-phases');
    let badge = document.getElementById(`rca-phase-${num}`);
    if (!badge) {
        badge = document.createElement('span');
        badge.id = `rca-phase-${num}`;
        badge.className = 'phase-badge';
        badge.textContent = PHASE_NAMES[num] || name;
        container.appendChild(badge);
    }
    badge.className = `phase-badge ${status}`;
}

// ── Iteration Indicator ──

function updateIteration(current, total) {
    const el = document.getElementById('rca-iteration');
    el.style.display = 'block';
    el.innerHTML = `<span class="iteration-badge">迭代 ${current} / ${total}</span>`;
}

// ── Hypothesis Rendering ──

function renderHypotheses(items) {
    const wrapper = document.getElementById('rca-hypotheses');
    wrapper.style.display = 'block';
    const list = document.getElementById('rca-hyp-list');

    list.innerHTML = items.map((h, i) => {
        const pct = Math.round(h.confidence * 100);
        return `<div class="hyp-item">
            <span class="hyp-rank">#${i + 1}</span>
            <div class="hyp-bar-wrap"><div class="hyp-bar" style="width:${pct}%"></div></div>
            <span class="hyp-conf">${pct}%</span>
            <span class="hyp-desc" title="${escapeHtml(h.description)}">${escapeHtml(h.description)}</span>
        </div>`;
    }).join('');
}

// ── Evidence Cards ──

function addEvidenceCard(agent, summary, success) {
    const wrapper = document.getElementById('rca-evidence');
    wrapper.style.display = 'block';
    const grid = document.getElementById('rca-evidence-grid');

    const agentLabels = {
        metric_agent: '📈 Metric Agent',
        log_agent: '📋 Log Agent',
        trace_agent: '🔗 Trace Agent',
        event_agent: '📅 Event Agent',
    };

    const card = document.createElement('div');
    card.className = `evidence-card ${success ? 'success' : 'error'}`;
    card.innerHTML = `
        <div class="ev-agent">${success ? '✅' : '⚠️'} ${agentLabels[agent] || agent}</div>
        <div class="ev-summary">${escapeHtml(summary || (success ? '分析完成' : '分析失败'))}</div>
    `;
    grid.appendChild(card);
}

// ── Judge Rendering ──

function renderJudge(data) {
    if (!data) return;
    const resultContent = document.getElementById('rca-result-content');
    const level = (data.judge_level || '').toLowerCase();
    const cls = level === 'gold' ? 'gold' : level === 'silver' ? 'silver' : 'bronze';
    const label = level === 'gold' ? '🥇 Gold' : level === 'silver' ? '🥈 Silver' : '🥉 Bronze';

    // Append judge info (will appear after result renders)
    const judgeEl = document.createElement('div');
    judgeEl.id = 'rca-judge-info';
    judgeEl.style.marginTop = '12px';
    judgeEl.innerHTML = `
        <span class="judge-badge ${cls}">${label} — 评分 ${(data.combined_score || data.score || 0).toFixed(3)}</span>
        ${data.needs_review ? '<span class="badge badge-warning" style="margin-left:8px">需要人工复核</span>' : ''}
    `;
    // Store for later insertion after result renders
    state._pendingJudge = judgeEl;
}

// ── Final Result Rendering ──

function renderRCAFinalResult(result) {
    const card = document.getElementById('rca-result-card');
    const content = document.getElementById('rca-result-content');
    card.style.display = 'block';

    if (!result) {
        content.innerHTML = '<p class="text-danger">未获取到结果</p>';
        return;
    }

    const status = result.status || 'unknown';
    // Unwrap nested: PipelineResult.result → rca_engine.result → LLM final_result
    const inner = result.result || result;
    const rca = (inner.result && typeof inner.result === 'object' && !Array.isArray(inner.result))
        ? inner.result : inner;
    const rootCause = rca.root_cause || rca.error || 'N/A';
    const conf = rca.confidence || 0;
    const confPct = Math.round(conf * 100);
    const confClass = conf >= 0.7 ? 'high' : conf >= 0.4 ? 'medium' : 'low';

    let html = `<div class="rca-result-structured">`;

    // Status header
    html += `<div class="result-banner ${status === 'completed' ? 'success' : 'failed'}">
        <h4>${status === 'completed' ? '✅ 根因分析完成' : '❌ 分析失败'}</h4>
    </div>`;

    // Root cause
    html += `<div class="rca-root-cause">${escapeHtml(rootCause)}</div>`;

    // Confidence bar
    html += `<div class="rca-conf-row">
        <span style="font-size:12px;color:var(--text-muted)">置信度</span>
        <div class="rca-conf-bar"><div class="rca-conf-fill ${confClass}" style="width:${confPct}%"></div></div>
        <span class="rca-conf-label">${confPct}%</span>
    </div>`;

    // Meta grid
    html += `<div class="rca-meta-grid">`;
    if (rca.fault_type) {
        html += `<div class="rca-meta-item"><div class="meta-label">故障类型</div><div class="meta-value">${escapeHtml(rca.fault_type)}</div></div>`;
    }
    if (rca.affected_services?.length) {
        html += `<div class="rca-meta-item"><div class="meta-label">受影响服务</div><div class="meta-value">${rca.affected_services.map(s => escapeHtml(s)).join(', ')}</div></div>`;
    }
    if (rca.evidence_summary) {
        const es = rca.evidence_summary;
        for (const [key, val] of Object.entries(es)) {
            if (val) {
                html += `<div class="rca-meta-item"><div class="meta-label">${escapeHtml(key)}</div><div class="meta-value">${escapeHtml(String(val).substring(0, 200))}</div></div>`;
            }
        }
    }
    html += `</div>`;

    // Timeline
    if (rca.timeline?.length) {
        html += `<div><h4 style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">事件时间线</h4><div class="rca-timeline">`;
        rca.timeline.forEach(t => {
            html += `<div class="rca-timeline-item">
                <div class="tl-time">${escapeHtml(t.time || '')}</div>
                <div class="tl-event">${escapeHtml(t.event || '')}</div>
            </div>`;
        });
        html += `</div></div>`;
    }

    // Remediation
    if (rca.remediation_suggestion) {
        html += `<div class="rca-remediation">💡 <strong>修复建议：</strong>${escapeHtml(rca.remediation_suggestion)}</div>`;
    }
    if (rca.prevention) {
        html += `<div class="rca-remediation" style="margin-top:8px">🛡️ <strong>预防措施：</strong>${escapeHtml(rca.prevention)}</div>`;
    }

    html += `</div>`;
    content.innerHTML = html;

    // Append judge info if available
    if (state._pendingJudge) {
        content.appendChild(state._pendingJudge);
        state._pendingJudge = null;
    }

    // Append pending remediation if available
    if (state._pendingRemediation) {
        content.appendChild(state._pendingRemediation);
        state._pendingRemediation = null;
    }
}

// ── Remediation Rendering ──

function renderRemediation(data) {
    if (!data) return;

    const status = data.status || 'unknown';
    const el = document.createElement('div');
    el.id = 'rca-remediation-section';
    el.className = 'rca-remediation-section';

    if (status === 'pending_approval') {
        const plan = data.plan || {};
        const actions = plan.actions || [];

        let actionsHtml = actions.map((a, i) => {
            const risk = (a.risk_level || 'low').toLowerCase();
            const riskClass = risk === 'high' ? 'danger' : risk === 'medium' ? 'warning' : 'success';
            return `<div class="rem-action-item">
                <div class="rem-action-header">
                    <span class="rem-action-num">${i + 1}</span>
                    <span class="badge badge-${riskClass}">${a.risk_level || 'low'}</span>
                    <span class="rem-action-desc">${escapeHtml(a.description || '')}</span>
                </div>
                <div class="rem-action-cmd"><code>${escapeHtml(a.command || '')}</code></div>
                ${a.rollback_command ? `<div class="rem-action-rollback">↩️ ${escapeHtml(a.rollback_command)}</div>` : ''}
            </div>`;
        }).join('');

        el.innerHTML = `
            <h4>🛠️ 自愈修复方案</h4>
            <div class="rem-status-badge pending">等待审批</div>
            ${plan.estimated_recovery_time ? `<div class="rem-meta">预计恢复时间: ${escapeHtml(plan.estimated_recovery_time)}</div>` : ''}
            <div class="rem-actions-list">${actionsHtml}</div>
            <div class="rem-buttons">
                <button class="btn btn-primary" onclick="approveRemediation()">✅ 批准执行</button>
                <button class="btn btn-secondary" onclick="dismissRemediation()">❌ 拒绝</button>
            </div>
        `;
    } else if (status === 'disabled') {
        el.innerHTML = `<div class="rem-status-badge disabled">自愈已禁用</div>`;
    } else if (status === 'skipped') {
        el.innerHTML = `<div class="rem-status-badge skipped">置信度不足，跳过自愈</div>`;
    } else if (status === 'executed') {
        renderRemediationResult(data);
        return;
    }

    // Store for appending to result card
    state._pendingRemediation = el;

    // Also try to append immediately if result card is visible
    const content = document.getElementById('rca-result-content');
    if (content && content.innerHTML) {
        content.appendChild(el);
        state._pendingRemediation = null;
    }
}

function renderRemediationResult(data) {
    const section = document.getElementById('rca-remediation-section');
    const target = section || document.getElementById('rca-result-content');
    if (!target) return;

    const actions = data.actions || [];
    const verification = data.verification || {};

    let html = `<div class="rca-remediation-section">
        <h4>🛠️ 自愈执行结果</h4>
        <div class="rem-status-badge executed">已执行</div>`;

    actions.forEach((a, i) => {
        const ok = a.status === 'executed';
        html += `<div class="rem-result-item ${ok ? 'success' : 'failed'}">
            <span>${ok ? '✅' : '❌'} ${escapeHtml(a.description || `Action ${i+1}`)}</span>
            <span class="rem-result-detail">${escapeHtml((a.result || '').substring(0, 100))}</span>
        </div>`;
    });

    if (data.rollback_available) {
        html += `<div class="rem-buttons">
            <button class="btn btn-warning" onclick="rollbackRemediation()">↩️ 回滚</button>
        </div>`;
    }

    html += `</div>`;

    if (section) {
        section.outerHTML = html;
    } else {
        target.insertAdjacentHTML('beforeend', html);
    }
}

async function approveRemediation() {
    if (!state.rcaRunId) return;
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '⏳ 执行中...';

    try {
        const result = await api(`/api/rca/${state.rcaRunId}/remediation/approve`, {
            method: 'POST',
        });
        if (result) {
            renderRemediationResult(result);
        }
    } catch (e) {
        alert('执行失败: ' + e.message);
    }
    btn.disabled = false;
}

async function rollbackRemediation() {
    if (!state.rcaRunId) return;
    if (!confirm('确认回滚所有修复操作？')) return;

    try {
        const result = await api(`/api/rca/${state.rcaRunId}/remediation/rollback`, {
            method: 'POST',
        });
        if (result) {
            alert(`回滚完成: ${(result.actions || []).length} 个操作已撤销`);
        }
    } catch (e) {
        alert('回滚失败: ' + e.message);
    }
}

function dismissRemediation() {
    const section = document.getElementById('rca-remediation-section');
    if (section) section.remove();
}

async function loadRCAHistory() {
    const data = await api('/api/rca/history');
    if (!data?.runs) return;

    const container = document.getElementById('rca-history');
    if (data.runs.length === 0) {
        container.innerHTML = '<p class="text-muted">暂无历史记录</p>';
        return;
    }

    container.innerHTML = data.runs.map(r => `
        <div class="signal-item">
            <span>
                <span class="badge badge-${r.status === 'completed' ? 'success' : r.status === 'running' ? 'warning' : 'danger'}">${r.status}</span>
                ${escapeHtml(r.query?.substring(0, 80) || '')}
            </span>
            <span class="text-muted">${formatTime(r.started_at ? r.started_at * 1000 : null)}</span>
        </div>
    `).join('');
}

// ─────────────────────────────────────────
// Daemon
// ─────────────────────────────────────────

async function loadDaemonStatus() {
    const data = await api('/api/daemon/status');
    if (!data) return;

    document.getElementById('daemon-status').innerHTML =
        data.running ? '<span class="text-success">运行中</span>' : '<span class="text-danger">已停止</span>';
    document.getElementById('daemon-uptime').textContent =
        data.uptime_s ? `${Math.floor(data.uptime_s / 60)}m ${Math.floor(data.uptime_s % 60)}s` : '-';
    document.getElementById('daemon-cycles').textContent = data.cycles ?? '-';
    document.getElementById('daemon-pipelines').textContent = data.active_pipelines ?? '-';
}

async function startDaemon() {
    await api('/api/daemon/start', { method: 'POST' });
    loadDaemonStatus();

    // Start log SSE
    if (state.daemonLogSSE) state.daemonLogSSE.close();
    const logEl = document.getElementById('daemon-log');
    logEl.textContent = '';

    state.daemonLogSSE = new EventSource('/api/daemon/logs/stream');
    state.daemonLogSSE.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'log') {
                logEl.textContent += msg.msg + '\n';
                logEl.scrollTop = logEl.scrollHeight;
            } else if (msg.type === 'status') {
                document.getElementById('daemon-cycles').textContent = msg.data?.cycles ?? '-';
                document.getElementById('daemon-pipelines').textContent = msg.data?.active_pipelines ?? '-';
            }
        } catch {}
    };
}

async function stopDaemon() {
    await api('/api/daemon/stop', { method: 'POST' });
    if (state.daemonLogSSE) { state.daemonLogSSE.close(); state.daemonLogSSE = null; }
    setTimeout(loadDaemonStatus, 1000);
}

// ─────────────────────────────────────────
// Traces (Jaeger)
// ─────────────────────────────────────────

async function loadTracesView() {
    applyTracesModeUI();
    if (isOfflineMode()) {
        const data = await api('/api/alidata/services');
        const sel = document.getElementById('trace-service');
        if (data?.services?.length) {
            const current = sel.value;
            sel.innerHTML = '<option value="">选择服务</option>' +
                data.services.filter(s => s).sort().map(s =>
                    `<option value="${s}" ${s === current ? 'selected' : ''}>${s}</option>`
                ).join('');
        } else {
            sel.innerHTML = `<option value="">离线服务不可用</option>`;
        }
        return;
    }

    // Load Jaeger services for the dropdown
    const data = await api('/api/jaeger/services');
    const sel = document.getElementById('trace-service');
    if (data?.services?.length) {
        const current = sel.value;
        sel.innerHTML = '<option value="">选择服务</option>' +
            data.services.filter(s => s).sort().map(s =>
                `<option value="${s}" ${s === current ? 'selected' : ''}>${s}</option>`
            ).join('');
    } else if (data?.error) {
        sel.innerHTML = `<option value="">Jaeger 连接失败</option>`;
        document.getElementById('trace-empty').style.display = 'block';
        document.getElementById('trace-empty').textContent = `Jaeger 连接失败: ${data.error}`;
    }
}

async function loadTraceOperations() {
    if (isOfflineMode()) {
        const sel = document.getElementById('trace-operation');
        sel.innerHTML = '<option value="">离线模式不区分操作</option>';
        return;
    }

    const service = document.getElementById('trace-service')?.value;
    const sel = document.getElementById('trace-operation');
    sel.innerHTML = '<option value="">所有操作</option>';
    if (!service) return;

    const data = await api(`/api/jaeger/operations?service=${encodeURIComponent(service)}`);
    if (data?.operations?.length) {
        sel.innerHTML += data.operations.map(op =>
            `<option value="${op}">${op}</option>`
        ).join('');
    }
}

function applyTracesModeUI() {
    const offline = isOfflineMode();
    const opSel = document.getElementById('trace-operation');
    opSel.disabled = offline;
}

async function searchTraces() {
    const service = document.getElementById('trace-service')?.value;
    if (!service) {
        alert('请先选择服务');
        return;
    }

    const operation = document.getElementById('trace-operation')?.value || '';
    const minDuration = document.getElementById('trace-min-duration')?.value || '';
    const maxDuration = document.getElementById('trace-max-duration')?.value || '';
    const lookback = document.getElementById('trace-lookback')?.value || '1h';
    const limit = document.getElementById('trace-limit')?.value || 20;

    let url = isOfflineMode()
        ? `/api/alidata/traces?service=${encodeURIComponent(service)}&lookback=${lookback}&limit=${limit}`
        : `/api/jaeger/traces?service=${encodeURIComponent(service)}&lookback=${lookback}&limit=${limit}`;
    if (operation) url += `&operation=${encodeURIComponent(operation)}`;
    if (minDuration) url += `&min_duration=${encodeURIComponent(minDuration)}`;
    if (maxDuration) url += `&max_duration=${encodeURIComponent(maxDuration)}`;

    const data = await api(url);
    renderTraceTable(data);
}

function renderTraceTable(data) {
    const tbody = document.getElementById('trace-table-body');
    const emptyEl = document.getElementById('trace-empty');
    const countEl = document.getElementById('trace-count');

    if (!data?.traces?.length) {
        tbody.innerHTML = '';
        emptyEl.style.display = 'block';
        emptyEl.textContent = data?.error ? `错误: ${data.error}` : '未找到 Trace';
        countEl.textContent = '';
        return;
    }

    emptyEl.style.display = 'none';
    countEl.textContent = `共 ${data.traces.length} 条`;

    if (isOfflineMode()) {
        tbody.innerHTML = data.traces.map(t => {
            const durationMs = (t.total_duration_us / 1000).toFixed(1);
            const shortId = t.traceID?.substring(0, 16) || '';
            const mainOp = (t.operations || [])[0] || '-';
            const services = (t.services || []).slice(0, 3).join(', ');
            const moreServices = t.services?.length > 3 ? ` +${t.services.length - 3}` : '';
            const errorRate = t.error_rate != null ? `${(t.error_rate * 100).toFixed(1)}%` : '-';
            return `
                <tr>
                    <td><code style="font-size:11px">${escapeHtml(shortId)}</code></td>
                    <td>${escapeHtml((t.services || [])[0] || '-')}</td>
                    <td>${escapeHtml(mainOp)}</td>
                    <td>${t.span_count}</td>
                    <td style="font-size:11px">${escapeHtml(services)}${moreServices}</td>
                    <td>${durationMs} ms</td>
                    <td style="font-size:11px">${errorRate}</td>
                    <td><button class="btn btn-sm" onclick="viewTraceDetail('${t.traceID}')">详情</button></td>
                </tr>
            `;
        }).join('');
        return;
    }

    tbody.innerHTML = data.traces.map(t => {
        const durationMs = (t.total_duration_us / 1000).toFixed(1);
        const startTime = t.start_time ? new Date(t.start_time / 1000).toLocaleString('zh-CN') : '-';
        const shortId = t.traceID?.substring(0, 16) || '';
        const services = (t.services || []).slice(0, 3).join(', ');
        const moreServices = t.services?.length > 3 ? ` +${t.services.length - 3}` : '';
        return `
            <tr>
                <td><code style="font-size:11px">${escapeHtml(shortId)}</code></td>
                <td>${escapeHtml(t.root_service || '-')}</td>
                <td>${escapeHtml(t.root_operation || '-')}</td>
                <td>${t.span_count}</td>
                <td style="font-size:11px">${escapeHtml(services)}${moreServices}</td>
                <td>${durationMs} ms</td>
                <td style="font-size:11px">${startTime}</td>
                <td><button class="btn btn-sm" onclick="viewTraceDetail('${t.traceID}')">详情</button></td>
            </tr>
        `;
    }).join('');
}

async function lookupTraceById() {
    const traceId = document.getElementById('trace-id-input')?.value?.trim();
    if (!traceId) {
        alert('请输入 Trace ID');
        return;
    }
    await viewTraceDetail(traceId);
}

async function viewTraceDetail(traceId) {
    if (isOfflineMode()) {
        return viewOfflineTraceDetail(traceId);
    }

    const card = document.getElementById('trace-detail-card');
    const content = document.getElementById('trace-detail-content');
    card.style.display = 'block';
    content.innerHTML = '<p class="text-muted">加载中...</p>';

    const data = await api(`/api/jaeger/trace/${traceId}`);
    if (!data || data.error) {
        content.innerHTML = `<p class="text-danger">加载失败: ${data?.error || '未知错误'}</p>`;
        return;
    }

    // Render trace timeline
    const spans = data.spans || [];
    if (!spans.length) {
        content.innerHTML = '<p class="text-muted">无 Span 数据</p>';
        return;
    }

    // Find time range
    const minStart = Math.min(...spans.map(s => s.startTime || Infinity));
    const maxEnd = Math.max(...spans.map(s => (s.startTime || 0) + (s.duration_us || 0)));
    const totalRange = maxEnd - minStart || 1;

    content.innerHTML = `
        <div style="margin-bottom:12px">
            <strong>Trace ID:</strong> <code>${escapeHtml(traceId)}</code>
            &nbsp; <strong>Span数:</strong> ${spans.length}
            &nbsp; <strong>总耗时:</strong> ${((maxEnd - minStart) / 1000).toFixed(1)} ms
        </div>
        <div class="trace-timeline">
            ${spans.map(s => {
                const left = ((s.startTime - minStart) / totalRange * 100).toFixed(2);
                const width = Math.max((s.duration_us / totalRange * 100), 0.5).toFixed(2);
                const dMs = (s.duration_us / 1000).toFixed(1);
                const hasError = s.tags?.['error'] === true || s.tags?.['otel.status_code'] === 'ERROR';
                const barColor = hasError ? 'var(--danger)' : 'var(--accent)';
                return `
                    <div class="trace-span-row" style="display:flex;align-items:center;gap:8px;margin-bottom:2px;font-size:11px">
                        <span style="min-width:120px;text-align:right;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                              title="${escapeHtml(s.serviceName)}">${escapeHtml(s.serviceName)}</span>
                        <span style="min-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                              title="${escapeHtml(s.operationName)}">${escapeHtml(s.operationName)}</span>
                        <div style="flex:1;position:relative;height:14px;background:var(--bg-secondary,#1e1e2e);border-radius:3px">
                            <div style="position:absolute;left:${left}%;width:${width}%;height:100%;background:${barColor};border-radius:3px;min-width:2px"
                                 title="${dMs} ms"></div>
                        </div>
                        <span style="min-width:60px;text-align:right">${dMs} ms</span>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

async function viewOfflineTraceDetail(traceId) {
    const card = document.getElementById('trace-detail-card');
    const content = document.getElementById('trace-detail-content');
    card.style.display = 'block';
    content.innerHTML = '<p class="text-muted">加载中...</p>';

    const data = await api(`/api/alidata/trace/${traceId}`);
    if (!data || data.error) {
        content.innerHTML = `<p class="text-danger">加载失败: ${data?.error || '未知错误'}</p>`;
        return;
    }

    const traces = data.traces || [];
    if (!traces.length) {
        content.innerHTML = '<p class="text-muted">无 Trace 数据</p>';
        return;
    }

    const trace = traces[0];
    const services = trace.services || [];
    const operations = trace.operations || [];
    const endpoints = trace.endpoints || [];
    const errorSpans = trace.error_spans || [];
    const statusDist = trace.http_status_distribution || {};
    const durationMs = (trace.total_duration_us / 1000).toFixed(1);
    const errorRate = trace.error_rate != null ? `${(trace.error_rate * 100).toFixed(1)}%` : '-';

    let html = `
        <div style="margin-bottom:12px">
            <strong>Trace ID:</strong> <code>${escapeHtml(traceId)}</code>
            &nbsp; <strong>Span数:</strong> ${trace.span_count}
            &nbsp; <strong>总耗时:</strong> ${durationMs} ms
            &nbsp; <strong>错误率:</strong> <span class="${trace.error_rate > 0 ? 'text-danger' : ''}">${errorRate}</span>
        </div>`;

    html += `<div style="margin-bottom:8px">
        <strong>涉及服务:</strong> ${services.map(s => `<span class="badge badge-info" style="margin:2px">${escapeHtml(s)}</span>`).join(' ')}
    </div>`;

    if (operations.length) {
        html += `<div style="margin-bottom:8px">
            <strong>操作:</strong> ${operations.slice(0, 10).map(o => `<span class="badge badge-gray" style="margin:2px">${escapeHtml(o)}</span>`).join(' ')}
        </div>`;
    }

    if (Object.keys(statusDist).length) {
        html += `<div style="margin-bottom:8px">
            <strong>HTTP状态分布:</strong> ${Object.entries(statusDist).map(([code, cnt]) => {
                const cls = code.startsWith('2') ? 'success' : code.startsWith('4') ? 'warning' : code.startsWith('5') ? 'danger' : 'info';
                return `<span class="badge badge-${cls}" style="margin:2px">${code}: ${cnt}</span>`;
            }).join(' ')}
        </div>`;
    }

    if (errorSpans.length) {
        html += `<div style="margin-top:12px">
            <h4 style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">错误 Spans</h4>
            <table class="data-table">
                <thead><tr><th>服务</th><th>操作</th><th>状态码</th><th>耗时</th><th>URL</th></tr></thead>
                <tbody>${errorSpans.map(es => `
                    <tr>
                        <td>${escapeHtml(es.service || '')}</td>
                        <td>${escapeHtml(es.operation || '')}</td>
                        <td><span class="badge badge-danger">${es.status_code}</span></td>
                        <td>${es.duration_ms} ms</td>
                        <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                            title="${escapeHtml(es.url || '')}">${escapeHtml(es.url || '-')}</td>
                    </tr>
                `).join('')}</tbody>
            </table>
        </div>`;
    }

    if (endpoints.length) {
        html += `<details style="margin-top:12px;font-size:12px">
            <summary style="cursor:pointer;color:var(--text-muted)">查看请求端点 (${endpoints.length})</summary>
            <div style="margin-top:6px">
                ${endpoints.map(ep => `<div class="signal-item" style="font-size:11px">${escapeHtml(ep)}</div>`).join('')}
            </div>
        </details>`;
    }

    content.innerHTML = html;
}

// ─────────────────────────────────────────
// AliData (Alibaba Cloud Logs & Traces & Metrics)
// ─────────────────────────────────────────

let _alidataRefreshTimer = null;
const _alidataCharts = {};  // canvasId -> Chart instance

const CHART_COLORS = [
    '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#38bdf8',
    '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6',
    '#06b6d4', '#84cc16', '#e11d48', '#0ea5e9', '#d946ef',
];

async function loadAliDataView() {
    const [statusData, servicesData] = await Promise.all([
        api('/api/alidata/status'),
        api('/api/alidata/services'),
    ]);

    if (statusData) {
        document.getElementById('alidata-conn-status').innerHTML = statusData.connected
            ? '<span class="text-success">已连接</span>' : '<span class="text-danger">未连接</span>';
        document.getElementById('alidata-log-status').innerHTML = statusData.log_ok
            ? '<span class="text-success">正常</span>' : '<span class="text-danger">异常</span>';
        document.getElementById('alidata-trace-status').innerHTML = statusData.trace_ok
            ? '<span class="text-success">正常</span>' : '<span class="text-danger">异常</span>';
    }

    if (servicesData?.services?.length) {
        const services = servicesData.services.filter(s => s).sort();
        const traceSel = document.getElementById('alidata-trace-service');
        const traceCur = traceSel.value;
        traceSel.innerHTML = '<option value="">选择服务</option>' +
            services.map(s => `<option value="${s}" ${s === traceCur ? 'selected' : ''}>${s}</option>`).join('');
        const metricSel = document.getElementById('alidata-metric-service');
        if (metricSel) {
            const metricCur = metricSel.value;
            metricSel.innerHTML = '<option value="">所有服务</option>' +
                services.map(s => `<option value="${s}" ${s === metricCur ? 'selected' : ''}>${s}</option>`).join('');
        }
    }

    loadAliDataMetrics();
    setAliDataAutoRefresh();
}

function setAliDataAutoRefresh() {
    if (_alidataRefreshTimer) { clearInterval(_alidataRefreshTimer); _alidataRefreshTimer = null; }
    const interval = parseInt(document.getElementById('alidata-refresh-interval')?.value || '0');
    if (interval > 0) {
        _alidataRefreshTimer = setInterval(() => {
            if (state.currentView === 'alidata') loadAliDataMetrics();
        }, interval * 1000);
    }
}

async function loadAliDataMetrics() {
    const emptyEl = document.getElementById('alidata-metrics-empty');
    if (emptyEl) emptyEl.textContent = '加载中...';

    const data = await api('/api/alidata/metrics');
    if (!data || data.error) {
        if (emptyEl) { emptyEl.style.display = 'block'; emptyEl.textContent = `错误: ${data?.error || '请求失败'}`; }
        return;
    }

    const filterSvc = document.getElementById('alidata-metric-service')?.value || '';
    const k8s = data.k8s_metrics || {};
    const apm = data.apm_metrics || {};

    // ── K8s CPU & Memory Charts ──
    const cpuDatasets = [];
    const memDatasets = [];
    let colorIdx = 0;

    for (const [svc, pods] of Object.entries(k8s)) {
        if (filterSvc && svc !== filterSvc) continue;
        for (const [pod, metrics] of Object.entries(pods)) {
            const cpuData = metrics['pod_cpu_usage_rate'];
            const memData = metrics['pod_memory_working_set_bytes'] || metrics['pod_memory_usage_bytes'];
            const shortPod = pod.length > 25 ? pod.substring(0, 23) + '..' : pod;
            const color = CHART_COLORS[colorIdx % CHART_COLORS.length];

            if (cpuData?.values?.length) {
                cpuDatasets.push({
                    label: shortPod,
                    data: cpuData.values.map(v => ({ x: v[0] * 1000, y: parseFloat(v[1]) })),
                    borderColor: color, backgroundColor: color + '20',
                    borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false,
                });
            }
            if (memData?.values?.length) {
                memDatasets.push({
                    label: shortPod,
                    data: memData.values.map(v => ({ x: v[0] * 1000, y: parseFloat(v[1]) / (1024 * 1024) })),
                    borderColor: color, backgroundColor: color + '20',
                    borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false,
                });
            }
            colorIdx++;
        }
    }

    renderChart('chart-k8s-cpu', 'Pod CPU 使用率 (%)', cpuDatasets, '%');
    renderChart('chart-k8s-mem', 'Pod 内存使用 (MB)', memDatasets, 'MB');

    // ── APM Charts ──
    const reqDatasets = [];
    const latDatasets = [];
    colorIdx = 0;

    for (const [svc, metrics] of Object.entries(apm)) {
        if (filterSvc && svc !== filterSvc) continue;
        const reqData = metrics['request_count'];
        const latData = metrics['avg_request_latency_seconds'];
        const color = CHART_COLORS[colorIdx % CHART_COLORS.length];

        if (reqData?.values?.length) {
            reqDatasets.push({
                label: svc,
                data: reqData.values.map(v => ({ x: v[0] * 1000, y: parseFloat(v[1]) })),
                borderColor: color, backgroundColor: color + '30',
                borderWidth: 2, pointRadius: 1, tension: 0.3, fill: true,
            });
        }
        if (latData?.values?.length) {
            latDatasets.push({
                label: svc,
                data: latData.values.map(v => ({ x: v[0] * 1000, y: parseFloat(v[1]) * 1000 })),
                borderColor: color, backgroundColor: color + '20',
                borderWidth: 2, pointRadius: 1, tension: 0.3, fill: false,
            });
        }
        colorIdx++;
    }

    renderChart('chart-apm-requests', '服务请求量 (req/30s)', reqDatasets, '');
    renderChart('chart-apm-latency', '平均延迟 (ms)', latDatasets, 'ms');

    // ── APM Summary Table ──
    const apmBody = document.getElementById('alidata-apm-body');
    const apmEntries = Object.entries(apm).filter(([svc]) => !filterSvc || svc === filterSvc);
    if (apmEntries.length) {
        apmBody.innerHTML = apmEntries.sort((a, b) =>
            (b[1]?.request_count?.current || 0) - (a[1]?.request_count?.current || 0)
        ).map(([svc, metrics]) => {
            const reqCount = metrics.request_count?.current || 0;
            const latency = metrics.avg_request_latency_seconds?.current || 0;
            const latencyMs = (latency * 1000).toFixed(1);
            const latencyClass = latency > 1 ? 'text-danger' : latency > 0.5 ? 'text-warning' : '';
            return `<tr>
                <td><strong>${escapeHtml(svc)}</strong></td>
                <td>${reqCount.toFixed(0)}</td>
                <td class="${latencyClass}">${latency > 0 ? latency.toFixed(4) + ' (' + latencyMs + 'ms)' : '-'}</td>
            </tr>`;
        }).join('');
        if (emptyEl) emptyEl.style.display = 'none';
    } else if (cpuDatasets.length || memDatasets.length) {
        apmBody.innerHTML = '<tr><td colspan="3" class="text-muted" style="text-align:center">暂无 APM 数据</td></tr>';
        if (emptyEl) emptyEl.style.display = 'none';
    } else {
        if (emptyEl) { emptyEl.style.display = 'block'; emptyEl.textContent = '暂无指标数据'; }
    }
}

function renderChart(canvasId, title, datasets, unit) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (_alidataCharts[canvasId]) { _alidataCharts[canvasId].destroy(); delete _alidataCharts[canvasId]; }
    if (!datasets.length) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#5b5f73'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('暂无数据', canvas.width / 2, canvas.height / 2);
        return;
    }
    _alidataCharts[canvasId] = new Chart(canvas, {
        type: 'line', data: { datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                title: { display: true, text: title, color: '#8b8fa3', font: { size: 13, weight: '600' } },
                legend: { display: datasets.length <= 8, position: 'bottom',
                    labels: { color: '#8b8fa3', font: { size: 10 }, boxWidth: 12, padding: 8 } },
                tooltip: { backgroundColor: '#1e2130', titleColor: '#e4e6ef', bodyColor: '#8b8fa3',
                    borderColor: '#2a2d3e', borderWidth: 1,
                    callbacks: {
                        title: function(ctx) { return ctx[0] ? new Date(ctx[0].parsed.x).toLocaleTimeString('zh-CN') : ''; },
                        label: function(ctx) { return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + (unit ? ' ' + unit : ''); }
                    }
                },
            },
            scales: {
                x: { type: 'linear',
                    ticks: { color: '#5b5f73', font: { size: 10 },
                        callback: function(val) { return new Date(val).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); },
                        maxTicksLimit: 8 },
                    grid: { color: '#2a2d3e' } },
                y: { ticks: { color: '#5b5f73', font: { size: 10 },
                        callback: function(val) { return val.toFixed(1) + (unit ? ' ' + unit : ''); } },
                    grid: { color: '#2a2d3e' }, beginAtZero: true },
            },
        },
    });
}

async function loadAliDataLogs() {
    const query = document.getElementById('alidata-log-query')?.value?.trim() || '';
    const level = document.getElementById('alidata-log-level')?.value || '';
    const timeRange = document.getElementById('alidata-log-timerange')?.value || '1h';
    const ns = document.getElementById('alidata-log-ns')?.value?.trim() || '';
    const size = document.getElementById('alidata-log-size')?.value || 200;

    const tbody = document.getElementById('alidata-log-body');
    const emptyEl = document.getElementById('alidata-log-empty');
    const statsEl = document.getElementById('alidata-log-stats');

    tbody.innerHTML = '';
    emptyEl.style.display = 'block';
    emptyEl.textContent = '加载中...';

    let url = `/api/alidata/logs?time_range=${timeRange}&size=${size}`;
    if (query) url += `&query=${encodeURIComponent(query)}`;
    if (level) url += `&level=${encodeURIComponent(level)}`;
    if (ns) url += `&namespace=${encodeURIComponent(ns)}`;

    const data = await api(url);

    if (!data || data.error) {
        emptyEl.textContent = `错误: ${data?.error || '请求失败'}`;
        statsEl.innerHTML = '';
        return;
    }

    const entries = data.entries || [];
    if (!entries.length) {
        emptyEl.textContent = '未找到日志';
        statsEl.innerHTML = `<span class="badge badge-gray">共 0 条</span>`;
        return;
    }

    emptyEl.style.display = 'none';

    // Stats
    const levelCounts = {};
    entries.forEach(e => { levelCounts[e.level] = (levelCounts[e.level] || 0) + 1; });
    statsEl.innerHTML = `<span class="badge badge-info">共 ${entries.length} 条</span> ` +
        Object.entries(levelCounts).map(([lv, cnt]) => {
            const cls = lv === 'error' ? 'danger' : lv === 'warn' ? 'warning' : 'info';
            return `<span class="badge badge-${cls}">${lv}: ${cnt}</span>`;
        }).join(' ');

    // Render table
    tbody.innerHTML = entries.map(e => {
        const lvCls = e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warning' : 'info';
        const ts = e.timestamp ? formatTime(
            typeof e.timestamp === 'number' && e.timestamp < 2e10
                ? e.timestamp * 1000 : e.timestamp
        ) : '-';
        return `<tr>
            <td style="white-space:nowrap;font-size:11px">${ts}</td>
            <td><span class="badge badge-${lvCls}">${e.level}</span></td>
            <td>${escapeHtml(e.service || '-')}</td>
            <td style="font-size:11px">${escapeHtml(e.pod || '-')}</td>
            <td style="font-size:11px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                title="${escapeHtml(e.message || '')}">${escapeHtml(e.message || '')}</td>
        </tr>`;
    }).join('');
}

async function searchAliDataTraces() {
    const service = document.getElementById('alidata-trace-service')?.value;
    if (!service) { alert('请先选择服务'); return; }

    const lookback = document.getElementById('alidata-trace-lookback')?.value || '1h';
    const limit = document.getElementById('alidata-trace-limit')?.value || 20;

    const tbody = document.getElementById('alidata-trace-body');
    const emptyEl = document.getElementById('alidata-trace-empty');
    tbody.innerHTML = '';
    emptyEl.style.display = 'block';
    emptyEl.textContent = '搜索中...';

    const data = await api(`/api/alidata/traces?service=${encodeURIComponent(service)}&lookback=${lookback}&limit=${limit}`);

    if (!data?.traces?.length) {
        emptyEl.textContent = data?.error ? `错误: ${data.error}` : '未找到 Trace';
        return;
    }

    emptyEl.style.display = 'none';

    tbody.innerHTML = data.traces.map(t => {
        const durationMs = (t.total_duration_us / 1000).toFixed(1);
        const shortId = t.traceID?.substring(0, 16) || '';
        const services = (t.services || []).slice(0, 3).join(', ');
        const moreServices = t.services?.length > 3 ? ` +${t.services.length - 3}` : '';
        const errorRate = t.error_rate != null ? `${(t.error_rate * 100).toFixed(1)}%` : '-';
        const errorCls = t.error_rate > 0 ? 'text-danger' : '';
        return `<tr>
            <td><code style="font-size:11px">${escapeHtml(shortId)}</code></td>
            <td>${t.span_count}</td>
            <td style="font-size:11px">${escapeHtml(services)}${moreServices}</td>
            <td>${durationMs} ms</td>
            <td class="${errorCls}">${errorRate}</td>
            <td><button class="btn btn-sm" onclick="viewAliDataTraceDetail('${t.traceID}')">详情</button></td>
        </tr>`;
    }).join('');
}

async function lookupAliDataTraceById() {
    const traceId = document.getElementById('alidata-trace-id-input')?.value?.trim();
    if (!traceId) { alert('请输入 Trace ID'); return; }
    await viewAliDataTraceDetail(traceId);
}

async function viewAliDataTraceDetail(traceId) {
    const card = document.getElementById('alidata-trace-detail-card');
    const content = document.getElementById('alidata-trace-detail-content');
    card.style.display = 'block';
    content.innerHTML = '<p class="text-muted">加载中...</p>';

    const data = await api(`/api/alidata/trace/${traceId}`);

    if (!data || data.error) {
        content.innerHTML = `<p class="text-danger">加载失败: ${data?.error || '未知错误'}</p>`;
        return;
    }

    const traces = data.traces || [];
    if (!traces.length) {
        content.innerHTML = '<p class="text-muted">无 Trace 数据</p>';
        return;
    }

    const trace = traces[0];
    const services = trace.services || [];
    const operations = trace.operations || [];
    const endpoints = trace.endpoints || [];
    const errorSpans = trace.error_spans || [];
    const statusDist = trace.http_status_distribution || {};
    const durationMs = (trace.total_duration_us / 1000).toFixed(1);
    const errorRate = trace.error_rate != null ? `${(trace.error_rate * 100).toFixed(1)}%` : '-';

    let html = `
        <div style="margin-bottom:12px">
            <strong>Trace ID:</strong> <code>${escapeHtml(traceId)}</code>
            &nbsp; <strong>Span数:</strong> ${trace.span_count}
            &nbsp; <strong>总耗时:</strong> ${durationMs} ms
            &nbsp; <strong>错误率:</strong> <span class="${trace.error_rate > 0 ? 'text-danger' : ''}">${errorRate}</span>
        </div>`;

    // Services
    html += `<div style="margin-bottom:8px">
        <strong>涉及服务:</strong> ${services.map(s => `<span class="badge badge-info" style="margin:2px">${escapeHtml(s)}</span>`).join(' ')}
    </div>`;

    // Operations
    if (operations.length) {
        html += `<div style="margin-bottom:8px">
            <strong>操作:</strong> ${operations.slice(0, 10).map(o => `<span class="badge badge-gray" style="margin:2px">${escapeHtml(o)}</span>`).join(' ')}
        </div>`;
    }

    // HTTP Status Distribution
    if (Object.keys(statusDist).length) {
        html += `<div style="margin-bottom:8px">
            <strong>HTTP状态分布:</strong> ${Object.entries(statusDist).map(([code, cnt]) => {
                const cls = code.startsWith('2') ? 'success' : code.startsWith('4') ? 'warning' : code.startsWith('5') ? 'danger' : 'info';
                return `<span class="badge badge-${cls}" style="margin:2px">${code}: ${cnt}</span>`;
            }).join(' ')}
        </div>`;
    }

    // Error Spans
    if (errorSpans.length) {
        html += `<div style="margin-top:12px">
            <h4 style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">错误 Spans</h4>
            <table class="data-table">
                <thead><tr><th>服务</th><th>操作</th><th>状态码</th><th>耗时</th><th>URL</th></tr></thead>
                <tbody>${errorSpans.map(es => `
                    <tr>
                        <td>${escapeHtml(es.service || '')}</td>
                        <td>${escapeHtml(es.operation || '')}</td>
                        <td><span class="badge badge-danger">${es.status_code}</span></td>
                        <td>${es.duration_ms} ms</td>
                        <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                            title="${escapeHtml(es.url || '')}">${escapeHtml(es.url || '-')}</td>
                    </tr>
                `).join('')}</tbody>
            </table>
        </div>`;
    }

    // Endpoints
    if (endpoints.length) {
        html += `<details style="margin-top:12px;font-size:12px">
            <summary style="cursor:pointer;color:var(--text-muted)">查看请求端点 (${endpoints.length})</summary>
            <div style="margin-top:6px">
                ${endpoints.map(ep => `<div class="signal-item" style="font-size:11px">${escapeHtml(ep)}</div>`).join('')}
            </div>
        </details>`;
    }

    content.innerHTML = html;
}

// ─────────────────────────────────────────
// Events
// ─────────────────────────────────────────

async function loadEvents() {
    if (isOfflineMode()) {
        const tbody = document.querySelector('#event-table tbody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="text-align:center">离线模式下无事件数据</td></tr>';
        }
        return;
    }

    const ns = document.getElementById('event-ns')?.value || '';
    const data = await api(`/api/cluster/events?namespace=${ns}&limit=100`);
    if (!data?.events) return;

    const tbody = document.querySelector('#event-table tbody');
    tbody.innerHTML = data.events.map(e => `
        <tr>
            <td><span class="badge badge-${e.type === 'Warning' ? 'warning' : 'info'}">${e.type}</span></td>
            <td>${escapeHtml(e.reason)}</td>
            <td>${escapeHtml(e.object)}</td>
            <td>${escapeHtml(e.message?.substring(0, 120) || '')}</td>
            <td>${e.count}</td>
            <td>${formatTime(e.last_seen)}</td>
        </tr>
    `).join('');
}

// ─────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────

async function healthCheck() {
    const data = await api('/api/health');
    const prevOffline = state.runtime.offlineMode;
    const prevProblemId = state.runtime.offlineProblemId;
    const prevDataType = state.runtime.offlineDataType;
    const dot = document.querySelector('#health-dot .dot');
    const text = document.querySelector('#health-dot span:last-child');
    const badge = document.getElementById('cluster-badge');
    const llmWarning = document.getElementById('llm-warning');
    const eventsNav = document.querySelector('.nav-item[data-view="events"]');

    if (data) {
        state.runtime.offlineMode = !!data.offline_mode;
        state.runtime.observabilityBackend = data.observability_backend || 'native';
        state.runtime.offlineProblemId = data.offline_problem_id || '';
        state.runtime.offlineDataType = data.offline_data_type || '';
    }

    await syncOfflineProblemSwitcher(prevOffline !== state.runtime.offlineMode);

    if (data?.status === 'ok') {
        dot.className = 'dot dot-green';
        text.textContent = isOfflineMode() ? '离线模式' : '系统正常';
        badge.className = 'badge badge-success';
        badge.textContent = isOfflineMode() ? `离线: ${currentOfflineLabel()}` : '已连接';
        document.getElementById('view-title').textContent = getViewTitle(state.currentView);
        if (eventsNav) eventsNav.style.display = isOfflineMode() ? 'none' : '';
        if (isOfflineMode() && state.currentView === 'events') {
            switchView('overview');
            return;
        }

        // LLM API Key check
        if (llmWarning) {
            llmWarning.style.display = data.llm_configured ? 'none' : 'flex';
        }
    } else {
        dot.className = 'dot dot-red';
        text.textContent = '连接异常';
        badge.className = 'badge badge-danger';
        badge.textContent = '连接异常';
    }

    if (
        prevOffline !== state.runtime.offlineMode
        || prevProblemId !== state.runtime.offlineProblemId
        || prevDataType !== state.runtime.offlineDataType
    ) {
        refreshCurrentView();
    }
}
