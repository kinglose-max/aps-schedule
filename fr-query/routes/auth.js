/* ===== fr-query/routes/auth.js — 看板登录认证路由 ===== */

const express = require('express');
const {
    login,
    authenticate,
    setAuthCookie,
    clearAuthCookie,
    destroySession
} = require('../lib/authStore');

const router = express.Router();

router.post('/login', express.json(), (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: '请输入用户名和密码' });
    }

    const token = login(username, password);
    if (!token) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }

    setAuthCookie(res, token);
    res.json({ success: true, username });
});

router.post('/logout', (req, res) => {
    const token = req.cookies ? req.cookies.fr_query_session : null;
    destroySession(token);
    clearAuthCookie(res);
    res.json({ success: true });
});

router.get('/me', authenticate, (req, res) => {
    res.json({ success: true, username: req.user.username });
});

module.exports = router;
