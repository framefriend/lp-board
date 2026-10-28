"use strict";

const SNAPSHOT_URL = "./dashboard-snapshot.json";
const money = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function byId(id) { return document.getElementById(id); }
function setText(id, value) { const node = byId(id); if (node) node.textContent = value; }
function pnlClass(value) { return value > 0 ? "positive" : value < 0 ? "negative" : "neutral"; }
function pctFromBps(value) { return `${number.format((Number(value) || 0) / 100)}%`; }
function formatMoney(value) { return money.format(Number(value) || 0); }
function formatTime(value) { return value ? dateTime.format(new Date(value)) : "—"; }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tableCell(text, className) {
  return element("td", className || "", text);
}

function appendRule(root, label, value) {
  const group = element("div", "policy-rule-row");
  group.append(element("dt", "", label), element("dd", "", value));
  root.append(group);
}

function renderStrategyPolicy(policy = {}) {
  const core = policy.core || {};
  const micro = policy.micro || {};
  setText("strategy-policy-status", policy.status_label || "정책 미확정");
  const cards = byId("strategy-policy-cards"); clear(cards);
  for (const [label, value, note, tone] of [
    ["총 전략 예산", formatMoney(policy.total_budget_usd), "코어 + 마이크로", ""],
    ["코어 한도", formatMoney(core.budget_usd), core.objective || "-", "positive"],
    ["마이크로 총한도", formatMoney(micro.budget_usd), `풀별 ${formatMoney(micro.per_pool_min_usd)}~${formatMoney(micro.per_pool_max_usd)}`, "warning"],
  ]) {
    const card = element("article", "metric-card policy-budget-card");
    card.append(element("span", "", label), element("strong", tone, value), element("small", "", note));
    cards.append(card);
  }
  const coreRules = byId("core-policy-rules"); clear(coreRules);
  appendRule(coreRules, "진입", core.entry || "-");
  appendRule(coreRules, "보유", core.retention || "-");
  appendRule(coreRules, "철수", core.exit || "-");
  const microRules = byId("micro-policy-rules"); clear(microRules);
  appendRule(microRules, "진입", micro.entry || "-");
  appendRule(microRules, "보유", micro.retention || "-");
  appendRule(microRules, "철수", micro.exit || "-");
  const hardStops = byId("hard-stop-rules"); clear(hardStops);
  for (const rule of policy.hard_stops || []) hardStops.append(element("li", "", rule));
  setText("strategy-policy-note", policy.activation_note || "");
}

function renderSummary(data) {
  const items = [
    ["전체 스캔", integer.format(data.summary.scanned_pools), `상세 분석 ${integer.format(data.summary.detailed_pools)}`],
    ["현재 적격 풀", integer.format(data.summary.eligible_pools), "없으면 전액 대기"],
    ["열린 가상 포지션", integer.format(data.summary.open_lanes), "정책별 독립 레인"],
    ["가상 배정 합계", compactMoney.format(data.summary.deployed_usd), "실제 자금 아님"],
    ["누적 Edge 추정", formatMoney(data.summary.gross_edge_usd), "7일 비율 Forward 적분"],
    ["운영 중 평가손익", formatMoney(data.summary.operating_marked_pnl_usd), "발생 가스 추정 반영"],
    ["지금 철수 시", data.summary.immediate_exit_pnl_usd == null ? "미확정" : formatMoney(data.summary.immediate_exit_pnl_usd), "예상 철수가스 후 · 스왑 제외"],
  ];
  const root = byId("summary-cards"); clear(root);
  for (const [label, value, note] of items) {
    const card = element("article", "metric-card");
    card.append(element("span", "", label), element("strong", pnlClass(label.includes("손익") ? data.summary.modeled_net_relative_pnl_usd : 0), value), element("small", "", note));
    root.append(card);
  }
}

