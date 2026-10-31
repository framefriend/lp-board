"use strict";

const CONTROL_ROOT = "/metric-console/control";
const EXTERNAL_CONTROL = window.location.pathname.startsWith(CONTROL_ROOT);
const EXTERNAL_READ_ONLY = window.location.pathname.startsWith("/metric-console") && !EXTERNAL_CONTROL;
const API_ROOT = EXTERNAL_CONTROL ? `${CONTROL_ROOT}/api/ops` : "/api/ops";
const PUBLIC_SNAPSHOT_URL = "./dashboard-snapshot.json";
const BSC_CHAIN = {
  chainId: "0x38",
  chainName: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: ["https://bsc-dataseed.bnbchain.org"],
  blockExplorerUrls: ["https://bscscan.com"],
};
const EXTERNAL_CONTROL_COMMANDS = new Set(["connect", "lock", "pause-entries", "exit-only", "acknowledge-alert"]);
const VALID_VIEWS = new Set(["overview", "position", "opportunities", "wallet", "activity"]);
const VIEW_TITLES = {
  overview: "운영 개요",
  position: "운용 포지션",
  opportunities: "기회 탐색",
  wallet: "실행 지갑",
  activity: "활동 · 경보",
};
const CONFIRMATIONS = {
  activate: {
    title: "라이브 자동운영을 시작할까요?",
    description: "서버의 라이브 설정, RPC, 가스, 미결 거래와 경보가 다시 검증됩니다. 지갑 연결만으로는 거래가 시작되지 않습니다.",
    phrase: "ACTIVATE",
    tone: "danger",
  },
  disconnect: {
    title: "실행지갑 연결을 해제할까요?",
    description: "미결 거래나 관리 포지션이 있으면 서버가 해제를 거부합니다. 운영 중지만 원하면 먼저 운영 잠금을 사용하세요.",
    phrase: "DISCONNECT",
    tone: "danger",
  },
  "emergency-close": {
    title: "긴급 전량 철수를 요청할까요?",
    description: "신규 진입을 즉시 잠그고 Executor를 Exit-only로 전환합니다. 열린 관리 포지션이 없으면 요청은 거부됩니다.",
    phrase: "CLOSE",
    tone: "danger",
  },
  "exit-only": {
    title: "Exit-only로 전환할까요?",
    description: "신규 진입을 차단하고 기존 관리 포지션의 감시와 안전 철수만 허용합니다.",
    tone: "warning",
  },
};

const state = {
  csrfToken: "",
  snapshot: null,
  activeView: "overview",
  loading: true,
  busy: false,
  pollTimer: null,
  toastTimer: null,
  pendingCommand: null,
  walletProvider: null,
  candidateStatus: new URL(window.location.href).searchParams.get("candidateStatus") || "all",
  candidateSearch: new URL(window.location.href).searchParams.get("candidateSearch") || "",
};

const $ = (id) => document.getElementById(id);
const qsa = (selector) => Array.from(document.querySelectorAll(selector));

const money = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const preciseMoney = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 });
const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("ko-KR", { style: "percent", maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(source, paths, fallback = null) {
  for (const path of paths) {
    let current = source;
    for (const key of path.split(".")) current = current && typeof current === "object" ? current[key] : undefined;
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return fallback;
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.items)) return value.items;
  return Object.entries(value).map(([key, item]) => (item && typeof item === "object" ? { key, ...item } : { key, value: item }));
}

function formatMoney(value) {
  const parsed = asNumber(value);
  return parsed === null ? "—" : money.format(parsed);
}

function formatMoneyPrecise(value) {
  const parsed = asNumber(value);
  return parsed === null ? "—" : preciseMoney.format(parsed);
}

function formatNumber(value, suffix = "") {
  const parsed = asNumber(value);
  return parsed === null ? "—" : `${number.format(parsed)}${suffix}`;
}

function formatPercent(value, assumePercent = true) {
  const parsed = asNumber(value);
  if (parsed === null) return "—";
  return percent.format(assumePercent ? parsed / 100 : parsed);
}

function formatCompactMoney(value) {
  const parsed = asNumber(value);
  return parsed === null ? "—" : `$${compact.format(parsed)}`;
}

function formatDate(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : dateTime.format(parsed);
}

function shortAddress(value) {
  const text = String(value || "");
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text || "—";
}

function humanize(value) {
  const labels = {
    idle: "대기",
    opening: "진입 중",
    open: "운용 중",
    closing: "철수 중",
    needs_attention: "확인 필요",
    entry_paused: "신규 진입 잠금",
    hold: "보유 유지",
    rotate: "풀 교체",
    enter: "신규 진입",
    wait: "대기",
    kill_switch_active: "킬 스위치 활성",
    executor_needs_attention: "Executor 확인 필요",
    executor_pending: "미결 거래 존재",
  };
  const normalized = String(value ?? "").toLowerCase();
  return labels[normalized] || String(value ?? "—").replaceAll("_", " ");
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function createNode(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.title !== undefined) node.title = String(options.title);
  if (options.dateTime !== undefined) node.setAttribute("datetime", String(options.dateTime));
  node.append(...children);
  return node;
}

function emptyStateNodes(title, detail) {
  return [createNode("strong", { text: title }), createNode("p", { text: detail })];
}

function labeledMetric(className, label, value, detail = null) {
  const children = [createNode("span", { text: label }), createNode("strong", { text: value })];
  if (detail !== null) children.push(createNode("span", { text: detail }));
  return createNode("div", { className }, children);
}

function dataRow(label, value, title = null) {
  return createNode("div", { className: "data-row" }, [
    createNode("span", { text: label }),
    createNode("strong", { text: value, ...(title === null ? {} : { title }) }),
  ]);
}

function showToast(message, isError = false) {
  const toast = $("toast");
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.hidden = false;
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, 5200);
  $("live-region").textContent = message;
}

