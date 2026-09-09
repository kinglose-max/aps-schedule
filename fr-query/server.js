/* ===== fr-query/server.js — 铸造高级排程（APS）独立服务入口 ===== */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const authRouter = require('./routes/auth');
const castingScheduleRouter = require('./routes/castingSchedule');
const { authenticatePage } = require('./lib/authStore');

const app = express();
const PORT = process.env.FR_QUERY_PORT || 3004;

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 认证路由（公开：登录 / 登出 / 当前会话）
app.use('/api/dashboard/auth', authRouter);

// 铸造高级排程 API（路由内各自校验登录态）
app.use('/', castingScheduleRouter);

// 根路径直接进入 APS 看板
app.get('/', (req, res) => {
    res.redirect('/casting-schedule.html');
});

// APS 看板页面（需登录）
app.get('/casting-schedule.html', authenticatePage, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'casting-schedule.html'));
});

// 静态资源（CSS/JS/登录页/echarts）
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/health', (req, res) => res.json({ ok: true, service: 'casting-schedule' }));

// 统一错误处理
app.use((err, req, res, next) => {
    console.error('[fr-query]', err);
    res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
    console.log(`[fr-query] APS 服务运行于 http://localhost:${PORT}/casting-schedule.html`);
});