function renderEligible(rows) {
  const body = byId("eligible-body"); clear(body);
  byId("eligible-empty").hidden = rows.length > 0;
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(
      tableCell(row.pair, "pair"), tableCell(row.chain), tableCell(compactMoney.format(row.tvl_usd)),
      tableCell(compactMoney.format(row.volume_24h_usd)), tableCell(`${number.format(row.volume_tvl_24h)}×`),
      tableCell(pctFromBps(row.tight_edge_apr_bps_7d), "positive"),
      tableCell(pctFromBps(row.tight_pnl_apr_bps_7d), "positive"),
      tableCell(`${integer.format(row.positive_pnl_bins)}/${integer.format(row.valid_bins)}`)
    );
    body.append(tr);
  }
}

function renderPositions(rows) {
  const body = byId("positions-body"); clear(body);
  byId("positions-empty").hidden = rows.length > 0;
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(
      tableCell(`${row.pair} · ${row.chain}`, "pair"), tableCell(row.strategy_name), tableCell(formatMoney(row.deployed_usd)),
      tableCell(formatMoney(row.gross_edge_usd), pnlClass(row.gross_edge_usd)),
      tableCell(formatMoney(row.gross_relative_pnl_usd), pnlClass(row.gross_relative_pnl_usd)),
      tableCell(formatMoney(row.costs_usd), "negative"),
      tableCell(formatMoney(row.modeled_net_relative_pnl_usd), pnlClass(row.modeled_net_relative_pnl_usd)),
      tableCell(integer.format(row.held_observations))
    );
    body.append(tr);
  }
}

function renderPolicies(rows) {
  const root = byId("policy-cards"); clear(root);
  for (const row of rows) {
    const card = element("article", "policy-card");
    const header = document.createElement("header");
    header.append(element("h3", "", row.strategy_name), element("strong", pnlClass(row.modeled_net_relative_pnl_usd), formatMoney(row.modeled_net_relative_pnl_usd)));
    const dl = document.createElement("dl");
    for (const [label, value] of [
      ["열린 레인", integer.format(row.open_lane_count)], ["가상 배정", compactMoney.format(row.deployed_usd)],
      ["누적 Edge 추정", formatMoney(row.gross_edge_usd)], ["비용", formatMoney(row.costs_usd)],
    ]) {
      const group = document.createElement("div"); group.append(element("dt", "", label), element("dd", "", value)); dl.append(group);
    }
    card.append(header, dl); root.append(card);
  }
}

function renderBlockers(rows) {
  const root = byId("blockers"); clear(root);
  const maximum = Math.max(1, ...rows.map(row => row.count));
  for (const row of rows.slice(0, 8)) {
    const item = element("div", "blocker");
    item.append(element("span", "", row.label), element("strong", "", integer.format(row.count)));
    const bar = element("div", "bar");
    const fill = document.createElement("span");
    fill.className = `bar-${Math.max(1, Math.ceil(row.count / maximum * 10))}`;
    bar.append(fill); item.append(bar); root.append(item);
  }
}

function renderLeaderboard(groups) {
  const body = byId("leaderboard-body"); clear(body);
  const seen = new Set();
  const rows = [];
  for (const [group, items] of [["상위", groups.top || []], ["하위", groups.bottom || []]]) {
    for (const row of items) {
      const key = `${row.pair}:${row.chain_id}:${row.strategy}`;
      if (seen.has(key)) continue;
      seen.add(key); rows.push({ ...row, group });
    }
  }
  rows.forEach(row => {
    const tr = document.createElement("tr");
    tr.append(tableCell(row.group), tableCell(`${row.pair} · ${row.chain}`, "pair"), tableCell(row.strategy_name),
      tableCell(formatMoney(row.gross_edge_usd), pnlClass(row.gross_edge_usd)),
      tableCell(formatMoney(row.gross_relative_pnl_usd), pnlClass(row.gross_relative_pnl_usd)),
      tableCell(formatMoney(row.costs_usd), "negative"),
      tableCell(formatMoney(row.modeled_net_relative_pnl_usd), pnlClass(row.modeled_net_relative_pnl_usd)));
    body.append(tr);
  });
}