function currentView() {
  const requested = new URL(window.location.href).searchParams.get("view") || "overview";
  return VALID_VIEWS.has(requested) ? requested : "overview";
}

function selectView(view, push = false) {
  const next = VALID_VIEWS.has(view) ? view : "overview";
  state.activeView = next;
  qsa(".view").forEach((section) => { section.hidden = section.dataset.view !== next; });
  qsa("[data-view-link]").forEach((link) => {
    if (link.dataset.viewLink === next) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  setText("page-title", VIEW_TITLES[next]);
  if (push) {
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    history.pushState({ view: next }, "", url);
  }
  document.body.classList.remove("menu-open");
  $("mobile-menu").setAttribute("aria-expanded", "false");
  $("mobile-menu").setAttribute("aria-label", "탐색 메뉴 열기");
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `요청 실패 (${response.status})`);
    error.status = response.status;
    error.code = payload.code || "request_failed";
    throw error;
  }
  return payload;
}

async function ensureExternalAuthentication() {
  if (!EXTERNAL_CONTROL) return true;
  const status = await fetchJson(`${CONTROL_ROOT}/auth/status`);
  if (status.authenticated) {
    $("auth-gate").hidden = true;
    $("logout-button").hidden = false;
    return true;
  }
  $("auth-gate").hidden = false;
  $("logout-button").hidden = true;
  setText("auth-description", status.configured
    ? "등록된 관리자 OKX Wallet로 로그인 메시지를 서명해 주세요."
    : "관리자 지갑 등록이 아직 완료되지 않아 제어 콘솔이 잠겨 있습니다.");
  $("wallet-signin-button").disabled = !status.configured;
  return false;
}

function isOkxProvider(detail) {
  const rdns = String(detail?.info?.rdns || "").toLowerCase();
  const name = String(detail?.info?.name || "").toLowerCase();
  return rdns.includes("okx") || rdns.includes("okex") || name.includes("okx");
}

async function discoverOkxProvider(timeoutMs = 450) {
  const discovered = [];
  const onAnnounce = (event) => {
    if (isOkxProvider(event.detail) && event.detail?.provider) discovered.push(event.detail.provider);
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);
  const injected = globalThis.okxwallet;
  return discovered[0] || injected?.ethereum || injected || null;
}

async function ensureBscNetwork(provider) {
  const current = await provider.request({ method: "eth_chainId" });
  if (String(current).toLowerCase() === BSC_CHAIN.chainId) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BSC_CHAIN.chainId }] });
  } catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [BSC_CHAIN] });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BSC_CHAIN.chainId }] });
  }
}

async function signInWithOkx() {
  const button = $("wallet-signin-button");
  button.disabled = true;
  setText("auth-status", "OKX Wallet 연결을 기다리고 있습니다…");
  try {
    const provider = await discoverOkxProvider();
    if (!provider?.request) throw new Error("OKX Wallet 확장 프로그램 또는 앱 내 브라우저를 찾지 못했습니다");
    state.walletProvider = provider;
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const address = accounts?.[0];
    if (!address) throw new Error("연결된 지갑 주소가 없습니다");
    await ensureBscNetwork(provider);
    setText("auth-status", "거래 없는 로그인 메시지 서명을 요청합니다…");
    const challenge = await fetchJson(`${CONTROL_ROOT}/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const signature = await provider.request({
      method: "personal_sign",
      params: [challenge.message, address],
    });
    await fetchJson(`${CONTROL_ROOT}/auth/wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_id: challenge.challenge_id, address, signature }),
    });
    $("auth-gate").hidden = true;
    $("logout-button").hidden = false;
    await loadSession();
    await loadSnapshot();
    startPolling();
  } catch (error) {
    const rejected = Number(error?.code) === 4001;
    setText("auth-status", rejected ? "지갑 연결 또는 서명이 취소됐습니다." : `지갑 로그인 실패: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  await fetchJson(`${CONTROL_ROOT}/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  location.reload();
}

async function loadSession() {
  if (PUBLIC_SNAPSHOT_URL) return;
  const session = await fetchJson(`${API_ROOT}/session`);
  state.csrfToken = session.csrf_token || "";
}

async function loadSnapshot({ announce = false, refreshWallet = false } = {}) {
  if (state.busy) return;
  const button = $("refresh-button");
  button.disabled = true;
  try {
    const path = PUBLIC_SNAPSHOT_URL
      ? `${PUBLIC_SNAPSHOT_URL}?t=${Date.now()}`
      : refreshWallet ? `${API_ROOT}/snapshot?refresh_wallet=1` : `${API_ROOT}/snapshot`;
    state.snapshot = await fetchJson(path);
    state.loading = false;
    render();
    if (announce) showToast("최신 운영 상태를 불러왔습니다.");
  } catch (error) {
    showToast(`상태를 불러오지 못했습니다. ${error.message}`, true);
    setText("footer-status", "서버 상태 확인 실패");
  } finally {
    button.disabled = false;
  }
}

function randomRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("") || `request-${Date.now()}`;
}

