/* ===== fr-query/routes/castingSchedule.js — 铸造排程结果 API ===== */

const path = require('path');
const express = require('express');
const xlsx = require('xlsx');
const fs = require('fs');
const { spawn } = require('child_process');
const { authenticate } = require('../lib/authStore');

const router = express.Router();
const XLSX_PATH = path.join(__dirname, '..', '..', 'casting_schedule_plans.xlsx');
const CAPACITY_XLSX = path.join(__dirname, '..', '..', 'casting_product_team_capacity.xlsx');
const JICHU_DIR = path.join(__dirname, '..', '..', 'fr-output');
const PYTHON_EXE = path.join(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe');
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'casting_scheduler.py');

let runningProcess = null;
let runStartTime = null;

function readSheet(name) {
    const wb = xlsx.readFile(XLSX_PATH);
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return xlsx.utils.sheet_to_json(ws);
}

function getStrategies() {
    const wb = xlsx.readFile(XLSX_PATH);
    return wb.SheetNames.filter(n => !n.endsWith('_日明细') && !n.endsWith('_日汇总') && n !== '策略对比');
}

router.get('/casting-schedule/summary', authenticate, (req, res) => {
    try {
        const data = readSheet('策略对比');
        res.json({ ok: true, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.get('/casting-schedule/strategies', authenticate, (req, res) => {
    try {
        res.json({ ok: true, data: getStrategies() });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.get('/casting-schedule/detail', authenticate, (req, res) => {
    try {
        const strategy = req.query.strategy;
        if (!strategy) return res.status(400).json({ ok: false, error: '缺少 strategy' });
        const data = readSheet(strategy);
        res.json({ ok: true, strategy, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.get('/casting-schedule/daily-detail', authenticate, (req, res) => {
    try {
        const strategy = req.query.strategy;
        if (!strategy) return res.status(400).json({ ok: false, error: '缺少 strategy' });
        const data = readSheet(`${strategy}_日明细`);
        res.json({ ok: true, strategy, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.get('/casting-schedule/daily-summary', authenticate, (req, res) => {
    try {
        const strategy = req.query.strategy;
        if (!strategy) return res.status(400).json({ ok: false, error: '缺少 strategy' });
        const data = readSheet(`${strategy}_日汇总`);
        res.json({ ok: true, strategy, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.get('/casting-schedule/unscheduled', authenticate, (req, res) => {
    try {
        const data = readSheet('未排原因');
        res.json({ ok: true, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/casting-schedule/run', authenticate, (req, res) => {
    if (runningProcess) {
        return res.json({ ok: false, running: true, message: '排程正在运行中' });
    }
    console.log('[castingSchedule] 启动排程求解...');
    runningProcess = spawn(PYTHON_EXE, [SCRIPT], {
        cwd: path.dirname(SCRIPT),
        stdio: 'inherit'
    });
    runStartTime = Date.now();
    runningProcess.on('exit', (code) => {
        console.log(`[castingSchedule] 排程结束，exit code=${code}`);
        runningProcess = null;
        runStartTime = null;
    });
    res.json({ ok: true, running: true, message: '排程已启动，预计约 2 分钟' });
});

router.get('/casting-schedule/run-status', authenticate, (req, res) => {
    const elapsedSec = runningProcess && runStartTime ? Math.floor((Date.now() - runStartTime) / 1000) : 0;
    res.json({
        ok: true,
        running: !!runningProcess,
        elapsedSec,
        estimatedSec: 120
    });
});

function buildJichuMap() {
    const map = {};
    if (!fs.existsSync(JICHU_DIR)) return map;
    for (const f of fs.readdirSync(JICHU_DIR)) {
        if (!f.startsWith('fr-report-jichu-') || !f.endsWith('.json')) continue;
        try {
            const data = JSON.parse(fs.readFileSync(path.join(JICHU_DIR, f), 'utf8'));
            for (const r of data.rows || []) {
                if (!Array.isArray(r) || r.length < 10) continue;
                const pinhao = String(r[2] || '').trim();
                const zhujian = String(r[7] || '').trim();
                if (pinhao.startsWith('702') && zhujian.startsWith('701')) {
                    if (!map[pinhao]) map[pinhao] = zhujian;
                }
            }
        } catch (e) {
            // ignore
        }
    }
    return map;
}

function loadCapacityRecords() {
    const wb = xlsx.readFile(CAPACITY_XLSX);
    const ws = wb.Sheets['product_team_capacity'];
    const rows = xlsx.utils.sheet_to_json(ws);
    return rows.map(r => ({
        group: r['造型组'],
        pinhao: String(r['品号'] || '').trim(),
        pinming: r['品名'],
        spec: String(r['规格'] || '').trim(),
        maxWeight: parseFloat(r['最大日重量_kg'] || 0),
        maxQty: parseFloat(r['最大日件数'] || 0),
    })).filter(r => r.maxWeight > 0 && r.maxQty > 0);
}

function loadTeamLoad(strategy) {
    if (!strategy) return null;
    const sheetName = `${strategy}_日汇总`;
    const wb = xlsx.readFile(XLSX_PATH);
    const ws = wb.Sheets[sheetName];
    if (!ws) return null;
    const rows = xlsx.utils.sheet_to_json(ws);
    const load = {};
    const cap = {};
    let maxDate = null;
    for (const r of rows) {
        const team = r['班组'];
        const dateStr = r['日期'];
        const weight = parseFloat(r['当日重量kg'] || 0);
        const teamCap = parseFloat(r['班组日产能kg'] || 0);
        if (!team || !dateStr) continue;
        if (!load[team]) load[team] = {};
        load[team][dateStr] = weight;
        cap[team] = teamCap;
        const d = new Date(dateStr);
        if (!maxDate || d > maxDate) maxDate = d;
    }
    return { load, cap, maxDate };
}

function addDays(date, days) {
    const r = new Date(date);
    r.setDate(r.getDate() + days);
    return r;
}

function fmtDate(date) {
    return date.toISOString().slice(0, 10);
}

function checkWindow(start, teamLoad, team, duration, dailyReqs) {
    const teamCap = teamLoad.cap[team] || 0;
    const loads = teamLoad.load[team] || {};
    for (let k = 0; k < duration; k++) {
        const d = addDays(start, k);
        const dStr = fmtDate(d);
        const used = loads[dStr] || 0;
        if (teamCap - used < dailyReqs[k]) {
            return false;
        }
    }
    return true;
}

function findEarliestWindow(team, teamLoad, todayStr, duration, dailyReqs) {
    const today = new Date(todayStr);
    const maxScheduleDate = teamLoad.maxDate || today;
    const searchEnd = addDays(maxScheduleDate, duration + 30);
    for (let offset = 0; ; offset++) {
        const start = addDays(today, offset);
        if (start > searchEnd) break;
        if (checkWindow(start, teamLoad, team, duration, dailyReqs)) {
            return {
                earliestStart: fmtDate(start),
                earliestEnd: fmtDate(addDays(start, duration - 1)),
            };
        }
    }
    return null;
}

function findRequiredWindow(team, teamLoad, todayStr, duration, dailyReqs, requiredDateStr) {
    const today = new Date(todayStr);
    const required = new Date(requiredDateStr);
    // 最晚可开始日期 = 需求日期 - 周期 + 1
    let latestStart = addDays(required, -(duration - 1));
    if (latestStart < today) return null; // 即使从今天开始也来不及
    // 从最晚开始日期向前搜索，找到能容纳的窗口
    for (let offset = 0; ; offset++) {
        const start = addDays(latestStart, -offset);
        if (start < today) break;
        const end = addDays(start, duration - 1);
        if (end > required) continue;
        if (checkWindow(start, teamLoad, team, duration, dailyReqs)) {
            return {
                requiredStart: fmtDate(start),
                requiredEnd: fmtDate(end),
                feasible: true
            };
        }
    }
    return null;
}

function daysBetween(d1, d2) {
    return Math.round((new Date(d1) - new Date(d2)) / (1000 * 60 * 60 * 24));
}

router.get('/casting-schedule/estimate', authenticate, (req, res) => {
    try {
        let pinhao = String(req.query.pinhao || '').trim();
        const spec = String(req.query.spec || '').trim();
        const qty = parseFloat(req.query.qty);
        const strategy = String(req.query.strategy || '').trim();
        const requiredDate = String(req.query.requiredDate || '').trim();
        if (!pinhao || !spec || isNaN(qty) || qty <= 0) {
            return res.status(400).json({ ok: false, error: '缺少品号/规格/数量或数量非法' });
        }

        // 702 机加品号尝试映射为毛坯品号
        let blankPinhao = pinhao;
        if (pinhao.startsWith('702')) {
            const jichuMap = buildJichuMap();
            blankPinhao = jichuMap[pinhao] || '';
        }
        if (!blankPinhao || !blankPinhao.startsWith('701')) {
            return res.json({ ok: true, pinhao, blankPinhao, spec, qty, requiredDate, eligible: [], reason: '无法找到对应毛坯品号' });
        }

        const records = loadCapacityRecords();
        const matched = records.filter(r => r.pinhao === blankPinhao && r.spec === spec);
        if (!matched.length) {
            return res.json({ ok: true, pinhao, blankPinhao, spec, qty, requiredDate, eligible: [], reason: '该产品-规格无历史造型产能' });
        }

        const teamLoad = loadTeamLoad(strategy);
        const todayStr = new Date().toISOString().slice(0, 10);

        const eligible = matched.map(r => {
            const unitWeight = r.maxWeight / r.maxQty;
            const totalWeight = qty * unitWeight;
            const duration = Math.max(1, Math.ceil(totalWeight / r.maxWeight));
            const dailyReqs = [];
            let remaining = totalWeight;
            for (let k = 0; k < duration; k++) {
                const req = Math.min(r.maxWeight, remaining);
                dailyReqs.push(req);
                remaining -= req;
            }
            const base = {
                team: r.group,
                pinming: r.pinming,
                unitWeightKg: Math.round(unitWeight * 1000) / 1000,
                maxDailyKg: r.maxWeight,
                totalWeightKg: Math.round(totalWeight * 100) / 100,
                estimatedDays: duration,
            };
            if (teamLoad) {
                if (requiredDate) {
                    // 先尝试在需求日期前完成
                    const reqWindow = findRequiredWindow(r.group, teamLoad, todayStr, duration, dailyReqs, requiredDate);
                    if (reqWindow) {
                        base.earliestStart = reqWindow.requiredStart;
                        base.earliestEnd = reqWindow.requiredEnd;
                        base.feasible = true;
                        base.withLoad = true;
                    } else {
                        // 无法满足需求日期，给出最早可完成时间
                        const window = findEarliestWindow(r.group, teamLoad, todayStr, duration, dailyReqs);
                        if (window) {
                            base.earliestStart = window.earliestStart;
                            base.earliestEnd = window.earliestEnd;
                            base.feasible = false;
                            base.delayDays = Math.max(0, daysBetween(window.earliestEnd, requiredDate));
                            base.withLoad = true;
                        } else {
                            base.withLoad = false;
                            base.loadNote = '在现有排程内无法找到足够产能窗口';
                        }
                    }
                } else {
                    const window = findEarliestWindow(r.group, teamLoad, todayStr, duration, dailyReqs);
                    if (window) {
                        base.earliestStart = window.earliestStart;
                        base.earliestEnd = window.earliestEnd;
                        base.withLoad = true;
                    } else {
                        base.withLoad = false;
                        base.loadNote = '在现有排程内无法找到足够产能窗口';
                    }
                }
            }
            return base;
        }).sort((a, b) => {
            // 优先按是否满足需求日期，再按最早结束时间
            const aFeasible = a.feasible ? 1 : 0;
            const bFeasible = b.feasible ? 1 : 0;
            if (aFeasible !== bFeasible) return bFeasible - aFeasible;
            if (a.earliestEnd && b.earliestEnd) return a.earliestEnd.localeCompare(b.earliestEnd);
            if (a.earliestEnd) return -1;
            if (b.earliestEnd) return 1;
            return a.estimatedDays - b.estimatedDays;
        });

        res.json({ ok: true, pinhao, blankPinhao, spec, qty, requiredDate: requiredDate || null, strategy: strategy || null, eligible });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
