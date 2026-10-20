"use strict";

const REFRESH_MS = 30000;

const $ = (id) => document.getElementById(id);
const safe = (value) => String(value ?? "-").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[char]));
const number = (value, digits = 2) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString("ko-KR", {maximumFractionDigits: digits}) : "-";
const money = (value) => Number.isFinite(Number(value))
  ? `${Number(value) >= 0 ? "" : "-"}$${Math.abs(Number(value)).toLocaleString("en-US", {maximumFractionDigits: 2})}` : "-";
const percent = (value, alreadyPercent = false) => Number.isFinite(Number(value))
  ? `${number(alreadyPercent ? Number(value) : Number(value) * 100, 2)}%` : "-";
const when = (value) => {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleString("ko-KR", {timeZone: "Asia/Seoul"});
};
const statusClass = (value) => value === "ok" ? "ok" : value === "critical" ? "critical" : "warning";

function metric(label, value, detail = "", tone = "") {
  return `<div class="metric"><span class="label">${safe(label)}</span><span class="value ${tone}">${safe(value)}</span>${detail ? `<span class="detail">${safe(detail)}</span>` : ""}</div>`;
}

function renderHeader(snapshot) {
  const health = snapshot.health || "warning";
  const state = snapshot.status?.state || "UNKNOWN";
  $("health-badge").className = `badge ${statusClass(health)}`;
  $("health-badge").textContent = health === "ok" ? "정상" : health === "critical" ? "중단 필요" : "주의";
  $("state-badge").className = `badge ${state.startsWith("PAUSED") ? "critical" : "neutral"}`;
  $("state-badge").textContent = state;
  $("generated-at").textContent = `생성 ${when(snapshot.generated_at)} · 30초 화면 갱신`;
  const warnings = snapshot.completeness?.warnings || [];
  const banner = $("alert-banner");
  if (health !== "ok" || warnings.length) {
    banner.className = `alert ${health === "critical" ? "critical" : ""}`;
    banner.textContent = `상태: ${health.toUpperCase()} · ${warnings.length ? warnings.join(", ") : snapshot.status?.reason || "운영 점검 필요"}`;
  } else {
    banner.className = "alert hidden";
  }
}

function renderOverview(snapshot) {
  const capital = snapshot.capital || {};
  const forward = snapshot.forward || {};
  const funnel = snapshot.funnel || {};
  const positions = snapshot.positions || [];
  const openPositions = positions.filter((item) => item.status === "open").length;
  const dayPnl = Number(capital.realized_pnl_usd?.day || 0);
  $("overview-cards").innerHTML = [
    metric("총 가상자금", money(capital.total_usd)),
    metric("LP 투입", money(capital.deployed_usd), `${openPositions}개 오픈`),
    metric("스테이블 대기", money(capital.stable_reserve_usd)),
    metric("오늘 실현손익", money(dayPnl), "스테이블 환산", dayPnl >= 0 ? "positive" : "negative"),
    metric("A+ 후보", number(funnel.stages?.aggressive_a_plus || 0, 0), `${number(funnel.observed || 0, 0)}개 관측`),
    metric("30분 Shadow", number(funnel.stages?.aggressive_fast_exit || 0, 0), "진입 비활성"),
    metric("Forward 창", number(forward.total || forward.total_windows || 0, 0), `승격 ${forward.validation_gate_passed ? "충족" : "미충족"}`),
  ].join("");
  const authority = snapshot.authority || {};
  $("authority-strip").innerHTML = [
    `<span>전략 ${safe(snapshot.strategy_version)}</span>`,
    `<span>실거래 ${authority.live_enabled ? "활성" : "비활성"}</span>`,
    `<span>신규 페이퍼 진입 ${authority.paper_entries_enabled ? "활성" : "비활성"}</span>`,
    `<span>관제 ${authority.dashboard_read_only ? "읽기 전용" : "권한 확인 필요"}</span>`,
    `<span>데이터 ${safe(snapshot.completeness?.status || "-")}</span>`,
  ].join("");
}

const stageLabels = {
  observed: "원시 관측", market_filtered: "시장조건", fee_verified: "LP 수수료", active_liquidity_verified: "활성유동성",
  round_trip_verified: "왕복경로", risk_verified: "보안·위험", aggressive_a_plus: "A+ 공격형", aggressive_fast_exit: "30분 Shadow"
};

