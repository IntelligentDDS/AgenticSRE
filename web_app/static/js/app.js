/* ═════════════════════════════════════════════
   AgenticSRE Dashboard — Main SPA Logic
   ═════════════════════════════════════════════ */

// ── State ──
const state = {
    currentView: 'overview',
    refreshTimer: null,
    refreshInterval: 10,
    sseConnections: {},
    rcaRunId: null,
    daemonLogSSE: null,
    detectionSSE: null,
    podChart: null,
};

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initRefresh();
    loadOverview();
    healthCheck();
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

function switchView(viewId) {
    // Update nav
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-view="${viewId}"]`)?.classList.add('active');

    // Update content
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.getElementById(`view-${viewId}`)?.classList.add('active');

    // Update title
    const titles = {
        overview: '集群概览', metrics: '指标监控', logs: '日志查询',
        alerts: '告警中心', rca: '根因分析', traces: '链路追踪',
        daemon: '守护进程', events: '事件追踪'
    };
    document.getElementById('view-title').textContent = titles[viewId] || viewId;

    state.currentView = viewId;
    refreshCurrentView();
}

function refreshCurrentView() {
    const loaders = {
        overview: loadOverview,
        metrics: loadMetrics,
        logs: () => loadNamespaces('log-ns'),
        alerts: () => { loadAlertList(); loadDetectionConfig(); },
        rca: loadRCAHistory,
        traces: loadTracesView,
        daemon: loadDaemonStatus,
        events: () => { Promise.all([loadNamespaces('event-ns'), loadEvents()]); },
    };
    (loaders[state.currentView] || (() => {}))();
}

// ── Auto-Refresh ──

function initRefresh() {
    document.getElementById('refresh-interval').addEventListener('change', (e) => {
        state.refreshInterval = parseInt(e.target.value);
        clearInterval(state.refreshTimer);
        if (state.refreshInterval > 0) {
            state.refreshTimer = setInterval(refreshCurrentView, state.refreshInterval * 1000);
        }
    });
    // Start default
    state.refreshTimer = setInterval(refreshCurrentView, 10000);
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

// ─────────────────────────────────────────
// Overview
// ─────────────────────────────────────────

async function loadOverview() {
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

function renderMetricBars(containerId, data, unit) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const results = data?.results || [];
    if (!results.length) {
        el.innerHTML = '<p class="text-muted" style="padding:8px">暂无数据</p>';
        return;
    }

    el.innerHTML = results.map(r => {
        const label = r.metric?.instance || r.metric?.node || Object.values(r.metric || {})[0] || 'unknown';
        const shortLabel = label.replace(/:.*$/, '');
        const val = parseFloat(r.value?.[1] || 0).toFixed(1);
        const pct = Math.min(parseFloat(val), 100);
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
        const pod = r.metric?.pod || 'unknown';
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
    const data = await api('/api/cluster/namespaces');
    if (!data?.namespaces) return;

    const sel = document.getElementById(selectId);
    const current = sel.value;
    sel.innerHTML = '<option value="">选择命名空间</option>' +
        data.namespaces.map(ns => `<option value="${ns}" ${ns === current ? 'selected' : ''}>${ns}</option>`).join('');
}

async function loadPodsByNs() {
    const ns = document.getElementById('log-ns').value;
    if (!ns) return;

    const data = await api(`/api/cluster/pods?namespace=${ns}`);
    if (!data?.pods) return;

    const sel = document.getElementById('log-pod');
    sel.innerHTML = '<option value="">选择Pod</option>' +
        data.pods.map(p => `<option value="${p.name}">${p.name} (${p.phase})</option>`).join('');
}

async function fetchLogs() {
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

    let url = `/api/jaeger/traces?service=${encodeURIComponent(service)}&lookback=${lookback}&limit=${limit}`;
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

// ─────────────────────────────────────────
// Events
// ─────────────────────────────────────────

async function loadEvents() {
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
    const dot = document.querySelector('#health-dot .dot');
    const text = document.querySelector('#health-dot span:last-child');
    const badge = document.getElementById('cluster-badge');
    const llmWarning = document.getElementById('llm-warning');

    if (data?.status === 'ok') {
        dot.className = 'dot dot-green';
        text.textContent = '系统正常';
        badge.className = 'badge badge-success';
        badge.textContent = '已连接';

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
}
