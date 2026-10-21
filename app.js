"use strict";

const REFRESH_MS = 30000;
const $ = (id) => document.getElementById(id);
const safe = (value) => String(value ?? "-").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const number = (value, digits = 2) => Number.isFinite(Number(value)) ? new Intl.NumberFormat("ko-KR", {maximumFractionDigits: digits}).format(Number(value)) : "-";
const money = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-US", {style:"currency", currency:"USD", maximumFractionDigits:2}).format(Number(value)) : "-";
const signedMoney = (value) => {
  if (!Number.isFinite(Number(value))) return "-";
  const amount = Number(value);
  return `${amount > 0 ? "+" : ""}${money(amount)}`;
};
const percent = (value, ratio = false) => Number.isFinite(Number(value)) ? `${number(ratio ? Number(value) * 100 : Number(value), 2)}%` : "-";
const when = (value) => {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat("ko-KR", {dateStyle:"medium", timeStyle:"medium", timeZone:"Asia/Seoul"}).format(parsed);
};
const statusClass = (value) => value === "ok" ? "ok" : value === "critical" ? "critical" : "warning";
const strategyLabels = {stable_carry:"Stable Carry", bluechip_cl:"Blue-chip CL", gauge_farm:"Gauge Farm"};
const policyLabels = {daily_defensive:"일일 수확·방어형", threshold_balanced:"비용 임계·균형형", weekly_aggressive:"주간 수확·공격형"};
const riskLabels = {depeg_risk:"디페그", eur_usd_fx_risk:"EUR/USD 환율", reward_token_risk:"보상 토큰", range_risk:"범위 이탈"};

function metric(label, value, detail = "", tone = "") {
  return `<div class="metric"><span class="label">${safe(label)}</span><span class="value ${tone}">${safe(value)}</span>${detail ? `<span class="detail">${safe(detail)}</span>` : ""}</div>`;
}

function renderHeader(snapshot, research) {
  const health = snapshot.health || "warning";
  $("health-badge").className = `badge ${statusClass(health)}`;
  $("health-badge").textContent = health === "ok" ? "정상" : health === "critical" ? "중단 필요" : "주의";
  $("state-badge").className = "badge neutral";
  $("state-badge").textContent = research.status || "RESEARCH_ONLY";
  $("generated-at").textContent = `생성 ${when(research.generated_at || snapshot.generated_at)} · 30초 화면 갱신`;
  const warnings = snapshot.completeness?.warnings || [];
  const banner = $("alert-banner");
  if (!research.available || health === "critical") {
    banner.className = "alert critical";
    banner.textContent = !research.available ? "글로벌 LP 연구 스냅샷을 읽을 수 없습니다." : `시스템 상태 ${health.toUpperCase()}`;
  } else if (warnings.some((item) => String(item).startsWith("global_research"))) {
    banner.className = "alert";
    banner.textContent = `연구 데이터 점검 필요: ${warnings.filter((item) => String(item).startsWith("global_research")).join(", ")}`;
  } else {
    banner.className = "alert hidden";
  }
}

function renderOverview(research) {
  const portfolio = research.portfolio || {};
  const run = research.run || {};
  const audit = research.audit || {};
  const target = portfolio.target_notional_usd ?? 0;
  const allocated = portfolio.allocated_usd ?? 0;
  const idle = portfolio.idle_cash_usd ?? Math.max(0, target - allocated);
  $("overview-cards").innerHTML = [
    metric("연구 상태", research.status === "RESEARCH_ONLY" ? "연구 중" : (research.status || "-"), research.program || "-"),
    metric("총 연구자금", money(target), "실제 투자 아님"),
    metric("연구 배정", money(allocated), `${number(research.allocations?.length || 0, 0)}개 풀`),
    metric("현금 대기", money(idle), "조건 미달 자금"),
    metric("적격 후보", number(run.eligible_candidates || research.candidate_watchlist?.length || 0, 0), `${number(run.screened_candidates || 0, 0)}개 선별`),
    metric("성숙 Forward", number(audit.versioned_forward_count || 0, 0), "완성 전 수익 주장 금지"),
  ].join("");
  const authority = research.authority || {};
  $("authority-strip").innerHTML = [
    `<span>실거래 ${authority.live_trading ? "활성" : "비활성"}</span>`,
    `<span>페이퍼 진입 ${authority.paper_entries ? "활성" : "비활성"}</span>`,
    `<span>지갑 접근 ${authority.wallet_access ? "활성" : "비활성"}</span>`,
    `<span>데이터원 ${safe(research.source?.provider || "-")}</span>`,
    `<span>가격 ${safe(research.source?.price_provider || "-")}</span>`,
  ].join("");
}

