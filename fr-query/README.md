# 铸造高级排程（APS）独立服务

基于 Express 的独立服务，仅提供 **APS 高级排程** 功能：多策略排程方案看板、调用本地 OR-Tools 求解器重新排程、排产周期估算。登录会话由内存 Session 管理。

## 目录结构

```
fr-query/
├── server.js              # 服务入口（仅挂载认证 + APS 路由）
├── package.json           # 依赖与脚本
├── routes/
│   ├── auth.js            # 登录 / 登出 / 当前会话
│   └── castingSchedule.js # APS API（看板、求解、估算）
├── lib/authStore.js       # 登录会话管理
└── public/
    ├── casting-schedule.html/.css/.js   # APS 看板前端
    ├── login.html                       # 登录页
    ├── fr-query.css                     # 登录页样式
    └── vendor/echarts.min.js            # 图表库
```

## 启动

```bash
cd fr-query
npm start
# 或
node server.js
```

默认端口 `3004`，可通过环境变量 `FR_QUERY_PORT` 覆盖（本演示包 .env 中为 3010）。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 重定向到 APS 看板 `/casting-schedule.html` |
| GET | `/casting-schedule.html` | APS 看板页面（需登录） |
| GET | `/casting-schedule/strategies` | 排程策略列表（需登录） |
| GET | `/casting-schedule/summary` | 策略对比汇总（需登录） |
| GET | `/casting-schedule/detail?strategy=` | 任务列表（需登录） |
| GET | `/casting-schedule/daily-detail?strategy=` | 日明细（需登录） |
| GET | `/casting-schedule/daily-summary?strategy=` | 日汇总（需登录） |
| GET | `/casting-schedule/unscheduled` | 未排原因（需登录） |
| POST | `/casting-schedule/run` | 启动 Python 求解器重新排程（需登录） |
| GET | `/casting-schedule/run-status` | 求解进度查询（需登录） |
| GET | `/casting-schedule/estimate` | 排产周期估算（需登录） |
| POST | `/api/dashboard/auth/login` | 登录 |
| POST | `/api/dashboard/auth/logout` | 登出 |
| GET | `/api/dashboard/auth/me` | 当前会话 |
| GET | `/health` | 健康检查 |

## 登录

账号 / 密码由项目根目录 `.env` 中 `DASHBOARD_USER` / `DASHBOARD_PASS` 配置，默认账号 `admin`。会话有效期 8 小时，退出后需重新登录。

## 数据依赖（项目根目录）

- `casting_schedule_plans.xlsx` — 各策略排程结果
- `casting_product_team_capacity.xlsx` — 产品-班组日造型能力
- `casting_output_pouring.xlsx` — 历史浇注流水（求解输入）
- `fr-output/fr-report-jichu-*.json` — 机加→毛坯映射（求解/估算输入）
- `fr-output/workorder-release/` — 工单快照（求解输入）
- `.venv` + `scripts/casting_scheduler.py` — OR-Tools 求解器（重新排程时调用）

## 部署说明

独立部署时请一起打包：

- `fr-query/`
- `package.json`
- `node_modules/`
- `.env`（如需环境变量）
- 上节列出的数据文件与 `.venv`
