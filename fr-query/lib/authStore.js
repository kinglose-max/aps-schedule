/* ===== fr-query/lib/authStore.js — 看板独立登录会话管理 ===== */

const crypto = require('crypto');

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'demo-only'; // [demo] 默认密码已移除，请在 .env 配置
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 小时
const COOKIE_NAME = 'fr_query_session';

const sessions = new Map();

function log(msg) {
    console.log(`[authStore] ${msg}`);
}

function createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    const session = {
        username,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_MAX_AGE_MS
    };
    sessions.set(token, session);
    cleanupExpiredSessions();
    return token;
}

function verifySession(token) {
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return null;
    }
    return session;
}

function destroySession(token) {
    if (token) sessions.delete(token);
}

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
        if (now > session.expiresAt) {
            sessions.delete(token);
        }
    }
}

function authenticate(req, res, next) {
    const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
    const session = verifySession(token);
    if (!session) {
        return res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' });
    }
    req.user = { username: session.username };
    next();
}

function authenticatePage(req, res, next) {
    const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
    const session = verifySession(token);
    if (!session) {
        const returnUrl = encodeURIComponent(req.path);
        return res.redirect(`/login.html?returnUrl=${returnUrl}`);
    }
    req.user = { username: session.username };
    next();
}

function login(username, password) {
    if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
        return createSession(username);
    }
    return null;
}

function setAuthCookie(res, token) {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'Lax',
        maxAge: SESSION_MAX_AGE_MS,
        path: '/'
    });
}

function clearAuthCookie(res) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
}

module.exports = {
    COOKIE_NAME,
    login,
    createSession,
    verifySession,
    destroySession,
    authenticate,
    authenticatePage,
    setAuthCookie,
    clearAuthCookie,
    getDefaultUser: () => DASHBOARD_USER
};