function renderStrategies(research) {
  const strategies = research.strategies || {};
  const evaluations = research.strategy_evaluations || [];
  $("global-research-status").textContent = `${research.program || "-"} · ${research.status || "-"}`;
  $("global-strategies").innerHTML = Object.entries(strategies).map(([key, item]) => {
    const strategyEvaluations = evaluations.filter((evaluation) => evaluation.strategy === key);
    const modelEligible = strategyEvaluations.filter((evaluation) => evaluation.eligible_for_allocation).length;
    const objectives = [...new Set(strategyEvaluations.map((evaluation) => evaluation.objective_name).filter(Boolean))];
    return `<article class="position-card research-card">
    <strong>${safe(strategyLabels[key] || key)}</strong>
    <div class="kv"><span>예산</span><b>${money(item.target_notional_usd)}</b></div>
    <div class="kv"><span>연구 배정</span><b>${money(item.allocated_usd)}</b></div>
    <div class="kv"><span>현금 대기</span><b>${money(item.idle_cash_usd)}</b></div>
    <div class="kv"><span>적격 후보</span><b>${number(item.eligible_candidate_count || 0, 0)}</b></div>
    <div class="kv"><span>전략 모델 통과</span><b>${number(modelEligible, 0)}</b></div>
    <div class="kv"><span>목적함수</span><b>${safe(objectives[0] || "기본 후보 선별")}</b></div>
    <div class="kv"><span>평가 기간</span><b>${safe((item.horizons_days || []).map((day) => `${day}일`).join(" · ") || "-")}</b></div>
  </article>`;
  }).join("") || `<div class="empty">전략별 연구 결과가 없습니다.</div>`;
}

function pnlTone(value) {
  const amount = Number(value);
  return amount > 0 ? "positive" : amount < 0 ? "negative" : "";
}

