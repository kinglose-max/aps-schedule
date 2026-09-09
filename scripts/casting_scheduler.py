#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
铸造高级排程原型
输入：
  - casting_product_team_capacity.xlsx   （产品-班组日造型能力）
  - casting_output_pouring.xlsx          （历史浇注流水，用于计算班组日总产能）
  - fr-output/workorder-release/2026-07/fr-report-workorder_release-.json
  - fr-output/fr-report-jichu-*.json     （机加->毛坯映射）
输出：
  - casting_schedule_plans.xlsx          （多种策略下的排程方案）
"""

import json
import os
import math
from datetime import datetime, timedelta, date
from collections import defaultdict
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

from ortools.sat.python import cp_model
from openpyxl import load_workbook, Workbook

ROOT = Path(__file__).resolve().parent.parent
CAPACITY_XLSX = ROOT / "casting_product_team_capacity.xlsx"
POURING_XLSX = ROOT / "casting_output_pouring.xlsx"
WO_JSON = ROOT / "fr-output" / "workorder-release" / "2026-07" / "fr-report-workorder_release-.json"
JICHU_DIR = ROOT / "fr-output"
OUTPUT_XLSX = ROOT / "casting_schedule_plans.xlsx"

TODAY = date(2026, 7, 16)


def load_product_team_capacity():
    """读取产品-班组日造型能力，返回 (pt_cap, unit_weight)"""
    wb = load_workbook(CAPACITY_XLSX, data_only=True)
    sh = wb["product_team_capacity"]
    header = [c.value for c in sh[1]]
    # 列名：造型组,品号,品名,规格,历史生产天数,最大日重量_kg,P90日重量_kg,平均日重量_kg,最大日件数,P90日件数,平均日件数,首次生产,末次生产
    pt_cap = {}   # key=(pinhao,spec,group) -> dict
    by_spec = defaultdict(list)
    for row in sh.iter_rows(min_row=2, values_only=True):
        group, pinhao, pinming, spec = row[0], str(row[1] or ""), str(row[2] or ""), str(row[3] or "")
        max_w = float(row[5] or 0)
        p90_w = float(row[6] or 0)
        mean_w = float(row[7] or 0)
        max_q = float(row[8] or 0)
        p90_q = float(row[9] or 0)
        mean_q = float(row[10] or 0)
        if max_w <= 0 or max_q <= 0:
            continue
        unit_w = max_w / max_q
        rec = {
            "group": group,
            "pinhao": pinhao,
            "pinming": pinming,
            "spec": spec,
            "max_weight": max_w,
            "p90_weight": p90_w,
            "mean_weight": mean_w,
            "max_qty": max_q,
            "unit_weight": unit_w,
        }
        key = (pinhao, spec, group)
        pt_cap[key] = rec
        by_spec[(pinhao, spec)].append(rec)
    return pt_cap, by_spec


def load_team_daily_capacity():
    """从浇注流水计算每个班组历史上最大的日总产量（kg）"""
    wb = load_workbook(POURING_XLSX, data_only=True)
    sh = wb[wb.sheetnames[0]]
    header = [c.value for c in sh[1]]
    # 0任务单对象 2报工日期 5品号 7规格 13合格数 17合格重量
    daily = defaultdict(lambda: defaultdict(float))
    for row in sh.iter_rows(min_row=2, values_only=True):
        group = str(row[0] or "")
        serial = row[2]
        weight = float(row[17] or 0)
        if not group or not serial:
            continue
        if isinstance(serial, datetime):
            d = serial.date()
        else:
            # Excel serial
            d = (datetime(1899, 12, 30) + timedelta(days=float(serial))).date()
        key = d.isoformat()
        daily[group][key] += weight
    team_cap = {}
    for group, days in daily.items():
        team_cap[group] = max(days.values()) if days else 0
    return team_cap


def build_jichu_mapping():
    """扫描 jichu json，建立机加品号 -> 铸件品号 映射"""
    mapping = {}
    for f in JICHU_DIR.glob("fr-report-jichu-*.json"):
        try:
            with open(f, "r", encoding="utf-8") as fp:
                data = json.load(fp)
        except Exception:
            continue
        for r in data.get("rows", []):
            if not isinstance(r, list) or len(r) < 10:
                continue
            pinhao = str(r[2] or "").strip()
            zhujian = str(r[7] or "").strip()
            if pinhao.startswith("702") and zhujian.startswith("701"):
                if pinhao not in mapping:
                    mapping[pinhao] = zhujian
    return mapping


def parse_date(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, str) and v.strip():
        try:
            return datetime.strptime(v.strip()[:10], "%Y-%m-%d").date()
        except Exception:
            return None
    return None


def normalize_workorder_row(r):
    """处理 workorder_release 表格中因合并单元格产生的列偏移"""
    if not isinstance(r, list) or len(r) < 18:
        return None
    # 情形 A：前四列是 客户编号/简称 重复，剔除前两个
    if r[0] == r[2] and r[1] == r[3]:
        return r[2:]
    # 情形 B：订单单别/订单号被推到第 4/5 列，第 2/3 列被序号/订单日期占据，做交换
    if len(r) >= 6 and r[4] in ("2201", "2202") and r[2] not in ("2201", "2202"):
        r = list(r)
        r[2], r[3], r[4], r[5] = r[4], r[5], r[2], r[3]
        return r
    # 情形 C：本身已对齐
    return list(r)


def load_workorder_rows(since_date):
    """读取从 since_date 开始的所有 workorder_release 月报，按最新状态去重"""
    wo_dir = ROOT / "fr-output" / "workorder-release"
    files = []
    for d in wo_dir.iterdir():
        if not d.is_dir():
            continue
        name = d.name
        # 只取 YYYY-MM 格式，忽略季度汇总
        try:
            ym = datetime.strptime(name, "%Y-%m")
        except ValueError:
            continue
        if ym.date() < since_date:
            continue
        f = d / "fr-report-workorder_release-.json"
        if f.exists():
            files.append((ym, f))
    # 从最新月份开始倒序读取，先出现的为最新状态
    files.sort(key=lambda x: x[0], reverse=True)
    seen = {}
    for _, f in files:
        with open(f, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        for r in data.get("rows", []):
            r = normalize_workorder_row(r)
            if r is None:
                continue
            # 去重键：工单单别+工单单号+序号
            key = (r[15] if len(r) > 15 else "", r[16] if len(r) > 16 else "", r[4] if len(r) > 4 else "")
            if key not in seen:
                seen[key] = r
    return list(seen.values())


def extract_jobs(pt_cap, by_spec, jichu_map, team_cap):
    """从未结束工单中提取可排程的铸造任务"""
    since = date(2025, 12, 1)
    rows = load_workorder_rows(since)
    print(f"读取 {since} 以来的工单快照，去重后 {len(rows)} 条")

    # 列索引已在前文确认
    idx_order_pinhao = 7
    idx_order_spec = 9
    idx_wo_qty = 22
    idx_due = 23
    idx_sales_due = 11
    idx_blank_pinhao = 37
    idx_blank_spec = 20
    idx_blank_name = 38
    idx_ended = 34
    idx_wo_no = 16
    idx_wo_type = 15
    idx_seq = 4

    REASON_TEXT = {
        "parse_error": "解析错误（工单数量非数字）",
        "no_blank_pinhao": "无毛坯品号（采购品号非701且jichu无映射）",
        "no_casting_capacity": "无历史造型产能",
        "no_due_date": "无交期",
        "no_eligible_team": "无可用班组",
    }

    jobs = []
    skipped_counts = defaultdict(int)
    skipped_records = []

    def make_id(r):
        return f"{r[idx_wo_type]}-{r[idx_wo_no]}-{r[idx_seq]}"

    for raw in rows:
        r = normalize_workorder_row(raw)
        if r is None:
            continue
        try:
            qty = float(r[idx_wo_qty] or 0)
        except (ValueError, TypeError):
            skipped_counts["parse_error"] += 1
            skipped_records.append({
                "工单": make_id(r),
                "订单品号": str(r[idx_order_pinhao] or "").strip(),
                "订单规格": str(r[idx_order_spec] or "").strip(),
                "毛坯品号": "",
                "毛坯规格": str(r[idx_blank_spec] or "").strip(),
                "工单数量": str(r[idx_wo_qty] or "").strip(),
                "交期": "",
                "原因": REASON_TEXT["parse_error"],
            })
            continue
        if qty <= 0:
            continue
        if r[idx_ended] == "Y":
            continue
        order_pinhao = str(r[idx_order_pinhao] or "").strip()
        blank_spec = str(r[idx_blank_spec] or "").strip()
        blank_pinhao = str(r[idx_blank_pinhao] or "").strip()
        blank_name = str(r[idx_blank_name] or "").strip()

        due = parse_date(r[idx_due]) or parse_date(r[idx_sales_due])
        due_str = due.isoformat() if due else ""

        # 确定毛坯品号
        if not blank_pinhao.startswith("701"):
            blank_pinhao = jichu_map.get(order_pinhao, "")
        if not blank_pinhao.startswith("701"):
            skipped_counts["no_blank_pinhao"] += 1
            skipped_records.append({
                "工单": make_id(r),
                "订单品号": order_pinhao,
                "订单规格": str(r[idx_order_spec] or "").strip(),
                "毛坯品号": "",
                "毛坯规格": blank_spec,
                "工单数量": qty,
                "交期": due_str,
                "原因": REASON_TEXT["no_blank_pinhao"],
            })
            continue

        # 查找对应的产品-班组能力
        cap_recs = by_spec.get((blank_pinhao, blank_spec))
        if not cap_recs:
            # 尝试仅按规格匹配（兼容规格写法差异）
            matched = []
            for (p, s), recs in by_spec.items():
                if s == blank_spec:
                    matched.extend(recs)
            cap_recs = matched
        if not cap_recs:
            skipped_counts["no_casting_capacity"] += 1
            skipped_records.append({
                "工单": make_id(r),
                "订单品号": order_pinhao,
                "订单规格": str(r[idx_order_spec] or "").strip(),
                "毛坯品号": blank_pinhao,
                "毛坯规格": blank_spec,
                "工单数量": qty,
                "交期": due_str,
                "原因": REASON_TEXT["no_casting_capacity"],
            })
            continue

        # 取所有班组中最大日重量作为该任务单位天产能上限（排程时再按班组细分）
        best_rec = max(cap_recs, key=lambda x: x["max_weight"])
        unit_weight = best_rec["unit_weight"]
        job_weight = qty * unit_weight

        if not due:
            skipped_counts["no_due_date"] += 1
            skipped_records.append({
                "工单": make_id(r),
                "订单品号": order_pinhao,
                "订单规格": str(r[idx_order_spec] or "").strip(),
                "毛坯品号": blank_pinhao,
                "毛坯规格": blank_spec,
                "工单数量": qty,
                "交期": "",
                "原因": REASON_TEXT["no_due_date"],
            })
            continue

        eligible = []
        for rec in cap_recs:
            g = rec["group"]
            if g not in team_cap or team_cap[g] <= 0:
                continue
            eligible.append({
                "group": g,
                "max_daily_weight": rec["max_weight"],
                "unit_weight": rec["unit_weight"],
            })
        if not eligible:
            skipped_counts["no_eligible_team"] += 1
            skipped_records.append({
                "工单": make_id(r),
                "订单品号": order_pinhao,
                "订单规格": str(r[idx_order_spec] or "").strip(),
                "毛坯品号": blank_pinhao,
                "毛坯规格": blank_spec,
                "工单数量": qty,
                "交期": due_str,
                "原因": REASON_TEXT["no_eligible_team"],
            })
            continue

        jobs.append({
            "id": make_id(r),
            "order_pinhao": order_pinhao,
            "blank_pinhao": blank_pinhao,
            "blank_spec": blank_spec,
            "blank_name": blank_name or best_rec["pinming"],
            "qty": qty,
            "weight_kg": round(job_weight, 2),
            "due": due,
            "eligible": eligible,
        })

    print(f"可排程任务数: {len(jobs)}, 跳过原因: {dict(skipped_counts)}")
    return jobs, skipped_records


def build_schedule(jobs, team_cap, strategy="min_tardiness", time_limit_sec=120):
    """使用 OR-Tools CP-SAT 建立并求解排程模型"""
    if not jobs:
        return []

    # 时间范围：从今天开始到最晚交期+缓冲，并保证能容纳总工作量
    start_date = TODAY
    max_due = max(j["due"] for j in jobs)
    min_due = min(j["due"] for j in jobs)
    total_weight = sum(j["weight_kg"] for j in jobs)
    total_team_cap = sum(team_cap.values())
    min_horizon = int(math.ceil(total_weight / max(total_team_cap, 1))) + 30
    horizon = max((max_due - start_date).days + 1 + 30, min_horizon)

    # 逾期天数变量上界（含已过期工单）
    max_past_days = max(0, -(min_due - start_date).days)
    lateness_ub = horizon + max_past_days + 30

    def day_index(d):
        return (d - start_date).days

    model = cp_model.CpModel()

    # 为每个任务在每个可选班组上建立可选 interval
    job_vars = []
    for j_idx, job in enumerate(jobs):
        job["_eligible_intervals"] = []
        job["_assign_vars"] = []
        for e_idx, el in enumerate(job["eligible"]):
            group = el["group"]
            daily = el["max_daily_weight"]
            duration = max(1, math.ceil(job["weight_kg"] / daily))
            duration = min(duration, horizon)
            start_var = model.NewIntVar(0, horizon - duration, f"s_j{j_idx}_e{e_idx}")
            end_var = model.NewIntVar(duration, horizon, f"e_j{j_idx}_e{e_idx}")
            assign_var = model.NewBoolVar(f"a_j{j_idx}_e{e_idx}")
            interval = model.NewOptionalIntervalVar(
                start_var, duration, end_var, assign_var,
                f"iv_j{j_idx}_e{e_idx}"
            )
            job["_eligible_intervals"].append({
                "group": group,
                "daily": daily,
                "duration": duration,
                "interval": interval,
                "start": start_var,
                "end": end_var,
                "assign": assign_var,
                "e_idx": e_idx,
            })
            job["_assign_vars"].append(assign_var)
        # 每个任务必须且只能分配到一个班组
        model.AddExactlyOne(job["_assign_vars"])
        job_vars.append(job)

    # 班组 cumulative 约束：每天负荷不超过班组日最大产能
    groups = sorted(team_cap.keys())
    for g in groups:
        intervals = []
        demands = []
        for j_idx, job in enumerate(jobs):
            for opt in job["_eligible_intervals"]:
                if opt["group"] == g:
                    intervals.append(opt["interval"])
                    # 每天占用的能力按该任务在此班组的最大日产量算
                    demands.append(int(round(opt["daily"])))
        if intervals:
            cap = int(round(team_cap[g]))
            model.AddCumulative(intervals, demands, cap)

    # 辅助变量
    makespan = model.NewIntVar(0, horizon, "makespan")
    team_load_vars = {}
    load_max = max(1, int(math.ceil(total_weight)))
    for g in groups:
        team_load_vars[g] = model.NewIntVar(0, load_max, f"load_{g}")

    # 目标辅助变量
    max_lateness = model.NewIntVar(-lateness_ub, lateness_ub, "max_lateness")
    max_team_load = model.NewIntVar(0, load_max, "max_team_load")

    tardiness_option_vars = []
    weighted_tardiness_terms = []
    for j_idx, job in enumerate(jobs):
        due_idx = day_index(job["due"])
        w = int(round(job["weight_kg"]))
        for opt in job["_eligible_intervals"]:
            end_v = opt["end"]
            a = opt["assign"]

            # makespan 约束（仅对选中的 option 生效）
            model.Add(makespan >= end_v - horizon * (1 - a))

            # 最大逾期约束
            model.Add(max_lateness >= end_v - due_idx - lateness_ub * (1 - a))

            # 每个 option 的逾期天数（仅在选中时等于 max(0, end-due)）
            tard = model.NewIntVar(0, lateness_ub, f"tard_j{j_idx}_e{opt['e_idx']}")
            # 选中时：tard >= end - due
            model.Add(tard >= end_v - due_idx - lateness_ub * (1 - a))
            # 选中时：tard <= end - due
            model.Add(tard <= end_v - due_idx + lateness_ub * (1 - a))
            # 未选中时：tard <= 0 -> 0
            model.Add(tard <= lateness_ub * a)
            tardiness_option_vars.append(tard)
            weighted_tardiness_terms.append(tard * w)

    total_tardiness = sum(tardiness_option_vars)
    weighted_tardiness = sum(weighted_tardiness_terms)

    # 忽略交期、追求早完成 / 高利用率：最小化 sum(end * weight)
    flow_time = model.NewIntVar(0, 10_000_000_000, "flow_time")
    flow_exprs = []
    for j_idx, job in enumerate(jobs):
        w = int(round(job["weight_kg"]))
        for e_idx, opt in enumerate(job["_eligible_intervals"]):
            contrib = model.NewIntVar(0, 10_000_000_000, f"flow_j{j_idx}_e{e_idx}")
            # 选中时 contrib = end * weight；未选中时为 0
            model.Add(contrib == opt["end"] * w).OnlyEnforceIf(opt["assign"])
            model.Add(contrib == 0).OnlyEnforceIf(opt["assign"].Not())
            flow_exprs.append(contrib)
    model.Add(flow_time == sum(flow_exprs))

    # 班组负荷
    for g in groups:
        exprs = []
        for j_idx, job in enumerate(jobs):
            for opt in job["_eligible_intervals"]:
                if opt["group"] == g:
                    exprs.append(int(round(job["weight_kg"])) * opt["assign"])
        model.Add(team_load_vars[g] == sum(exprs))

    model.AddMaxEquality(max_team_load, list(team_load_vars.values()))

    # 目标函数
    if strategy == "min_makespan":
        model.Minimize(makespan)
    elif strategy == "min_total_tardiness":
        model.Minimize(total_tardiness)
    elif strategy == "min_max_lateness":
        model.Minimize(max_lateness)
    elif strategy == "balance_load":
        model.Minimize(max_team_load)
    elif strategy == "balanced_ontime":
        # 加权：逾期惩罚 + 0.001 * 最大负荷
        model.Minimize(total_tardiness * 1000 + max_team_load)
    elif strategy == "max_utilization":
        # 忽略交期，最小化加权完成时间，等价于追求早完成、高产能利用率
        model.Minimize(flow_time)
    elif strategy == "capacity_fill":
        # 产能拉满：优先追求早完成/高利用率，同时以较低权重兼顾交期
        model.Minimize(flow_time * 1000 + total_tardiness)
    elif strategy == "weighted_tardiness":
        # 优先保证交期：按任务重量加权惩罚逾期，重单优先不逾期
        model.Minimize(weighted_tardiness)
    else:
        model.Minimize(total_tardiness)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_sec
    solver.parameters.num_search_workers = 8
    solver.parameters.log_search_progress = False
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print(f"[{strategy}] 未找到可行解")
        return []

    results = []
    for j_idx, job in enumerate(jobs):
        for opt in job["_eligible_intervals"]:
            if solver.Value(opt["assign"]):
                start_idx = solver.Value(opt["start"])
                end_idx = solver.Value(opt["end"])
                start_d = start_date + timedelta(days=start_idx)
                end_d = start_date + timedelta(days=end_idx - 1)
                due_idx = day_index(job["due"])
                tard = max(0, end_idx - due_idx)
                results.append({
                    "job_id": job["id"],
                    "blank_pinhao": job["blank_pinhao"],
                    "blank_spec": job["blank_spec"],
                    "blank_name": job["blank_name"],
                    "order_pinhao": job["order_pinhao"],
                    "qty": job["qty"],
                    "weight_kg": job["weight_kg"],
                    "team": opt["group"],
                    "start": start_d,
                    "end": end_d,
                    "due": job["due"],
                    "tardiness_days": tard,
                    "duration_days": opt["duration"],
                    "daily_capacity_kg": opt["daily"],
                })
                break
    print(f"[{strategy}] 目标值={solver.ObjectiveValue()}, 状态={solver.StatusName(status)}")
    return {
        "results": results,
        "status": solver.StatusName(status),
        "objective": solver.ObjectiveValue(),
    }


def _solve_strategy(args):
    """多进程求解包装函数"""
    name, key, jobs, team_cap, time_limit = args
    print(f"\n求解策略: {name}")
    res = build_schedule(jobs, team_cap, strategy=key, time_limit_sec=time_limit)
    return name, res


def expand_daily(rows):
    """把任务按天展开，返回每一天每个班组每个工单的明细"""
    details = []
    for r in rows:
        daily = r["daily_capacity_kg"]
        remaining = r["weight_kg"]
        day = r["start"]
        end = r["end"]
        while day <= end:
            w = min(daily, remaining)
            details.append({
                "date": day,
                "team": r["team"],
                "job_id": r["job_id"],
                "blank_pinhao": r["blank_pinhao"],
                "blank_name": r["blank_name"],
                "blank_spec": r["blank_spec"],
                "qty": r["qty"],
                "day_weight": round(w, 2),
            })
            remaining -= w
            day += timedelta(days=1)
    return details


def write_results(all_results, team_cap, statuses, skipped_records):
    wb = Workbook()
    # 删除默认 sheet
    wb.remove(wb.active)

    # 未排原因
    if skipped_records:
        ws_skip = wb.create_sheet("未排原因")
        headers = list(skipped_records[0].keys())
        ws_skip.append(headers)
        for rec in skipped_records:
            ws_skip.append([rec[h] for h in headers])

    # 汇总
    summary = []
    for strategy, rows in all_results.items():
        if not rows:
            continue
        total_weight = sum(r["weight_kg"] for r in rows)
        total_tardy = sum(r["tardiness_days"] for r in rows)
        max_tardy = max(r["tardiness_days"] for r in rows)
        makespan = max((r["end"] - TODAY).days for r in rows) + 1
        team_load = defaultdict(float)
        for r in rows:
            team_load[r["team"]] += r["weight_kg"]
        st = statuses.get(strategy, {})
        summary.append({
            "策略": strategy,
            "任务数": len(rows),
            "总重量kg": round(total_weight, 2),
            "总逾期天数": total_tardy,
            "最大逾期天数": max_tardy,
            "makespan_天": makespan,
            "负荷最大班组kg": round(max(team_load.values()), 2) if team_load else 0,
            "负荷最小班组kg": round(min(team_load.values()), 2) if team_load else 0,
            "目标值": st.get("objective", ""),
            "求解状态": st.get("status", ""),
        })

    ws_sum = wb.create_sheet("策略对比")
    headers = list(summary[0].keys()) if summary else []
    ws_sum.append(headers)
    for s in summary:
        ws_sum.append([s[h] for h in headers])

    for strategy, rows in all_results.items():
        if not rows:
            continue
        # 任务汇总
        ws = wb.create_sheet(strategy[:31])
        ws.append([
            "工单", "毛坯品号", "毛坯品名", "规格", "机加品号",
            "数量", "重量kg", "班组", "开始日期", "结束日期", "交期", "逾期天数", "持续天数", "班组日产能kg"
        ])
        for r in sorted(rows, key=lambda x: (x["team"], x["start"], x["job_id"])):
            ws.append([
                r["job_id"], r["blank_pinhao"], r["blank_name"], r["blank_spec"], r["order_pinhao"],
                r["qty"], r["weight_kg"], r["team"], r["start"].isoformat(),
                r["end"].isoformat(), r["due"].isoformat(), r["tardiness_days"],
                r["duration_days"], r["daily_capacity_kg"]
            ])

        # 日明细
        daily = expand_daily(rows)
        ws_day = wb.create_sheet(f"{strategy}_日明细"[:31])
        ws_day.append(["日期", "班组", "工单", "毛坯品号", "毛坯品名", "规格", "数量", "当日重量kg"])
        for d in sorted(daily, key=lambda x: (x["date"], x["team"], x["job_id"])):
            ws_day.append([
                d["date"].isoformat(), d["team"], d["job_id"], d["blank_pinhao"],
                d["blank_name"], d["blank_spec"], d["qty"], d["day_weight"]
            ])

        # 日汇总（按班组）
        agg = defaultdict(lambda: {"count": 0, "weight": 0.0})
        for d in daily:
            k = (d["date"], d["team"])
            agg[k]["count"] += 1
            agg[k]["weight"] += d["day_weight"]
        ws_agg = wb.create_sheet(f"{strategy}_日汇总"[:31])
        ws_agg.append(["日期", "班组", "当日任务数", "当日重量kg", "班组日产能kg", "利用率%"])
        for (dt, team), v in sorted(agg.items()):
            cap = team_cap.get(team, 0)
            util = round(v["weight"] / cap * 100, 2) if cap > 0 else 0
            ws_agg.append([
                dt.isoformat(), team, v["count"], round(v["weight"], 2),
                round(cap, 2), util
            ])

    wb.save(OUTPUT_XLSX)
    print(f"结果已保存: {OUTPUT_XLSX}")


def main():
    print("加载产品-班组能力...")
    pt_cap, by_spec = load_product_team_capacity()
    print(f"  产品-班组组合: {len(pt_cap)}")

    print("加载班组日总产能...")
    team_cap = load_team_daily_capacity()
    print(f"  班组: {team_cap}")

    print("构建机加->毛坯映射...")
    jichu_map = build_jichu_mapping()
    print(f"  映射数: {len(jichu_map)}")

    print("提取未结束工单...")
    jobs, skipped_records = extract_jobs(pt_cap, by_spec, jichu_map, team_cap)

    if not jobs:
        print("没有可排程任务")
        return

    strategies = {
        "最小化总逾期": "min_total_tardiness",
        "最小化最大逾期": "min_max_lateness",
        "最小化工期": "min_makespan",
        "负荷均衡": "balance_load",
        "均衡且保交期": "balanced_ontime",
        "最大化产能利用率": "max_utilization",
        "产能拉满（轻交期）": "capacity_fill",
        "优先保证交期": "weighted_tardiness",
    }

    all_results = {}
    statuses = {}
    # 6 个策略并行求解，每个最多 120 秒，整体约 2 分钟
    items = [(name, key, jobs, team_cap, 120) for name, key in strategies.items()]
    with ProcessPoolExecutor(max_workers=min(len(items), 6)) as executor:
        for name, res in executor.map(_solve_strategy, items):
            all_results[name] = res["results"]
            statuses[name] = {
                "status": res["status"],
                "objective": res["objective"],
            }

    write_results(all_results, team_cap, statuses, skipped_records)


if __name__ == "__main__":
    main()