function renderCountChart(series) {
  const full = series.full_800 || [];
  const root = byId("count-chart"); const empty = byId("count-chart-empty"); clear(root);
  if (full.length < 3) { root.hidden = true; empty.hidden = false; return; }
  root.hidden = false; empty.hidden = true;
  const scoutByTime = new Map((series.scout_scale || []).map(row => [row.observed_at, row.open_lane_count]));
  const rows = full.map(row => ({
    observed_at: row.observed_at,
    eligible: Number(row.eligible_pool_count) || 0,
    open: (Number(row.open_lane_count) || 0) + (Number(scoutByTime.get(row.observed_at)) || 0),
  }));
  const width = 720, height = 300, pad = { left: 42, right: 14, top: 16, bottom: 34 };
  const max = Math.max(1, ...rows.flatMap(row => [row.eligible, row.open]));
  const times = rows.map(row => new Date(row.observed_at).getTime()); const minTime = Math.min(...times), maxTime = Math.max(...times);
  const x = value => pad.left + (value - minTime) / Math.max(1, maxTime - minTime) * (width - pad.left - pad.right);
  const y = value => pad.top + (max - value) / max * (height - pad.top - pad.bottom);
  const ns = "http://www.w3.org/2000/svg"; const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  for (let step = 0; step <= 4; step += 1) {
    const value = max * step / 4; const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", pad.left); line.setAttribute("x2", width - pad.right); line.setAttribute("y1", y(value)); line.setAttribute("y2", y(value)); line.setAttribute("class", "grid-line"); svg.append(line);
    const label = document.createElementNS(ns, "text"); label.setAttribute("x", pad.left - 8); label.setAttribute("y", y(value) + 4); label.setAttribute("text-anchor", "end"); label.textContent = integer.format(value); svg.append(label);
  }
  for (const [field, className] of [["eligible", "line-full"], ["open", "line-scout"]]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", rows.map((row, index) => `${index ? "L" : "M"}${x(new Date(row.observed_at).getTime()).toFixed(1)},${y(row[field]).toFixed(1)}`).join(" "));
    path.setAttribute("class", className); svg.append(path);
  }
  const start = document.createElementNS(ns, "text"); start.setAttribute("x", pad.left); start.setAttribute("y", height - 7); start.textContent = formatTime(rows[0].observed_at); svg.append(start);
  const end = document.createElementNS(ns, "text"); end.setAttribute("x", width - pad.right); end.setAttribute("y", height - 7); end.setAttribute("text-anchor", "end"); end.textContent = formatTime(rows.at(-1).observed_at); svg.append(end);
  root.append(svg);
}

function renderEvents(rows) {
  const root = byId("events"); clear(root); byId("events-empty").hidden = rows.length > 0;
  const labels = { open: "진입", scale: "증액", close: "철수" };
  for (const row of rows.slice(0, 16)) {
    const item = document.createElement("li");
    const copy = element("div", "event-copy");
    copy.append(element("strong", "", `${row.pair} · ${row.strategy_name}`), element("span", "", `${row.reason} · ${formatMoney(row.amount_usd)}`));
    item.append(element("span", "event-type", labels[row.event_type] || row.event_type), copy, element("time", "event-time", formatTime(row.observed_at)));
    root.append(item);
  }
}

function renderHealth(data) {
  const rows = [
    ["DB 무결성", data.health.database_integrity], ["데이터 신선도", data.health.fresh ? "정상" : "지연"],
    ["관측 주기", data.health.scheduler], ["거래 상태", data.health.trading_enabled ? "활성" : "비활성"],
    ["지갑 연결", data.health.wallet_connected ? "연결" : "없음"], ["증거 등급", data.evidence.level],
  ];
  const root = byId("health"); clear(root);
  for (const [label, value] of rows) { const group = document.createElement("div"); group.append(element("dt", "", label), element("dd", "", String(value))); root.append(group); }
}