function renderFunnel(snapshot) {
  const stages = snapshot.funnel?.stages || {};
  const entries = Object.entries(stages);
  const maximum = Math.max(1, ...entries.map(([, value]) => Number(value) || 0));
  $("funnel").innerHTML = entries.map(([key, value]) => `
    <div class="funnel-row">
      <span class="funnel-label">${safe(stageLabels[key] || key)}</span>
      <progress class="funnel-track" max="${maximum}" value="${Math.max(0, Number(value) || 0)}" aria-label="${safe(key)} ${safe(value)}"></progress>
      <span class="funnel-value">${number(value, 0)}</span>
    </div>`).join("");
  const blockerSource = snapshot.funnel?.blockers || {};
  const blockers = Array.isArray(blockerSource)
    ? blockerSource
    : Object.entries(blockerSource).map(([name, count]) => ({name, count}));
  $("blockers").innerHTML = blockers.length
    ? blockers.slice(0, 12).map((item) => `<span class="blocker">${safe(item.name || item.blocker || item[0])} · ${number(item.count ?? item[1], 0)}</span>`).join("")
    : `<span class="muted">집계된 탈락 사유가 없습니다.</span>`;
}

function qualityText(quality = {}) {
  return Object.entries(quality).map(([key, value]) => `${key}:${value}`).join(" · ");
}

