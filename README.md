# 铸造高级排程（APS）看板 — 独立演示部署包

基于 **OR-Tools CP-SAT** 求解器的铸造车间高级排程（Advanced Planning & Scheduling）看板。

本项目仅包含 **APS 高级排程** 功能：多策略排程方案看板、调用本地 Python 求解器重新排程、排产周期估算。**不含**销售看板、生产预警、帆软综合查询等业务功能。

> 全部业务数据已匿名化：品号、规格、品名、班组、客户、工单等均为映射后的演示假名，不包含任何真实客户与帆软服务端信息。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| 📊 排程看板 | 多策略（8 种）排程方案：策略对比、任务列表、日明细、日汇总、班组甘特图、班组负荷/利用率图表、未排原因 |
| 🔄 重新排程 | 调用本地 Python 求解器（OR-Tools CP-SAT，多进程并行 6 策略）重新生成排程方案，约 2 分钟，完成后看板自动刷新 |
| 📅 排产周期估算 | 输入机加品号（702 开头）估算从毛坯到机加的排产周期，可按班组产能与现有排程负荷给出最早可排窗口与延期天数 |
| 🔐 登录保护 | 页面与 API 均需登录（.env 配置账号密码，内存 Session，8 小时有效） |

### 支持的排程策略

最小化总逾期 · 最小化最大逾期 · 最小化工期 · 负荷均衡 · 均衡且保交期 · 最大化产能利用率 · 产能拉满（轻交期）· 优先保证交期

---

## 快速开始

### 环境要求

- Node.js ≥ 18（自带 npm）
- Python ≥ 3.8（仅「重新排程」功能需要；可选用 `.venv` 重建说明）

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
copy .env.example .env
```

`.env` 内容（演示默认值）：

```ini
FR_QUERY_PORT=3010
DASHBOARD_USER=demo
DASHBOARD_PASS=Demo@2026
```

### 3. 启动

```bash
npm start        # 等价于 node fr-query/server.js
```

### 4. 访问

打开 <http://localhost:3010/casting-schedule.html>，使用以下账号登录：

- 用户名：`demo`
- 密码：`Demo@2026`

> 页面加载/切换策略需等待 10–20 秒，属预期（服务端每个请求完整解析一次排程工作簿）。

---

## 使用说明

### 排程看板

打开后顶部为策略 Tab（默认选中「最小化总逾期」等策略查看排程方案），包含：

- **汇总卡片**：任务数、总重量、总逾期/最大逾期、工期、班组负荷、求解状态
- **图表**：班组负荷分布（饼图）、日利用率趋势（折线）
- **任务列表 / 日汇总 / 日明细**：可筛选班组与日期区间
- **日计划甘特图**：按班组展示任务时间轴（可缩放）
- **未排原因**：无法排程的工单及原因（解析错误、无毛坯品号、无产能、无交期、无可用班组）
- **周期估算**：输入品号/规格/数量/交期，参考某策略负荷或忽略负荷，估算班组与排产窗口

### 重新排程

点击右上角「重新排程」，服务端调用 `scripts/casting_scheduler.py`（.venv 内 ortools），约 2 分钟完成后看板自动刷新。

---

## 目录结构

```
casting-demo/
├── fr-query/                    # Node.js (Express) 服务
│   ├── server.js                # 服务入口（认证 + APS 路由）
│   ├── routes/
│   │   ├── auth.js              # 登录 / 登出 / 会话
│   │   └── castingSchedule.js   # APS API（看板 / 求解 / 估算）
│   ├── lib/authStore.js         # 内存登录会话
│   └── public/
│       ├── casting-schedule.html/.css/.js   # APS 看板前端（ECharts）
│       ├── login.html / fr-query.css        # 登录页
│       └── vendor/echarts.min.js
├── scripts/casting_scheduler.py # OR-Tools 排程求解器（Python）
├── casting_schedule_plans.xlsx        # 各策略排程结果（看板读取）
├── casting_product_team_capacity.xlsx # 产品-班组日造型能力（求解输入）
├── casting_output_pouring.xlsx        # 历史浇注流水 → 班组日产能（求解输入）
├── fr-output/
│   ├── fr-report-jichu-*.json         # 机加→毛坯品号映射（求解/估算输入）
│   └── workorder-release/<YYYY-MM>/   # 工单月度快照（可排程任务来源）
├── package.json / .env.example / README.md
└── (本地生成) node_modules/ .venv/ .env
```

## 数据文件说明

| 文件 | 用途 |
|------|------|
| `casting_schedule_plans.xlsx` | 各策略排程结果，看板展示的数据源（重新排程时被求解器重写） |
| `casting_product_team_capacity.xlsx` | 产品 × 班组 × 规格 日造型能力（kg/件） |
| `casting_output_pouring.xlsx` | 历史浇注流水，用于计算班组日总产能 |
| `fr-output/fr-report-jichu-*.json` | 机加品号（702）→ 毛坯品号（701）映射 |
| `fr-output/workorder-release/` | 未结束工单月度快照，求解器按月份倒序去重读取 |

## 求解器（scripts/casting_scheduler.py）

- 读取：产品-班组能力、班组日产能（浇注流水）、机加→毛坯映射、工单快照
- 建模：OR-Tools CP-SAT，每个任务可选班组可选区间、班组日负荷 cumulative 约束
- 目标：8 种策略对应不同目标函数（总逾期 / 最大逾期 / 工期 / 负荷均衡 / 加权完成时间等）
- 并行：ProcessPoolExecutor 并行求解 6 个策略，单策略上限 120 秒
- 输出：重写 `casting_schedule_plans.xlsx`（策略明细 / 日明细 / 日汇总 / 未排原因 / 策略对比）

## 若 .venv 不可用（重新排程报错时）

`.venv` 指向的 base Python 不存在时按需重建：

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install ortools openpyxl
```

> 仅查看看板不需要 Python；「重新排程」需要 ortools。

## 常见问题

- **登录失败**：确认 `.env` 中 `DASHBOARD_USER` / `DASHBOARD_PASS` 与登录输入一致。
- **页面数据为空 / 加载慢**：确认根目录三个 xlsx 与 `fr-output/` 数据齐全；首次解析约 10–20 秒属正常。
- **「重新排程」失败**：确认 `.venv` 存在且已安装 `ortools openpyxl`（见上）。

## 技术栈

- **后端**：Node.js / Express / xlsx（排程工作簿解析）、cookie-parser、dotenv
- **求解器**：Python / OR-Tools CP-SAT / openpyxl（多进程并行）
- **前端**：原生 JS + ECharts（甘特图 / 饼图 / 折线）
- **认证**：内存 Session + HttpOnly Cookie

## License

内部演示用途。