function renderChart(series) {
  const root = byId("policy-chart"); const empty = byId("chart-empty"); clear(root);
  const all = Object.values(series).flat();
  if (all.length < 3 || Object.values(series).every(rows => rows.length < 3)) { root.hidden = true; empty.hidden = false; return; }
  root.hidden = false; empty.hidden = true;
  const width = 1000, height = 300, pad = { left: 58, right: 18, top: 16, bottom: 34 };
  const points = all.map(row => Number(row.modeled_net_relative_pnl_usd) || 0);
  let min = Math.min(0, ...points), max = Math.max(0, ...points); if (min === max) { min -= 1; max += 1; }
  const times = all.map(row => new Date(row.observed_at).getTime()); const minTime = Math.min(...times), maxTime = Math.max(...times);
  const x = value => pad.left + (value - minTime) / Math.max(1, maxTime - minTime) * (width - pad.left - pad.right);
  const y = value => pad.top + (max - value) / (max - min) * (height - pad.top - pad.bottom);
  const ns = "http://www.w3.org/2000/svg"; const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  for (let step = 0; step <= 4; step += 1) {
    const value = min + (max - min) * step / 4; const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", pad.left); line.setAttribute("x2", width - pad.right); line.setAttribute("y1", y(value)); line.setAttribute("y2", y(value)); line.setAttribute("class", Math.abs(value) < 1e-9 ? "zero-line" : "grid-line"); svg.append(line);
    const label = document.createElementNS(ns, "text"); label.setAttribute("x", pad.left - 9); label.setAttribute("y", y(value) + 4); label.setAttribute("text-anchor", "end"); label.textContent = money.format(value); svg.append(label);
  }
  for (const [strategy, rows] of Object.entries(series)) {
    if (rows.length < 2) continue;
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", rows.map((row, index) => `${index ? "L" : "M"}${x(new Date(row.observed_at).getTime()).toFixed(1)},${y(Number(row.modeled_net_relative_pnl_usd) || 0).toFixed(1)}`).join(" "));
    path.setAttribute("class", strategy === "full_800" ? "line-full" : "line-scout"); svg.append(path);
  }
  const start = document.createElementNS(ns, "text"); start.setAttribute("x", pad.left); start.setAttribute("y", height - 7); start.textContent = formatTime(new Date(minTime).toISOString()); svg.append(start);
  const end = document.createElementNS(ns, "text"); end.setAttribute("x", width - pad.right); end.setAttribute("y", height - 7); end.setAttribute("text-anchor", "end"); end.textContent = formatTime(new Date(maxTime).toISOString()); svg.append(end);
  root.append(svg);
}

function startCountdown(endsAt) {
  const update = () => {
    const seconds = Math.max(0, Math.floor((new Date(endsAt).getTime() - Date.now()) / 1000));
    const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
    setText("countdown", seconds ? `${days}일 ${hours}시간 ${minutes}분 남음` : "실험 종료");
  };
  update(); window.setInterval(update, 60_000);
}

function render(data) {
  setText("status-badge", data.status === "collecting" ? "수집 중" : "실험 종료");
  setText("last-update", `최근 갱신 ${formatTime(data.generated_at)}`);
  setText("run-meta", `${data.run.status} · ${data.run.run_id.slice(0, 25)}`);
  setText("evidence-warning", data.evidence.warning);
  startCountdown(data.experiment.ends_at);
  renderStrategyPolicy(data.strategy_policy);
  renderSummary(data); renderEligible(data.eligible_pools); renderPositions(data.active_positions);
  renderPolicies(data.policies); renderBlockers(data.blockers); renderLeaderboard(data.leaderboard);
  renderEvents(data.events); renderHealth(data); renderChart(data.policy_series); renderCountChart(data.policy_series);
}

async function load() {
  try {
    const response = await fetch(`${SNAPSHOT_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
    window.setTimeout(() => window.location.reload(), 60_000);
  } catch (error) {
    byId("error-banner").hidden = false;
    console.error("Metric dashboard load failed", error);
  }
}

load();