async function executeCommand(command) {
  if (EXTERNAL_READ_ONLY) {
    showToast("외부 공개 화면은 읽기 전용입니다. 운영 제어는 서버 로컬 콘솔에서만 가능합니다.", true);
    return;
  }
  if (EXTERNAL_CONTROL && !EXTERNAL_CONTROL_COMMANDS.has(command)) {
    showToast("이 명령은 외부 저위험 제어 카나리에서 아직 열리지 않았습니다.", true);
    return;
  }
  if (!state.snapshot || state.busy) return;
  state.busy = true;
  updateControls();
  try {
    const expectedRevision = state.snapshot.operation?.revision;
    await fetchJson(`${API_ROOT}/${command}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": state.csrfToken,
        "X-Idempotency-Key": randomRequestId(),
      },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    });
    await loadSnapshot();
    showToast(`${commandLabel(command)} 명령이 적용됐습니다.`);
  } catch (error) {
    if (error.status === 409) await loadSnapshot();
    showToast(`${commandLabel(command)} 실패: ${error.message}`, true);
  } finally {
    state.busy = false;
    updateControls();
  }
}

function commandLabel(command) {
  return {
    connect: "실행지갑 연결",
    disconnect: "지갑 연결 해제",
    arm: "운영 준비",
    activate: "라이브 시작",
    "pause-entries": "신규 진입 정지",
    "exit-only": "Exit-only 전환",
    lock: "운영 잠금",
    "emergency-close": "긴급 전량 철수",
    "acknowledge-alert": "경보 확인",
  }[command] || command;
}

function askConfirmation(command) {
  const confirmation = CONFIRMATIONS[command];
  if (!confirmation) return executeCommand(command);
  state.pendingCommand = command;
  setText("confirm-title", confirmation.title);
  setText("confirm-description", confirmation.description);
  const phraseWrap = $("confirm-phrase-wrap");
  const phraseInput = $("confirm-phrase");
  const submit = $("confirm-submit");
  phraseInput.value = "";
  phraseWrap.hidden = !confirmation.phrase;
  setText("confirm-phrase-label", confirmation.phrase ? `“${confirmation.phrase}”` : "");
  submit.className = `button ${confirmation.tone === "danger" ? "danger" : "primary"}`;
  submit.disabled = Boolean(confirmation.phrase);
  $("confirm-dialog").showModal();
  if (confirmation.phrase) phraseInput.focus();
  else submit.focus();
}

function updateControls() {
  if (!state.snapshot) return;
  const operation = state.snapshot.operation || {};
  const mode = operation.mode || "DISCONNECTED";
  const connected = Boolean(operation.wallet_connected);
  const attention = (operation.hard_attention_reasons || []).length > 0 || mode === "ATTENTION";
  const allowed = {
    connect: !connected,
    disconnect: connected && !state.snapshot.executor?.pending && !hasPosition(),
    arm: connected && !attention && mode !== "LIVE",
    activate: connected && mode === "ARMED" && !attention && operation.hard_live_ready,
    "pause-entries": connected && mode !== "LOCKED",
    "exit-only": connected && mode !== "EXIT_ONLY",
    lock: connected && mode !== "LOCKED",
    "emergency-close": connected && hasPosition(),
    "acknowledge-alert": connected && attention,
  };
  qsa("[data-command]").forEach((button) => {
    const command = button.dataset.command;
    const permittedByChannel = !EXTERNAL_CONTROL || EXTERNAL_CONTROL_COMMANDS.has(command);
    button.disabled = EXTERNAL_READ_ONLY || state.busy || !allowed[command] || !permittedByChannel;
    if (EXTERNAL_READ_ONLY) button.title = "외부 공개 화면에서는 운영 제어가 차단됩니다.";
    else if (!permittedByChannel) button.title = "고위험 제어는 외부 카나리 검증 후 개방됩니다.";
    button.setAttribute("aria-disabled", String(button.disabled));
  });
}

function hasPosition() {
  const positions = state.snapshot?.positions || {};
  if (positions.active) return true;
  return list(positions.managed_registry).some((item) => item.active !== false && item.status !== "closed");
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  $("loading-state").hidden = true;
  selectView(state.activeView);
  renderHeader(snapshot);
  renderOverview(snapshot);
  renderPosition(snapshot);
  renderOpportunities(snapshot);
  renderWallet(snapshot);
  renderActivity(snapshot);
  updateControls();
}

function renderHeader(snapshot) {
  const operation = snapshot.operation || {};
  const mode = operation.mode || "UNKNOWN";
  const badge = $("mode-badge");
  badge.dataset.mode = mode;
  badge.querySelector("strong").textContent = mode;
  const phase = snapshot.executor?.phase || "unknown";
  setText("sidebar-executor", humanize(phase));
  setText("sidebar-updated", formatDate(snapshot.generated_at));
  setText("footer-status", `${mode} · ${humanize(phase)} · ${formatDate(snapshot.generated_at)}`);
  $("sidebar-pulse").className = `pulse ${mode === "ATTENTION" ? "is-warn" : "is-ok"}`;
}

function activePosition(snapshot) {
  const active = snapshot.positions?.active;
  return active && typeof active === "object" ? active : null;
}

function shadowPositions(snapshot) {
  return list(snapshot.positions?.shadow || snapshot.positions?.dashboard);
}

function positionMetrics(position) {
  const principal = firstValue(position, ["entry_nav_usd", "entry_value_usd", "principal_usd", "amount_usd", "initial_value_usd", "deployed_usd"]);
  const fees = firstValue(position, ["estimated_accrued_fees_usd", "fees_usd", "accrued_fees_usd", "fee_value_usd", "metrics.fees_usd", "gross_edge_usd"]);
  const elapsedHours = firstValue(position, ["fee_estimate_elapsed_hours"]);
  const entryAprBps = firstValue(position, ["intent.edge_apr_bps"]);
  const entryApr = firstValue(position, ["entry_edge_apr_pct"], asNumber(entryAprBps) === null ? null : Number(entryAprBps) / 100);
  const expectedFeesFallback = [principal, entryApr, elapsedHours].every((value) => asNumber(value) !== null)
    ? Number(principal) * (Number(entryApr) / 100) * (Number(elapsedHours) / (365.25 * 24))
    : null;
  const expectedFees = firstValue(position, ["expected_accrued_fees_usd"], expectedFeesFallback);
  const attainmentFallback = asNumber(fees) !== null && asNumber(expectedFees) !== null && Number(expectedFees) > 0
    ? Number(fees) / Number(expectedFees) * 100
    : null;
  return {
    pool: firstValue(position, ["pair", "pool_name", "symbol", "name", "candidate.pair"], "Metric LP"),
    value: firstValue(position, ["current_value_usd", "value_usd", "position_value_usd", "marked_value_usd", "mark_value_usd", "last_nav_usd", "notional_usd"]),
    principal,
    feeEvidence: firstValue(position, ["fee_evidence"]),
    fees,
    pnl: firstValue(position, ["valuation_pnl_usd", "net_pnl_usd", "pnl_usd", "unrealized_pnl_usd", "metrics.net_pnl_usd", "modeled_net_relative_pnl_usd"]),
    valuationReturnPct: firstValue(position, ["valuation_return_pct"]),
    feeHourly: firstValue(position, ["estimated_fee_hourly_usd"]),
    feeDaily: firstValue(position, ["estimated_fee_daily_usd"]),
    feeApr: firstValue(position, ["estimated_fee_apr_pct"]),
    entryApr,
    expectedFees,
    feeAttainment: firstValue(position, ["fee_apr_attainment_pct"], attainmentFallback),
    feeEstimateMethod: firstValue(position, ["fee_estimate_method"]),
    feeEstimateAsOf: firstValue(position, ["fee_estimate_as_of"]),
    feeEstimatePeriodDays: firstValue(position, ["fee_estimate_period_days"]),
    feeEstimateElapsedHours: firstValue(position, ["fee_estimate_elapsed_hours"]),
    priceInventoryEffect: firstValue(position, ["estimated_price_inventory_effect_usd"]),
    roundTripCost: firstValue(position, ["estimated_round_trip_cost_usd"]),
    exitNetPnl: firstValue(position, ["estimated_exit_net_pnl_usd"]),
    apy: firstValue(position, ["net_apy", "net_apy_pct", "expected_net_apy", "metrics.net_apy_pct"]),
    entered: firstValue(position, ["opened_at", "entered_at", "created_at", "entry_time"]),
    token0: firstValue(position, ["token0_amount", "amount0", "inventory.token0"]),
    token1: firstValue(position, ["token1_amount", "amount1", "inventory.token1"]),
    exitCost: firstValue(position, ["estimated_round_trip_cost_usd", "estimated_exit_cost_usd", "exit_cost_usd", "metrics.exit_cost_usd"]),
    recoveryDays: firstValue(position, ["recovery_days", "loss_recovery_days", "metrics.recovery_days"]),
  };
}

function feeEvidenceCopy(metrics) {
  if (metrics.feeEvidence === "estimated") {
    return "최근 7일 풀 수수료 × 현재 지분율 × 보유시간으로 추정한 값입니다. 확정 귀속 수수료가 아닙니다.";
  }
  return "수수료 추정에 필요한 보유 bin 데이터가 충분하지 않습니다.";
}

function moneyAndPercent(value, percent) {
  const moneyText = formatMoney(value);
  const percentText = formatPercent(percent);
  return percentText === "—" ? moneyText : `${moneyText} · ${percentText}`;
}

function feeMethodLabel(metrics) {
  if (metrics.feeEstimateMethod === "trailing_7d_pool_fee_prorated_by_current_share_and_elapsed") {
    return `최근 ${formatNumber(metrics.feeEstimatePeriodDays, "일")} 풀 수수료 × 현재 지분율 × ${formatNumber(metrics.feeEstimateElapsedHours, "시간")}`;
  }
  return metrics.feeEstimateMethod ? humanize(metrics.feeEstimateMethod) : "—";
}

function renderOverview(snapshot) {
  const wallet = snapshot.wallet || {};
  const position = activePosition(snapshot);
  const metrics = position ? positionMetrics(position) : {};
  const usdt = asNumber(wallet.balances?.USDT) || 0;
  const bnb = asNumber(wallet.balances?.BNB);
  const wbnb = asNumber(wallet.balances?.WBNB);
  const lpValue = asNumber(metrics.value) || 0;
  const liquidTotal = asNumber(wallet.valuation?.liquid_total_usd) ?? usdt;
  const total = liquidTotal + lpValue;
  setText("overview-generated", `마지막 갱신 ${formatDate(snapshot.generated_at)}`);
  setText("metric-total", formatMoney(total));
  setText("metric-total-note", `유동자산 ${formatMoney(liquidTotal)} + 실제 LP ${formatMoney(lpValue)}`);
  setText("metric-usdt", formatMoney(usdt));
  setText("metric-bnb", bnb === null ? "—" : `${number.format(bnb)} BNB`);
  setText("metric-wbnb", wbnb === null ? "—" : `${number.format(wbnb)} WBNB`);
  setText("metric-lp", position ? formatMoney(lpValue) : "$0.00");
  setText("metric-pool", position ? String(metrics.pool) : "활성 포지션 없음");
  setText("metric-fees", formatMoneyPrecise(metrics.fees));
  setText("metric-pnl", formatMoney(metrics.pnl));
  setText("metric-apy", `진입 NAV 대비 ${formatPercent(metrics.valuationReturnPct)}`);
  const pnlElement = $("metric-pnl");
  const pnl = asNumber(metrics.pnl);
  pnlElement.className = pnl === null ? "" : pnl >= 0 ? "positive" : "negative";

  const executor = snapshot.executor || {};
  const decision = executor.last_decision;
  const decisionName = typeof decision === "object" ? firstValue(decision, ["decision", "action", "status"], "WAIT") : decision || "WAIT";
  const decisionReason = typeof decision === "object" ? firstValue(decision, ["reason", "detail", "message"], "최신 경제성 평가 결과입니다.") : "후보와 현재 포지션을 비교한 최신 판단입니다.";
  setText("decision-pill", String(decisionName).toUpperCase());
  setText("decision-title", humanize(decisionName));
  setText("decision-reason", decisionReason);
  setText("executor-phase", humanize(executor.phase));
  setText("executor-pending", executor.pending ? "있음" : "없음");

  const operation = snapshot.operation || {};
  const attention = operation.hard_attention_reasons || [];
  $("attention-banner").hidden = !attention.length;
  setText("attention-copy", attention.map(humanize).join(" · "));
  setText("wallet-connection-chip", operation.wallet_connected ? "CONNECTED" : "DISCONNECTED");
  setText("control-explainer", controlExplanation(operation));

  const opportunitySummary = snapshot.opportunities?.summary || {};
  const candidates = list(snapshot.opportunities?.candidate_pools).filter((item) => Number(item.chain_id) === 56);
  setText("scan-total", formatNumber(opportunitySummary.scanned_pools));
  setText("scan-detailed", formatNumber(opportunitySummary.detailed_pools));
  setText("scan-watch", formatNumber(candidates.filter((item) => item.candidate_status === "watch").length));
  setText("scan-eligible", formatNumber(candidates.filter((item) => item.eligible).length));

  renderPositionSummary(position, metrics);
  renderTopOpportunity(snapshot.opportunities || {});
}

function controlExplanation(operation) {
  const copy = {
    DISCONNECTED: "암호화 실행지갑이 운영 콘솔에 연결되지 않았습니다. 연결해도 거래는 시작되지 않습니다.",
    LOCKED: "지갑은 연결됐지만 신규 진입과 거래 방송은 잠겨 있습니다.",
    ARMED: "사전검증을 완료했지만 아직 거래하지 않습니다. 라이브 시작 시 서버가 다시 검증합니다.",
    LIVE: "경제성 기준을 충족한 진입·보유·철수·교체가 자동 실행될 수 있습니다.",
    EXIT_ONLY: "신규 진입은 차단되고 기존 관리 포지션의 안전 철수만 허용됩니다.",
    ATTENTION: "오류 또는 상태 불일치가 감지됐습니다. 경보를 확인하고 잠금 상태에서 복구하세요.",
  };
  return copy[operation.mode] || "운영 상태를 확인 중입니다.";
}

function renderPositionSummary(position, metrics) {
  const container = $("position-summary");
  if (!position) {
    container.className = "empty-state";
    container.replaceChildren(...emptyStateNodes("활성 포지션 없음", "운영이 시작되면 투입 원금, 평가액, 수수료와 교체 판단을 표시합니다."));
    return;
  }
  container.className = "position-hero opportunity-hero";
  container.replaceChildren(
    labeledMetric("position-name", "현재 운용 풀", metrics.pool),
    labeledMetric("position-stat", "진입 APR", formatPercent(metrics.entryApr)),
    labeledMetric("position-stat", "APR 예상 누적", formatMoneyPrecise(metrics.expectedFees)),
    labeledMetric("position-stat", "추정 누적 수수료", formatMoneyPrecise(metrics.fees)),
    labeledMetric("position-stat", "APR 달성률", formatPercent(metrics.feeAttainment)),
    createNode("p", { className: "allocation-note", text: "수수료는 최근 7일 bin 흐름 기반 추정치입니다. 가격·재고 손익과 철수비용은 포지션 상세에서 확인합니다." }),
  );
}

function normalizedOpportunities(opportunities) {
  return list(opportunities.candidate_pools).filter((item) => Number(item.chain_id) === 56);
}

function opportunityMetrics(item) {
  const edgeApr = firstValue(item, ["tight_edge_apr_pct_7d"]);
  const pnlApr = firstValue(item, ["tight_pnl_apr_pct_7d"]);
  const status = item.eligible ? "eligible" : firstValue(item, ["candidate_status"], "blocked");
  return {
    pair: firstValue(item, ["pair", "symbol", "pool_name", "name", "token_pair"], "Unknown pool"),
    chain: firstValue(item, ["chain"], "BSC"),
    tvl: firstValue(item, ["tvl_usd", "tvl", "liquidity_usd"]),
    volume: firstValue(item, ["volume_24h_usd"]),
    velocity: firstValue(item, ["volume_tvl_24h"]),
    edgeApr,
    pnlApr,
    dailyEdge100: asNumber(edgeApr) === null ? null : 100 * Number(edgeApr) / 100 / 365,
    validBins: firstValue(item, ["valid_bins"]),
    positiveBins: firstValue(item, ["positive_pnl_bins"]),
    reasons: list(item.gate_reason_labels || item.gate_reasons),
    status,
    provider: firstValue(item, ["provider_type"], "—"),
    observedAt: firstValue(item, ["observed_at"]),
  };
}

function renderTopOpportunity(opportunities) {
  const items = normalizedOpportunities(opportunities);
  const container = $("top-opportunity");
  if (!items.length) {
    container.className = "empty-state";
    container.replaceChildren(...emptyStateNodes("적격 후보 없음", "순수익과 비용 회수 조건을 통과한 풀이 여기에 표시됩니다."));
    return;
  }
  const ranked = [...items].sort((a, b) => {
    const left = opportunityMetrics(a);
    const right = opportunityMetrics(b);
    return Number(right.status === "eligible") - Number(left.status === "eligible") || (asNumber(right.edgeApr) || -Infinity) - (asNumber(left.edgeApr) || -Infinity);
  });
  const candidate = opportunityMetrics(ranked[0]);
  container.className = "position-hero";
  container.replaceChildren(
    labeledMetric("position-name", "최상위 후보", candidate.pair),
    labeledMetric("position-stat", "Edge APR", formatPercent(candidate.edgeApr)),
    labeledMetric("position-stat", "PnL APR", formatPercent(candidate.pnlApr)),
    labeledMetric("position-stat", "$100 일 Edge", formatMoney(candidate.dailyEdge100)),
    labeledMetric("position-stat", "판정", candidateStatusLabel(candidate.status)),
  );
}

function renderPosition(snapshot) {
  const position = activePosition(snapshot);
  const container = $("position-detail");
  if (!position) {
    container.className = "panel empty-state";
    container.replaceChildren(...emptyStateNodes("활성 포지션 없음", "Executor가 관리하는 포지션이 열리면 상세 손익과 철수 경제성을 표시합니다."));
  } else {
    const metrics = positionMetrics(position);
    container.className = "panel";
    const heading = createNode("div", { className: "panel-heading" }, [
      createNode("div", {}, [createNode("p", { className: "eyebrow", text: "Managed liquidity" }), createNode("h3", { text: metrics.pool })]),
      createNode("span", { className: "decision-pill", text: humanize(snapshot.executor?.last_decision?.decision || snapshot.executor?.last_decision || "HOLD") }),
    ]);
    const hero = createNode("div", { className: "position-hero" }, [
      labeledMetric("position-name", "현재 평가액", formatMoney(metrics.value), `진입 ${formatDate(metrics.entered)}`),
      labeledMetric("position-stat", "진입 NAV", formatMoney(metrics.principal)),
      labeledMetric("position-stat", "진입 APR", formatPercent(metrics.entryApr)),
      labeledMetric("position-stat", "APR 예상 누적", formatMoneyPrecise(metrics.expectedFees)),
      labeledMetric("position-stat", "APR 달성률", formatPercent(metrics.feeAttainment)),
      labeledMetric("position-stat", "평가손익", moneyAndPercent(metrics.pnl, metrics.valuationReturnPct)),
    ]);
    hero.style.marginTop = "20px";
    const details = createNode("div", { className: "data-list" }, [
      dataRow("Token 0 수량", formatNumber(metrics.token0)),
      dataRow("Token 1 수량", formatNumber(metrics.token1)),
      dataRow("수수료 추정 기준시각", formatDate(metrics.feeEstimateAsOf)),
      dataRow("추정 누적 LP 수수료", formatMoneyPrecise(metrics.fees)),
      dataRow("시간당 추정 수수료", formatMoneyPrecise(metrics.feeHourly)),
      dataRow("24시간 환산 수수료", formatMoneyPrecise(metrics.feeDaily)),
      dataRow("수수료 환산 APR", formatPercent(metrics.feeApr)),
      dataRow("가격·재고 효과", formatMoney(metrics.priceInventoryEffect)),
      dataRow("예상 왕복비용", formatMoney(metrics.roundTripCost)),
      dataRow("철수 후 예상 순손익", formatMoney(metrics.exitNetPnl)),
      dataRow("수수료 추정 방식", feeMethodLabel(metrics)),
    ]);
    const note = createNode("p", { className: "allocation-note", text: feeEvidenceCopy(metrics) });
    container.replaceChildren(heading, hero, details, note);
  }
  renderObjectList("registry-detail", snapshot.positions?.managed_registry, "등록된 관리 포지션이 없습니다.");
  renderShadowPositions(shadowPositions(snapshot));
}

function renderShadowPositions(items) {
  const container = $("shadow-positions");
  if (!items.length) {
    container.replaceChildren(createNode("div", { className: "empty-state" }, emptyStateNodes("가상 포지션 없음", "Shadow 전략이 진입 조건을 충족하면 실제 자금과 분리해 표시합니다.")));
    return;
  }
  container.replaceChildren(...items.slice(0, 8).map((item) => {
    const metrics = positionMetrics(item);
    return createNode("article", { className: "shadow-card" }, [
      createNode("div", { className: "shadow-card-head" }, [
        createNode("strong", { text: metrics.pool }),
        createNode("span", { className: "shadow-badge", text: "SHADOW" }),
      ]),
      createNode("dl", {}, [
        createNode("div", {}, [createNode("dt", { text: "가상 투입" }), createNode("dd", { text: formatMoney(metrics.principal) })]),
        createNode("div", {}, [createNode("dt", { text: "가상 평가" }), createNode("dd", { text: formatMoney(metrics.value) })]),
        createNode("div", {}, [createNode("dt", { text: "Hold 대비" }), createNode("dd", { text: formatMoney(metrics.pnl) })]),
      ]),
    ]);
  }));
}

function renderObjectList(id, source, emptyCopy) {
  const container = $(id);
  const items = list(source);
  if (!items.length) {
    container.replaceChildren(createNode("div", { className: "empty-state" }, emptyStateNodes("기록 없음", emptyCopy)));
    return;
  }
  container.replaceChildren(...items.slice(0, 8).map((item, index) => {
    const label = firstValue(item, ["pair", "pool_name", "symbol", "key", "status"], `항목 ${index + 1}`);
    const detail = firstValue(item, ["pool_address", "address", "phase", "shares", "value"], "관리 중");
    return dataRow(label, shortAddress(detail), detail);
  }));
}

function renderOpportunities(snapshot) {
  const opportunities = snapshot.opportunities || {};
  const allItems = normalizedOpportunities(opportunities);
  const search = state.candidateSearch.trim().toLowerCase();
  const items = allItems.filter((item) => {
    const candidate = opportunityMetrics(item);
    return (state.candidateStatus === "all" || candidate.status === state.candidateStatus)
      && (!search || candidate.pair.toLowerCase().includes(search));
  });
  const summary = opportunities.summary || {};
  const cards = [
    ["전체 스캔", formatNumber(summary.scanned_pools)],
    ["정밀 평가", formatNumber(summary.detailed_pools)],
    ["진입 적격", allItems.filter((item) => item.eligible).length],
    ["최근 탐색", formatDate(opportunities.run?.finished_at || snapshot.generated_at)],
  ];
  $("opportunity-summary").replaceChildren(...cards.map(([label, value]) => labeledMetric("summary-card", label, value)));
  setText("candidate-count", `${items.length}개`);
  $("candidate-status").value = state.candidateStatus;
  $("candidate-search").value = state.candidateSearch;
  $("opportunity-empty").hidden = items.length > 0;
  $("opportunity-rows").replaceChildren(...items.map((item) => {
    const candidate = opportunityMetrics(item);
    const reasons = candidate.reasons.length ? candidate.reasons.join(" · ") : "모든 게이트 통과";
    return createNode("tr", {}, [
      createNode("td", {}, [createNode("strong", { text: candidate.pair }), createNode("span", { text: `${candidate.chain} · ${candidate.provider}` })]),
      createNode("td", {}, [createNode("span", { className: `candidate-status status-${candidate.status}`, text: candidateStatusLabel(candidate.status) })]),
      createNode("td", { text: formatPercent(candidate.edgeApr) }),
      createNode("td", { text: formatPercent(candidate.pnlApr) }),
      createNode("td", { text: formatMoney(candidate.dailyEdge100) }),
      createNode("td", { text: formatCompactMoney(candidate.tvl) }),
      createNode("td", { text: formatCompactMoney(candidate.volume) }),
      createNode("td", { text: formatNumber(candidate.velocity, "×") }),
      createNode("td", { text: `${formatNumber(candidate.validBins)} / 양수 ${formatNumber(candidate.positiveBins)}` }),
      createNode("td", { className: "reason-cell", text: reasons, title: reasons }),
    ]);
  }));
  const blockers = list(opportunities.blockers);
  $("blocker-list").replaceChildren(...(blockers.length
    ? blockers.slice(0, 20).map((item) => createNode("span", { className: "blocker-tag", text: typeof item === "string" ? humanize(item) : firstValue(item, ["label", "reason", "name", "key"], JSON.stringify(item)) }))
    : [createNode("div", { className: "empty-state" }, emptyStateNodes("활성 차단 요인 없음", "현재 스냅샷에 보고된 후보 차단 요인이 없습니다."))]));
}

function candidateStatusLabel(status) {
  return { eligible: "진입 적격", watch: "감시", blocked: "탈락" }[status] || humanize(status);
}

function renderWallet(snapshot) {
  const wallet = snapshot.wallet || {};
  const operation = snapshot.operation || {};
  setText("wallet-status-chip", operation.wallet_connected ? "CONNECTED" : "DISCONNECTED");
  setText("wallet-address", wallet.address || "설정된 지갑 주소 없음");
  setText("wallet-usdt", formatMoney(wallet.balances?.USDT));
  setText("wallet-bnb", wallet.balances?.BNB == null ? "—" : `${number.format(wallet.balances.BNB)} BNB`);
  setText("wallet-wbnb", wallet.balances?.WBNB == null ? "—" : `${number.format(wallet.balances.WBNB)} WBNB`);
  setText("wallet-total", formatMoney(wallet.valuation?.liquid_total_usd));
  const explorer = $("wallet-explorer");
  if (wallet.address) {
    explorer.href = `https://bscscan.com/address/${encodeURIComponent(wallet.address)}`;
    explorer.hidden = false;
  } else explorer.hidden = true;
}

function renderActivity(snapshot) {
  renderTimeline("activity-list", list(snapshot.activity), false);
  renderTimeline("alert-list", list(snapshot.alerts), true);
}

function renderTimeline(id, items, isAlert) {
  const container = $(id);
  if (!items.length) {
    container.replaceChildren(createNode("li", {}, [
      createNode("time", { text: "—" }),
      createNode("div", {}, emptyStateNodes(isAlert ? "활성 경보 없음" : "운영 기록 없음", isAlert ? "안전 경보가 발생하면 여기에 표시됩니다." : "운영 명령과 결과가 여기에 기록됩니다.")),
    ]));
    return;
  }
  container.replaceChildren(...[...items].reverse().slice(0, isAlert ? 25 : 50).map((item) => {
    const at = firstValue(item, ["at", "timestamp", "created_at", "time"]);
    const title = firstValue(item, ["command", "type", "level", "reason"], isAlert ? "안전 경보" : "운영 기록");
    const detail = firstValue(item, ["detail", "message", "outcome", "description"], JSON.stringify(item));
    return createNode("li", {}, [
      createNode("time", { text: formatDate(at), dateTime: at || "" }),
      createNode("div", {}, [createNode("strong", { text: humanize(title) }), createNode("p", { text: detail })]),
    ]);
  }));
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (!document.hidden) loadSnapshot();
  }, 5000);
}