function renderGaugeLab(research) {
  const lab = research.gauge_candidate_lab || {};
  const cards = $("gauge-lab-cards");
  const policyTable = $("gauge-policy-table");
  const laneTable = $("gauge-lane-table");
  if (!lab.enabled || !Number(lab.lane_count || 0)) {
    $("gauge-lab-updated").textContent = "Candidate Lab 비활성 또는 데이터 없음";
    cards.innerHTML = metric("상태", "데이터 없음", "자동 관측 대기");
    policyTable.innerHTML = `<tr><td colspan="7" class="empty">정책별 손익 데이터가 없습니다.</td></tr>`;
    laneTable.innerHTML = `<tr><td colspan="7" class="empty">Gauge 레인 데이터가 없습니다.</td></tr>`;
    return;
  }
  const minimumClosed = Number(lab.minimum_closed_samples_for_winner || 0);
  const winnerConfirmed = lab.winner_status === "confirmed";
  $("gauge-lab-updated").textContent = `최근 관측 ${when(lab.updated_at)} · 15분 자동 갱신`;
  cards.innerHTML = [
    metric("실험 레인", number(lab.lane_count, 0), `${number(lab.policy_count, 0)}개 정책 · 후보당 ${money(lab.notional_per_candidate_usd)}`),
    metric("레인당 평균 평가손익", signedMoney(lab.average_marked_net_usd), "프록시·즉시 청산비용 반영", pnlTone(lab.average_marked_net_usd)),
    metric("실현 순수익", signedMoney(lab.total_realized_net_usd), `${number(lab.closed_count, 0)}개 종료 레인`, pnlTone(lab.total_realized_net_usd)),
    metric("현금화 보상", money(lab.total_harvested_usd), `수확비용 ${money(lab.total_harvest_cost_usd)}`),
    metric("누적 관측", number(lab.observation_count, 0), `${number(lab.open_count, 0)}개 레인 운용 중`),
    metric("정책 판정", winnerConfirmed ? "확정 가능" : "예비", `종료 ${number(lab.closed_count, 0)}/${number(minimumClosed, 0)}개`, winnerConfirmed ? "positive" : ""),
  ].join("");
  const summaries = lab.policy_summaries || [];
  policyTable.innerHTML = summaries.length ? summaries.map((item) => `<tr>
    <td><span class="pool-name">${safe(policyLabels[item.policy_id] || item.policy_id)}</span><span class="quality">${safe(item.policy_id)}</span></td>
    <td>${number(item.lane_count, 0)}개<br><span class="muted">운용 ${number(item.open_count, 0)}</span></td>
    <td class="${pnlTone(item.average_net_usd)}">${signedMoney(item.average_net_usd)}</td>
    <td><span class="positive">${signedMoney(item.best_net_usd)}</span><br><span class="negative">${signedMoney(item.worst_net_usd)}</span></td>
    <td class="${pnlTone(item.realized_net_usd)}">${signedMoney(item.realized_net_usd)}</td>
    <td>${money(item.harvested_usd)}<br><span class="muted">비용 ${money(item.harvest_cost_usd)}</span></td>
    <td>${number(item.closed_count, 0)}개<br><span class="muted">승률 ${item.win_rate == null ? "표본 없음" : percent(item.win_rate, true)}</span></td>
  </tr>`).join("") : `<tr><td colspan="7" class="empty">정책별 집계가 없습니다.</td></tr>`;
  const lanes = lab.leaderboard || [];
  laneTable.innerHTML = lanes.length ? lanes.slice(0, 12).map((item) => {
    const currentNet = item.status === "closed" ? item.realized_net_usd : item.marked_net_usd;
    return `<tr>
      <td><span class="pool-name">${safe(item.symbol || item.pool_id)}</span><span class="quality">${safe(item.chain)} · ${safe(item.project)}</span></td>
      <td>${safe(policyLabels[item.policy_id] || item.policy_id)}</td>
      <td class="${pnlTone(currentNet)}">${signedMoney(currentNet)}<span class="quality">${item.evidence_status === "proxy_complete" ? "프록시" : safe(item.evidence_status)}</span></td>
      <td class="${pnlTone(item.realized_net_usd)}">${item.realized_net_usd == null ? "미종료" : signedMoney(item.realized_net_usd)}</td>
      <td>${money(item.harvested_usd)}<span class="quality">대기보상 ${money(item.pending_reward_value_usd)}</span></td>
      <td><span class="verdict ${item.status === "closed" ? "blocked" : "pass"}">${item.status === "closed" ? "종료" : "운용 중"}</span><span class="quality">${safe(item.last_action || "-")}</span></td>
      <td>${when(item.latest_observed_at)}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="empty">현재 레인이 없습니다.</td></tr>`;
}

function renderAllocations(research) {
  const allocations = research.allocations || [];
  $("global-allocation-table").innerHTML = allocations.length ? allocations.map((item) => `<tr>
    <td>${safe(strategyLabels[item.strategy] || item.strategy)}</td>
    <td><span class="pool-name">${safe(item.symbol || item.pool_id)}</span><span class="pool-key" title="${safe(item.pool_id)}">${safe(item.pool_id)}</span></td>
    <td>${safe(item.chain)}<br><span class="muted">${safe(item.project)}</span></td>
    <td>${money(item.notional_usd)}</td>
    <td>${percent(item.robust_apy_30d)}<br><span class="muted">현재 ${percent(item.effective_apy)}</span></td>
    <td>${number(item.history_sample_count || 0, 0)}개<br><span class="muted">지속 ${percent(item.persistence_30d, true)}</span></td>
    <td><span class="verdict pass">연구 추적</span><span class="quality">실제 배정 아님</span></td>
  </tr>`).join("") : `<tr><td colspan="7" class="empty">현재 연구 배정이 없습니다. 자금은 현금 대기 상태입니다.</td></tr>`;
}

function renderWatchlist(research) {
  const items = research.candidate_watchlist || [];
  $("watchlist-summary").textContent = `${number(items.length, 0)}개 적격 후보 · 강건 APY 순`;
  $("watchlist-table").innerHTML = items.length ? items.map((item) => {
    const values = item.valuation_inputs || {};
    const underlying = `${number(values.underlying_prices_resolved || 0, 0)}/${number(values.underlying_prices_expected || 0, 0)}`;
    const rewardExpected = Number(values.reward_prices_expected || 0);
    const reward = rewardExpected ? ` · 보상 ${number(values.reward_prices_resolved || 0, 0)}/${number(rewardExpected, 0)}` : "";
    const risks = (item.risk_flags || []).map((risk) => riskLabels[risk] || risk).join(" · ") || "없음";
    return `<tr>
      <td>${safe(strategyLabels[item.strategy] || item.strategy)}</td>
      <td><span class="pool-name">${safe(item.symbol || item.pool_id)}</span><span class="pool-key" title="${safe(item.pool_id)}">${safe(item.pool_id)}</span></td>
      <td>${safe(item.chain)}<br><span class="muted">${safe(item.project)}</span></td>
      <td>${money(item.tvl_usd)}</td>
      <td>${percent(item.robust_apy_30d)}<br><span class="muted">현재 ${percent(item.effective_apy)}</span></td>
      <td>기초 ${safe(underlying + reward)}</td>
      <td><span class="quality risk-text">${safe(risks)}</span></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="empty">현재 적격 후보가 없습니다.</td></tr>`;
}

function renderValidation(research) {
  const forward = research.forward || {};
  const audit = research.audit || {};
  const priceErrors = research.source?.price_lookup_errors || 0;
  const versionOk = Boolean(audit.snapshot_version_matches);
  $("validation-cards").innerHTML = [
    metric("완료 Forward", number(audit.versioned_forward_count || 0, 0), "버전 격리 원장"),
    metric("가치평가 완료", number(forward.valuation_complete || 0, 0), "가격·IL·비용·청산"),
    metric("가격 조회 오류", number(priceErrors, 0), safe(research.source?.price_provider || "-"), Number(priceErrors) === 0 ? "positive" : "negative"),
    metric("버전 계약", versionOk ? "일치" : "불일치", `${research.program || "-"}`, versionOk ? "positive" : "negative"),
  ].join("");
  const authority = research.authority || {};
  const permissionNote = !authority.entry_enabled && !authority.live_trading && !authority.paper_entries && !authority.wallet_access
    ? "실거래·페이퍼 진입·지갑 접근 모두 비활성"
    : "권한 상태 확인 필요";
  $("global-limitations").innerHTML = [
    permissionNote,
    "강건 APY는 후보 선별 프록시이며 실현 순수익이 아님",
    "가격·재고·IL·범위 이탈·실행 가능한 청산 견적이 완성돼야 수익 판정",
    "조건을 통과하지 못한 전략 예산은 다른 풀에 강제 배정하지 않고 현금 대기",
  ].map((item) => `<div>· ${safe(item)}</div>`).join("");
}

function renderOperations(snapshot) {
  const operations = snapshot.operations || {};
  const services = operations.services || {};
  const activeKeys = ["global_shadow", "gauge_lab", "dashboard_snapshot", "dashboard_publish", "dashboard_web"];
  $("service-cards").innerHTML = activeKeys.filter((key) => services[key]).map((key) => {
    const item = services[key];
    return `<article class="service-card ${item.ok ? "ok" : "bad"}">
      <span class="label">${safe(key)}</span>
      <div class="status-line"><strong>${item.ok ? "정상" : "이상"}</strong><span>${safe(item.active_state)} / ${safe(item.sub_state)}</span></div>
      <div class="kv"><span>최근</span><b>${when(item.last_trigger)}</b></div>
      <div class="kv"><span>다음</span><b>${when(item.next_trigger)}</b></div>
    </article>`;
  }).join("");
  const globalIntegrity = operations.database_integrity?.global;
  const checks = [
    {name:"Global LP 원장", ok:Boolean(globalIntegrity?.ok), detail:globalIntegrity?.status || "미확인"},
    {name:"스냅샷 버전", ok:Boolean(snapshot.global_research?.audit?.snapshot_version_matches), detail:snapshot.global_research?.program || "미확인"},
    {name:"읽기 전용", ok:Boolean(snapshot.authority?.dashboard_read_only), detail:snapshot.authority?.dashboard_read_only ? "유지" : "확인 필요"},
  ];
  $("integrity").innerHTML = checks.map((item) => `<div class="check ${item.ok ? "ok" : "bad"}"><span>${safe(item.name)}</span><span>${safe(item.detail)}</span></div>`).join("");
}

function render(snapshot) {
  const research = snapshot.global_research || {};
  renderHeader(snapshot, research);
  renderOverview(research);
  renderStrategies(research);
  renderGaugeLab(research);
  renderAllocations(research);
  renderWatchlist(research);
  renderValidation(research);
  renderOperations(snapshot);
}

async function refresh() {
  const status = $("refresh-status");
  status.textContent = "갱신 중";
  try {
    const response = await fetch(`./dashboard-snapshot.json?t=${Date.now()}`, {cache: "no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
    status.textContent = `최근 화면 갱신 ${new Intl.DateTimeFormat("ko-KR", {timeStyle:"medium"}).format(new Date())}`;
  } catch (error) {
    status.textContent = `화면 갱신 실패: ${error.message}`;
    $("health-badge").className = "badge critical";
    $("health-badge").textContent = "스냅샷 연결 실패";
  }
}

refresh();
window.setInterval(refresh, REFRESH_MS);