function renderCandidates(snapshot) {
  const candidates = snapshot.candidates || {};
  const items = candidates.items || [];
  $("candidate-summary").textContent = `${number(candidates.total_observed, 0)}개 관측 · 경제성 검증 ${number(candidates.reliable_count, 0)}개 · 상위 ${number(items.length, 0)}개 표시`;
  $("candidate-table").innerHTML = items.length ? items.slice(0, 30).map((item) => {
    const blockers = item.blockers || [];
    const pass = Boolean(item.aggressive_eligible);
    const reliable = item.economics_status === "reliable";
    const economics = reliable
      ? `<span class="${Number(item.expected_net_3h_usd) >= 0 ? "positive" : "negative"}">${money(item.expected_net_3h_usd)}</span><br><span class="muted">${percent(item.expected_net_3h_rate)}</span>`
      : `<span class="muted">검증 불가</span>`;
    return `<tr>
      <td><span class="pool-name">${safe(item.pair || item.name)}</span><span class="pool-key" title="${safe(item.pool_key || item.address)}">${safe(item.pool_key || item.address)}</span></td>
      <td>${safe(item.network)}<br><span class="muted">${safe(item.dex)}</span></td>
      <td>${money(item.tvl_usd)}</td>
      <td>${number(item.volume_acceleration)}×</td>
      <td>${economics}</td>
      <td>${reliable ? number(item.fee_to_risk_ratio) : `<span class="muted">검증 불가</span>`}</td>
      <td><span class="verdict ${pass ? "pass" : "blocked"}">${pass ? "A+" : `차단 ${blockers.length}`}</span><span class="quality">${safe(pass ? "진입 후보" : blockers.slice(0, 2).join(", ") || "검증 미완료")}</span><span class="quality">${safe(qualityText(item.quality))}</span></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="empty">최근 후보가 없습니다.</td></tr>`;
}

function renderPositions(snapshot) {
  const positions = snapshot.positions || [];
  $("positions").innerHTML = positions.length ? positions.map((item) => {
    const pnl = Number(item.realized_pnl_usd ?? item.estimated_pnl_usd ?? item.unrealized_pnl_usd ?? 0);
    return `<article class="position-card ${item.status === "open" ? "open" : ""}">
      <strong>${safe(item.name || item.pair || item.pool_name || item.pool_key)}</strong>
      <div class="kv"><span>상태</span><b>${safe(item.status)}</b></div>
      <div class="kv"><span>DEX</span><b>${safe(item.network || "-")} · ${safe(item.dex || "-")}</b></div>
      <div class="kv"><span>투입금</span><b>${money(item.notional_usd)}</b></div>
      <div class="kv"><span>누적 수수료</span><b>${money(item.accrued_fees_usd)}</b></div>
      <div class="kv"><span>순손익</span><b class="${pnl >= 0 ? "positive" : "negative"}">${money(pnl)}</b></div>
      <div class="kv"><span>진입</span><b>${when(item.opened_at)}</b></div>
      <div class="kv"><span>청산</span><b>${when(item.closed_at)}</b></div>
      <div class="kv"><span>청산 사유</span><b>${safe(item.exit_reason || "-")}</b></div>
    </article>`;
  }).join("") : `<div class="empty">현재 기록된 가상 포지션이 없습니다.</div>`;
}

function renderForward(snapshot) {
  const forward = snapshot.forward || {};
  const groups = forward.groups || [];
  const list = Array.isArray(groups) ? groups : Object.entries(groups).map(([horizon, value]) => ({horizon, ...value}));
  $("validation-gate").textContent = forward.validation_gate_passed
    ? "Forward 승격 표본 조건 충족" : `승격 미충족 · 필요 ${number(forward.required_windows || 30, 0)}창 / ${number(forward.required_independent_days || 20, 0)}일`;
  $("forward-cards").innerHTML = list.length ? list.map((item) => metric(
    `${safe(item.horizon || item.horizon_minutes + "m")}`,
    `${percent(item.positive_rate || 0)} 양수`,
    `중앙 ${money(item.median_pnl_usd)} · ${number(item.scored || item.scored_count || 0, 0)}건`,
    Number(item.median_pnl_usd) >= 0 ? "positive" : "negative"
  )).join("") : metric("Forward", "증거 부족", "성숙 결과 없음");
  const limitations = forward.limitations || [];
  $("forward-limitations").innerHTML = limitations.map((item) => `<div>· ${safe(item)}</div>`).join("");
}

function renderOperations(snapshot) {
  const operations = snapshot.operations || {};
  const services = operations.services || {};
  $("service-cards").innerHTML = Object.entries(services).map(([key, item]) => `
    <article class="service-card ${item.ok ? "ok" : "bad"}">
      <span class="label">${safe(key)}</span>
      <div class="status-line"><strong>${item.ok ? "정상" : "이상"}</strong><span>${safe(item.active_state)} / ${safe(item.sub_state)}</span></div>
      <div class="kv"><span>단위</span><b>${safe(item.unit)}</b></div>
      <div class="kv"><span>최근</span><b>${when(item.last_trigger)}</b></div>
      <div class="kv"><span>다음</span><b>${when(item.next_trigger)}</b></div>
    </article>`).join("");
  const runs = operations.latest_runs || [];
  $("run-table").innerHTML = runs.length ? runs.slice(0, 12).map((run) => `<tr>
    <td>${safe(run.component)}</td><td>${safe(run.status)}</td><td>${when(run.finished_at)}</td><td>${safe(run.error_type || run.error || "-")}</td>
  </tr>`).join("") : `<tr><td colspan="4" class="empty">실행 기록이 없습니다.</td></tr>`;
  const integrity = operations.database_integrity || {};
  const checks = snapshot.reconciliation?.checks || [];
  $("integrity").innerHTML = [
    ...Object.entries(integrity).map(([key, value]) => ({name: `DB ${key}`, ok: value.ok, detail: value.status || value.error || "ok"})),
    ...checks.map((check) => ({name: check.name, ok: check.ok, detail: check.ok ? "일치" : "불일치"})),
  ].map((item) => `<div class="check ${item.ok ? "ok" : "bad"}"><span>${safe(item.name)}</span><span>${safe(item.detail)}</span></div>`).join("");
}

function render(snapshot) {
  renderHeader(snapshot);
  renderOverview(snapshot);
  renderFunnel(snapshot);
  renderCandidates(snapshot);
  renderPositions(snapshot);
  renderForward(snapshot);
  renderOperations(snapshot);
}

async function refresh() {
  const status = $("refresh-status");
  status.textContent = "갱신 중";
  try {
    const response = await fetch(`./dashboard-snapshot.json?t=${Date.now()}`, {cache: "no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
    status.textContent = `최근 화면 갱신 ${new Date().toLocaleTimeString("ko-KR")}`;
  } catch (error) {
    status.textContent = `화면 갱신 실패: ${error.message}`;
    $("health-badge").className = "badge critical";
    $("health-badge").textContent = "스냅샷 연결 실패";
  }
}

refresh();
window.setInterval(refresh, REFRESH_MS);