function updateCandidateFilters() {
  state.candidateStatus = $("candidate-status").value;
  state.candidateSearch = $("candidate-search").value;
  const url = new URL(window.location.href);
  if (state.candidateStatus === "all") url.searchParams.delete("candidateStatus");
  else url.searchParams.set("candidateStatus", state.candidateStatus);
  if (state.candidateSearch.trim()) url.searchParams.set("candidateSearch", state.candidateSearch.trim());
  else url.searchParams.delete("candidateSearch");
  history.replaceState({ view: state.activeView }, "", url);
  if (state.snapshot) renderOpportunities(state.snapshot);
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const viewLink = event.target.closest("[data-view-link]");
    if (viewLink) {
      event.preventDefault();
      selectView(viewLink.dataset.viewLink, true);
      $("main-content").focus({ preventScroll: true });
      return;
    }
    const commandButton = event.target.closest("[data-command]");
    if (commandButton && !commandButton.disabled) askConfirmation(commandButton.dataset.command);
  });
  $("refresh-button").addEventListener("click", () => loadSnapshot({ announce: true, refreshWallet: true }));
  $("mobile-menu").addEventListener("click", () => {
    const open = !document.body.classList.contains("menu-open");
    document.body.classList.toggle("menu-open", open);
    $("mobile-menu").setAttribute("aria-expanded", String(open));
    $("mobile-menu").setAttribute("aria-label", open ? "탐색 메뉴 닫기" : "탐색 메뉴 열기");
  });
  window.addEventListener("popstate", () => selectView(currentView()));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadSnapshot(); });
  $("confirm-phrase").addEventListener("input", (event) => {
    const expected = CONFIRMATIONS[state.pendingCommand]?.phrase || "";
    $("confirm-submit").disabled = event.target.value !== expected;
  });
  $("confirm-dialog").addEventListener("close", () => {
    if ($("confirm-dialog").returnValue === "confirm" && state.pendingCommand) executeCommand(state.pendingCommand);
    state.pendingCommand = null;
  });
  $("logout-button").addEventListener("click", logout);
  $("wallet-signin-button").addEventListener("click", signInWithOkx);
  $("candidate-status").addEventListener("change", updateCandidateFilters);
  $("candidate-search").addEventListener("input", updateCandidateFilters);
}

