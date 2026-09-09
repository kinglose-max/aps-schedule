/* ===== fr-query/public/casting-schedule.js — 铸造排程前端 ===== */

const state = {
    strategies: [],
    currentStrategy: '',
    summary: [],
    tasks: [],
    dailyDetail: [],
    dailySummary: [],
    unscheduled: [],
    teamFilter: '',
    dateFrom: '',
    dateTo: ''
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, options = {}) {
    const res = await fetch(path, options);
    if (res.status === 401) {
        location.href = '/login.html?returnUrl=' + encodeURIComponent(location.pathname);
        return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function loadStrategies() {
    const data = await api('/casting-schedule/strategies');
    if (!data) return;
    state.strategies = data.data;
    renderStrategyTabs();
    updateEstimateStrategyOptions();
    if (state.strategies.length) {
        selectStrategy(state.strategies[0]);
    }
}

function updateEstimateStrategyOptions() {
    const select = $('#estStrategy');
    const current = select.value;
    select.innerHTML = '<option value="">不考虑现有负荷</option>' +
        state.strategies.map(s => `<option value="${s}">${s}</option>`).join('');
    if (current && state.strategies.includes(current)) select.value = current;
}

async function loadStrategyData(strategy) {
    const [sumRes, taskRes, dailyRes, detailRes] = await Promise.all([
        api('/casting-schedule/summary'),
        api('/casting-schedule/detail?strategy=' + encodeURIComponent(strategy)),
        api('/casting-schedule/daily-summary?strategy=' + encodeURIComponent(strategy)),
        api('/casting-schedule/daily-detail?strategy=' + encodeURIComponent(strategy))
    ]);
    state.summary = sumRes.data.find(s => s['策略'] === strategy) || {};
    state.tasks = taskRes.data;
    state.dailySummary = dailyRes.data;
    state.dailyDetail = detailRes.data;
    state.currentStrategy = strategy;
    updateTeamFilterOptions();
    renderAll();
}

async function loadUnscheduled() {
    const data = await api('/casting-schedule/unscheduled');
    if (!data) return;
    state.unscheduled = data.data;
    renderUnscheduledTable();
}

function renderStrategyTabs() {
    const container = $('#strategyTabs');
    container.innerHTML = state.strategies.map(s => `
        <button class="strategy-tab ${s === state.currentStrategy ? 'active' : ''}" data-strategy="${s}">${s}</button>
    `).join('');
    $$('.strategy-tab').forEach(btn => {
        btn.addEventListener('click', () => selectStrategy(btn.dataset.strategy));
    });
}

function selectStrategy(strategy) {
    state.currentStrategy = strategy;
    renderStrategyTabs();
    loadStrategyData(strategy);
}

function fmtNum(n) {
    if (n === undefined || n === null) return '-';
    return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function translateStatus(v) {
    const map = {
        'OPTIMAL': '已证明最优',
        'FEASIBLE': '可行解',
        'INFEASIBLE': '无可行解',
        'MODEL_INVALID': '模型无效',
        'UNKNOWN': '未知'
    };
    return map[v] || v;
}

function translateLabel(k) {
    const map = {
        'makespan_天': '总工期 天',
        '目标值': 'OR-Tools 目标值',
        '求解状态': '求解状态'
    };
    return map[k] || k;
}

function renderSummaryCards() {
    const s = state.summary;
    const status = translateStatus(s['求解状态']);
    const statusCls = s['求解状态'] === 'OPTIMAL' ? 'success' : (s['求解状态'] === 'FEASIBLE' ? '' : 'danger');
    const cards = [
        { label: '任务数', value: s['任务数'] },
        { label: '总重量 kg', value: fmtNum(s['总重量kg']) },
        { label: '总逾期天数', value: s['总逾期天数'], cls: s['总逾期天数'] > 0 ? 'danger' : 'success' },
        { label: '最大逾期天数', value: s['最大逾期天数'], cls: s['最大逾期天数'] > 0 ? 'danger' : 'success' },
        { label: translateLabel('makespan_天'), value: s['makespan_天'] },
        { label: '最大班组负荷 kg', value: fmtNum(s['负荷最大班组kg']) },
        { label: '最小班组负荷 kg', value: fmtNum(s['负荷最小班组kg']) },
        { label: translateLabel('目标值'), value: fmtNum(s['目标值']) },
        { label: translateLabel('求解状态'), value: status, cls: statusCls },
    ];
    $('#summaryCards').innerHTML = cards.map(c => `
        <div class="card">
            <div class="card-label">${c.label}</div>
            <div class="card-value ${c.cls || ''}">${c.value}</div>
        </div>
    `).join('');
}

function renderCharts() {
    renderLoadChart();
    renderUtilChart();
}

function renderLoadChart() {
    const byTeam = {};
    state.tasks.forEach(t => {
        byTeam[t['班组']] = (byTeam[t['班组']] || 0) + (t['重量kg'] || 0);
    });
    const chart = echarts.init($('#loadChart'));
    chart.setOption({
        tooltip: { trigger: 'item', formatter: '{b}: {c} kg ({d}%)' },
        legend: { bottom: 0 },
        series: [{
            type: 'pie',
            radius: ['40%', '70%'],
            data: Object.entries(byTeam).map(([name, value]) => ({ name, value: Math.round(value) }))
        }]
    });
}

function renderUtilChart() {
    const rows = filteredDailySummary();
    const dates = [...new Set(rows.map(r => r['日期']))].sort();
    const teams = [...new Set(rows.map(r => r['班组']))].sort();
    const series = teams.map(team => ({
        name: team,
        type: 'line',
        smooth: true,
        data: dates.map(d => {
            const r = rows.find(x => x['日期'] === d && x['班组'] === team);
            return r ? r['利用率%'] : null;
        })
    }));
    const chart = echarts.init($('#utilChart'));
    chart.setOption({
        tooltip: { trigger: 'axis' },
        legend: { data: teams, bottom: 0 },
        grid: { left: '3%', right: '4%', bottom: '15%', top: '10%', containLabel: true },
        xAxis: { type: 'category', data: dates },
        yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
        series
    });
}

function filteredTasks() {
    return state.tasks.filter(t => {
        if (state.teamFilter && t['班组'] !== state.teamFilter) return false;
        if (state.dateFrom && t['结束日期'] < state.dateFrom) return false;
        if (state.dateTo && t['开始日期'] > state.dateTo) return false;
        return true;
    });
}

function filteredDailySummary() {
    return state.dailySummary.filter(r => {
        if (state.teamFilter && r['班组'] !== state.teamFilter) return false;
        if (state.dateFrom && r['日期'] < state.dateFrom) return false;
        if (state.dateTo && r['日期'] > state.dateTo) return false;
        return true;
    });
}

function filteredDailyDetail() {
    return state.dailyDetail.filter(r => {
        if (state.teamFilter && r['班组'] !== state.teamFilter) return false;
        if (state.dateFrom && r['日期'] < state.dateFrom) return false;
        if (state.dateTo && r['日期'] > state.dateTo) return false;
        return true;
    });
}

function renderTable(id, rows, columns, formatters = {}) {
    const thead = $(`#${id} thead`);
    const tbody = $(`#${id} tbody`);
    thead.innerHTML = '<tr>' + columns.map(c => `<th>${c.label}</th>`).join('') + '</tr>';
    tbody.innerHTML = rows.slice(0, 2000).map(row => {
        return '<tr>' + columns.map(c => {
            let v = row[c.key];
            if (formatters[c.key]) v = formatters[c.key](v, row);
            return `<td class="${c.right ? 'text-right' : ''}">${v ?? ''}</td>`;
        }).join('') + '</tr>';
    }).join('');
}

function renderTaskTable() {
    const rows = filteredTasks();
    renderTable('taskTable', rows, [
        { label: '工单', key: '工单' },
        { label: '班组', key: '班组' },
        { label: '毛坯品号', key: '毛坯品号' },
        { label: '毛坯品名', key: '毛坯品名' },
        { label: '规格', key: '规格' },
        { label: '数量', key: '数量', right: true },
        { label: '重量kg', key: '重量kg', right: true },
        { label: '开始日期', key: '开始日期' },
        { label: '结束日期', key: '结束日期' },
        { label: '交期', key: '交期' },
        { label: '逾期天数', key: '逾期天数', right: true },
        { label: '持续天数', key: '持续天数', right: true },
        { label: '班组日产能kg', key: '班组日产能kg', right: true },
    ], {
        '重量kg': v => fmtNum(v),
        '班组日产能kg': v => fmtNum(v),
        '逾期天数': (v, r) => v > 0 ? `<span class="badge badge-danger">${v}</span>` : `<span class="badge badge-success">${v}</span>`
    });
}

function renderDailySummaryTable() {
    const rows = filteredDailySummary();
    renderTable('dailySummaryTable', rows, [
        { label: '日期', key: '日期' },
        { label: '班组', key: '班组' },
        { label: '当日任务数', key: '当日任务数', right: true },
        { label: '当日重量kg', key: '当日重量kg', right: true },
        { label: '班组日产能kg', key: '班组日产能kg', right: true },
        { label: '利用率%', key: '利用率%', right: true },
    ], {
        '当日重量kg': v => fmtNum(v),
        '班组日产能kg': v => fmtNum(v),
        '利用率%': v => fmtNum(v) + '%'
    });
}

function renderDailyDetailTable() {
    const rows = filteredDailyDetail();
    renderTable('dailyDetailTable', rows, [
        { label: '日期', key: '日期' },
        { label: '班组', key: '班组' },
        { label: '工单', key: '工单' },
        { label: '毛坯品号', key: '毛坯品号' },
        { label: '毛坯品名', key: '毛坯品名' },
        { label: '规格', key: '规格' },
        { label: '数量', key: '数量', right: true },
        { label: '当日重量kg', key: '当日重量kg', right: true },
    ], {
        '当日重量kg': v => fmtNum(v)
    });
}

function renderGantt() {
    const rows = filteredTasks();
    const teams = [...new Set(rows.map(t => t['班组']))].sort();
    const teamIndex = Object.fromEntries(teams.map((t, i) => [t, i]));
    const palette = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
    const data = rows.map(t => ({
        value: [
            teamIndex[t['班组']],
            new Date(t['开始日期']).getTime(),
            new Date(t['结束日期']).getTime(),
            t['重量kg'],
            t['工单'],
            t['毛坯品名']
        ],
        itemStyle: { color: palette[teamIndex[t['班组']] % palette.length] }
    }));

    const chart = echarts.init($('#ganttChart'));
    chart.setOption({
        tooltip: {
            formatter: function (params) {
                const v = params.value;
                const start = new Date(v[1]).toLocaleDateString('zh-CN');
                const end = new Date(v[2]).toLocaleDateString('zh-CN');
                return `${teams[v[0]]}<br/>工单：${v[4]}<br/>品名：${v[5]}<br/>开始：${start}<br/>结束：${end}<br/>重量：${fmtNum(v[3])} kg`;
            }
        },
        grid: { left: '12%', right: '4%', top: '8%', bottom: '12%' },
        xAxis: {
            type: 'time',
            axisLabel: { formatter: '{yyyy}-{MM}-{dd}' }
        },
        yAxis: {
            type: 'category',
            data: teams,
            splitLine: { show: true }
        },
        dataZoom: [
            { type: 'slider', xAxisIndex: 0, filterMode: 'weakFilter' },
            { type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter' }
        ],
        series: [{
            type: 'custom',
            renderItem: function (params, api) {
                const categoryIndex = api.value(0);
                const start = api.coord([api.value(1), categoryIndex]);
                const end = api.coord([api.value(2), categoryIndex]);
                const height = api.size([0, 1])[1] * 0.6;
                const rectShape = echarts.graphic.clipRectByRect({
                    x: start[0],
                    y: start[1] - height / 2,
                    width: end[0] - start[0],
                    height: height
                }, {
                    x: params.coordSys.x,
                    y: params.coordSys.y,
                    width: params.coordSys.width,
                    height: params.coordSys.height
                });
                return rectShape && {
                    type: 'rect',
                    transition: ['shape'],
                    shape: rectShape,
                    style: api.style()
                };
            },
            encode: { x: [1, 2], y: 0 },
            data: data
        }]
    });
}

function renderUnscheduledTable() {
    const rows = state.unscheduled;
    renderTable('unscheduledTable', rows, [
        { label: '工单', key: '工单' },
        { label: '订单品号', key: '订单品号' },
        { label: '订单规格', key: '订单规格' },
        { label: '毛坯品号', key: '毛坯品号' },
        { label: '毛坯规格', key: '毛坯规格' },
        { label: '工单数量', key: '工单数量', right: true },
        { label: '交期', key: '交期' },
        { label: '原因', key: '原因' },
    ]);
}

function updateTeamFilterOptions() {
    const teams = [...new Set(state.tasks.map(t => t['班组']))].sort();
    const select = $('#teamFilter');
    select.innerHTML = '<option value="">全部</option>' + teams.map(t => `<option value="${t}">${t}</option>`).join('');
}

function renderAll() {
    $('#lastUpdated').textContent = '更新于 ' + new Date().toLocaleString('zh-CN');
    renderSummaryCards();
    renderCharts();
    renderTaskTable();
    renderDailySummaryTable();
    renderDailyDetailTable();
    renderGantt();
    renderUnscheduledTable();
}

function applyFilters() {
    state.teamFilter = $('#teamFilter').value;
    state.dateFrom = $('#dateFrom').value;
    state.dateTo = $('#dateTo').value;
    renderAll();
}

function resetFilters() {
    $('#teamFilter').value = '';
    $('#dateFrom').value = '';
    $('#dateTo').value = '';
    applyFilters();
}

function initTabs() {
    $$('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.tab-btn').forEach(b => b.classList.remove('active'));
            $$('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            $(`#${btn.dataset.tab}Panel`).classList.add('active');
            if (btn.dataset.tab === 'gantt') {
                setTimeout(() => echarts.getInstanceByDom($('#ganttChart'))?.resize(), 50);
            }
        });
    });
}

let countdownTimer = null;
let statusPollTimer = null;

function fmtCountdown(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function updateModal(remaining, elapsed) {
    $('#countdownText').textContent = fmtCountdown(Math.max(0, remaining));
    $('#modalStatus').textContent = `已运行 ${elapsed} 秒`;
    const pct = Math.min(100, (elapsed / 120) * 100);
    $('#progressFill').style.width = pct + '%';
}

function showModal() {
    $('#countdownModal').classList.add('active');
}

function hideModal() {
    $('#countdownModal').classList.remove('active');
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}

async function pollRunStatus() {
    try {
        const data = await api('/casting-schedule/run-status');
        if (!data) return;
        const elapsed = data.elapsedSec || 0;
        const remaining = Math.max(0, 120 - elapsed);
        updateModal(remaining, elapsed);
        if (!data.running && elapsed > 0) {
            // 已结束
            hideModal();
            await loadStrategyData(state.currentStrategy);
        }
    } catch (e) {
        console.error(e);
    }
}

function startCountdown() {
    showModal();
    let elapsed = 0;
    updateModal(120, elapsed);
    countdownTimer = setInterval(() => {
        elapsed++;
        const remaining = Math.max(0, 120 - elapsed);
        updateModal(remaining, elapsed);
        if (remaining <= 0) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
    }, 1000);
    statusPollTimer = setInterval(pollRunStatus, 5000);
    pollRunStatus();
}

async function startRun() {
    if (!confirm('重新排程约需 2 分钟，期间页面会显示倒计时，是否继续？')) return;
    try {
        const data = await api('/casting-schedule/run', { method: 'POST' });
        if (!data) return;
        startCountdown();
    } catch (e) {
        alert('启动排程失败：' + e.message);
    }
}

async function estimateLeadTime() {
    const pinhao = $('#estPinhao').value.trim();
    const spec = $('#estSpec').value.trim();
    const qty = parseInt($('#estQty').value, 10);
    const strategy = $('#estStrategy').value;
    const required = $('#estRequired').value;
    if (!pinhao || !spec || isNaN(qty) || qty <= 0) {
        $('#estResult').innerHTML = '<p class="muted">请输入品号、规格和有效数量</p>';
        return;
    }
    let url = `/casting-schedule/estimate?pinhao=${encodeURIComponent(pinhao)}&spec=${encodeURIComponent(spec)}&qty=${qty}`;
    if (strategy) url += `&strategy=${encodeURIComponent(strategy)}`;
    if (required) url += `&requiredDate=${encodeURIComponent(required)}`;
    const data = await api(url);
    if (!data) return;
    renderEstimateResult(data);
}

function renderEstimateResult(data) {
    const container = $('#estResult');
    if (data.reason) {
        container.innerHTML = `<p class="muted">${data.reason}</p>`;
        return;
    }
    if (!data.eligible || !data.eligible.length) {
        container.innerHTML = '<p class="muted">无可用班组数据</p>';
        return;
    }
    const best = data.eligible[0];
    const withLoad = data.strategy ? true : false;
    const withRequired = !!data.requiredDate;
    const rows = data.eligible.map(e => {
        const feasibleBadge = e.feasible === true
            ? '<span class="badge badge-success">可达成</span>'
            : (e.feasible === false ? '<span class="badge badge-danger">延期</span>' : '');
        return `
        <tr>
            <td>${e.team}</td>
            <td>${e.pinming || ''}</td>
            <td class="text-right">${fmtNum(e.unitWeightKg)}</td>
            <td class="text-right">${fmtNum(e.maxDailyKg)}</td>
            <td class="text-right">${fmtNum(e.totalWeightKg)}</td>
            <td class="text-right"><strong>${e.estimatedDays}</strong></td>
            ${withLoad ? `<td class="text-right">${e.earliestStart || '-'}</td><td class="text-right">${e.earliestEnd || '-'}</td>` : ''}
            ${withRequired ? `<td class="text-center">${feasibleBadge}</td><td class="text-right">${e.delayDays !== undefined ? e.delayDays : '-'}</td>` : ''}
            <td>${e.loadNote || ''}</td>
        </tr>
    `}).join('');
    const loadHeader = withLoad ? '<th class="text-right">最早开始</th><th class="text-right">最早结束</th>' : '';
    const requiredHeader = withRequired ? '<th class="text-center">需求达成</th><th class="text-right">延期天数</th>' : '';
    let summary = '';
    if (withLoad && withRequired) {
        if (best.feasible) {
            summary = `<p>客户要求交期：<strong>${data.requiredDate}</strong>；推荐班组 <strong>${best.team}</strong>，建议 <strong>${best.earliestStart}</strong> 开始，可在需求日期前完成（结束于 ${best.earliestEnd}）</p>`;
        } else if (best.delayDays !== undefined) {
            summary = `<p>客户要求交期：<strong>${data.requiredDate}</strong>；推荐班组 <strong>${best.team}</strong>，最早完成 <strong>${best.earliestEnd}</strong>，预计延期 <strong class="danger">${best.delayDays} 天</strong></p>`;
        } else {
            summary = `<p>客户要求交期：<strong>${data.requiredDate}</strong>；参考排程 <strong>${data.strategy}</strong> 中无法找到足够产能窗口</p>`;
        }
    } else if (withLoad) {
        summary = `<p>参考排程：<strong>${data.strategy}</strong>；推荐班组 <strong>${best.team}</strong>，最早可开始 <strong>${best.earliestStart || '-'}</strong>，预计 <strong>${best.estimatedDays} 天</strong>（结束于 ${best.earliestEnd || '-'})</p>`;
    } else {
        summary = `<p>推荐班组：<strong>${best.team}</strong>，理论周期 <strong>${best.estimatedDays} 天</strong>（未考虑现有负荷）</p>`;
    }
    container.innerHTML = `
        <p><strong>${data.pinhao}</strong>（毛坯品号 ${data.blankPinhao}，规格 ${data.spec}，数量 ${data.qty}）</p>
        ${summary}
        <div class="table-wrap">
            <table>
                <thead>
                    <tr><th>班组</th><th>品名</th><th class="text-right">单重 kg</th><th class="text-right">班组日产能 kg</th><th class="text-right">总重 kg</th><th class="text-right">预计天数</th>${loadHeader}${requiredHeader}<th>备注</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function init() {
    initTabs();
    $('#refreshBtn').addEventListener('click', () => loadStrategyData(state.currentStrategy));
    $('#runBtn').addEventListener('click', startRun);
    $('#filterBtn').addEventListener('click', applyFilters);
    $('#resetBtn').addEventListener('click', resetFilters);
    $('#estBtn').addEventListener('click', estimateLeadTime);
    $('#logoutBtn').addEventListener('click', async () => {
        try {
            await fetch('/api/dashboard/auth/logout', { method: 'POST', credentials: 'include' });
        } catch (e) { /* ignore */ }
        location.href = '/login.html?returnUrl=' + encodeURIComponent('/casting-schedule.html');
    });
    loadStrategies();
    loadUnscheduled();
    window.addEventListener('resize', () => {
        echarts.getInstanceByDom($('#loadChart'))?.resize();
        echarts.getInstanceByDom($('#utilChart'))?.resize();
        echarts.getInstanceByDom($('#ganttChart'))?.resize();
    });
}

init();