async function init() {
  if (EXTERNAL_READ_ONLY) {
    document.title = `읽기 전용 · ${document.title}`;
    const externalRoot = "/metric-console/";
    const brand = document.querySelector(".brand");
    if (brand) brand.href = externalRoot;
    qsa("[data-view-link]").forEach((link) => {
      link.href = `${externalRoot}?view=${encodeURIComponent(link.dataset.viewLink)}`;
    });
    qsa(".topbar-title p").forEach((element) => {
      element.textContent = "외부 읽기 전용 운영 현황";
    });
  } else if (EXTERNAL_CONTROL) {
    document.title = `인증 제어 · ${document.title}`;
    const controlRoot = `${CONTROL_ROOT}/`;
    const brand = document.querySelector(".brand");
    if (brand) brand.href = controlRoot;
    qsa("[data-view-link]").forEach((link) => {
      link.href = `${controlRoot}?view=${encodeURIComponent(link.dataset.viewLink)}`;
    });
    qsa(".topbar-title p").forEach((element) => {
      element.textContent = "인증된 저위험 운영 제어 카나리";
    });
  }
  state.activeView = currentView();
  selectView(state.activeView);
  bindEvents();
  try {
    if (!(await ensureExternalAuthentication())) return;
    await loadSession();
    await loadSnapshot();
    startPolling();
  } catch (error) {
    $("loading-state").replaceChildren(createNode("div", { className: "empty-state" }, emptyStateNodes("운영 콘솔에 연결할 수 없습니다", `${error.message}. 서버와 인증 상태를 확인한 뒤 새로고침하세요.`)));
    showToast(`초기화 실패: ${error.message}`, true);
  }
}

init();
