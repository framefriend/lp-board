import {
  CHAINS, connectOkx, discoverOkxProvider, fetchBridgeQuote, formatNativeBalance,
  formatUnits, normalizeAddress, preflightBridge, rpcNativeBalance, sendBridgeTransaction,
  switchChain, waitForDestinationIncrease, waitForReceipt,
} from "./wallet.mjs";

const $ = (selector) => document.querySelector(selector);
const state = {
  provider: null, config: null, address: null, chainId: null, balanceWei: 0n,
  quote: null, confirmed: false, busy: false, countdown: null,
};

function shortAddress(value) { return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "미연결"; }
function storageKey() { return state.config?.bridge?.storage_key || "metric-robinhood-bsc-bridge-v1"; }
function storedRun() { try { return JSON.parse(localStorage.getItem(storageKey()) || "null"); } catch { return null; } }
function saveRun(value) { localStorage.setItem(storageKey(), JSON.stringify(value)); }

function setStatus(kind, text) {
  const node = $("#status"); node.dataset.kind = kind; node.textContent = text;
}

function setTimeline(stage, text, hash = "") {
  const node = $(`[data-stage="${stage}"]`);
  if (!node) return;
  node.dataset.state = "active";
  node.querySelector("span").textContent = text;
  const link = node.querySelector("a");
  if (hash) { link.href = `https://explorer.mainnet.chain.robinhood.com/tx/${hash}`; link.textContent = shortAddress(hash); link.hidden = false; }
}

function clearQuote(reason = "") {
  state.quote = null; state.confirmed = false;
  $("#confirm-risk").checked = false;
  if (state.countdown) clearInterval(state.countdown);
  state.countdown = null;
  $("#quote-output").textContent = "견적 필요";
  $("#quote-minimum").textContent = "견적 필요";
  $("#quote-cost").textContent = "견적 필요";
  $("#quote-expiry").textContent = reason || "견적 필요";
}

function quoteFresh() { return state.quote && Date.now() < state.quote.expiresAt; }

function render() {
  const connected = Boolean(state.address);
  const onSource = state.chainId === state.config?.bridge?.from_chain_id;
  const run = storedRun();
  $("#wallet-address").textContent = shortAddress(state.address);
  $("#wallet-address").title = state.address || "";
  $("#address-check").textContent = connected ? "일치" : "대기";
  $("#chain-name").textContent = state.chainId ? (CHAINS[state.chainId]?.chainName || `Chain ${state.chainId}`) : "대기";
  $("#native-balance").textContent = connected ? formatNativeBalance(state.balanceWei, state.chainId) : "대기";
  $("#connect").disabled = connected || state.busy;
  $("#disconnect").disabled = !connected || state.busy;
  $("#switch-source").disabled = !connected || onSource || state.busy;
  $("#refresh-quote").disabled = !connected || !onSource || state.busy || Boolean(run);
  $("#confirm-risk").disabled = !quoteFresh() || state.busy || Boolean(run);
  $("#send-bridge").disabled = !connected || !onSource || !quoteFresh() || !state.confirmed || state.busy || Boolean(run);
  $("#send-bridge").textContent = run ? "이미 제출됨 · 추적 중" : "OKX에서 브리지 1건 승인";
}

async function refreshAccount({ announce = true } = {}) {
  if (!state.provider || !state.config) return;
  const accounts = await state.provider.request({ method: "eth_accounts" });
  const address = accounts?.[0];
  if (!address || normalizeAddress(address) !== normalizeAddress(state.config.expected_wallet_address)) {
    state.address = null; state.chainId = null; state.balanceWei = 0n; clearQuote("연결 변경");
    setStatus("error", "등록 지갑과 다른 주소이거나 연결이 해제됐습니다."); render(); return;
  }
  const chainHex = await state.provider.request({ method: "eth_chainId" });
  const nextChain = Number.parseInt(chainHex, 16);
  if ((state.address && normalizeAddress(state.address) !== normalizeAddress(address)) || (state.chainId && state.chainId !== nextChain)) clearQuote("지갑 상태 변경");
  state.address = address; state.chainId = nextChain;
  state.balanceWei = BigInt(await state.provider.request({ method: "eth_getBalance", params: [address, "latest"] }));
  if (announce) setStatus("ok", "OKX Wallet 연결 확인. 견적 조회만으로는 거래되지 않습니다.");
  render();
}

async function connect() {
  try {
    setStatus("working", "OKX Wallet을 찾고 있습니다…");
    state.provider = await discoverOkxProvider(window);
    Object.assign(state, await connectOkx(state.provider, state.config.expected_wallet_address));
    state.provider.on?.("accountsChanged", () => refreshAccount());
    state.provider.on?.("chainChanged", () => refreshAccount());
    setStatus("ok", "주소 확인 완료. Robinhood Chain에서 최신 견적을 조회하세요.");
    render(); await resumeStoredRun();
  } catch (error) {
    const messages = { okx_wallet_not_found: "OKX Wallet을 찾지 못했습니다. OKX 앱의 DApp 브라우저에서 여세요.", wallet_address_mismatch: "연결된 주소가 등록 지갑과 다릅니다." };
    setStatus("error", messages[error.message] || `연결 실패: ${error.message || error}`);
  }
}

async function selectSourceChain() {
  try {
    setStatus("working", "Robinhood Chain 전환을 요청합니다…");
    await switchChain(state.provider, state.config.bridge.from_chain_id);
    await refreshAccount();
  } catch (error) { setStatus("error", `체인 전환 실패: ${error.message || error}`); }
}

async function refreshQuote() {
  try {
    state.busy = true; clearQuote(); render(); setStatus("working", "LI.FI에서 최신 브리지 견적을 검증합니다…");
    state.quote = await fetchBridgeQuote(state.config, state.address);
    const estimate = state.quote.quote.estimate;
    $("#quote-output").textContent = `${formatUnits(estimate.toAmount)} BNB`;
    $("#quote-minimum").textContent = `${formatUnits(estimate.toAmountMin)} BNB`;
    $("#quote-cost").textContent = `$${state.quote.costUsd.toFixed(4)} / 최대 $${Number(state.config.bridge.max_total_cost_usd).toFixed(2)}`;
    const updateExpiry = () => {
      const seconds = Math.max(0, Math.ceil((state.quote.expiresAt - Date.now()) / 1000));
      $("#quote-expiry").textContent = seconds ? `${seconds}초 후 만료` : "만료됨 · 다시 조회 필요";
      if (!seconds) { state.confirmed = false; $("#confirm-risk").checked = false; render(); }
    };
    updateExpiry(); state.countdown = setInterval(updateExpiry, 1000);
    setStatus("ok", "견적 검증 완료. 최소 수령액과 비용을 확인하고 체크하세요.");
  } catch (error) { clearQuote("견적 실패"); setStatus("error", `견적 거부: ${error.message || error}`); }
  finally { state.busy = false; render(); }
}

async function trackRun(run) {
  if (run.status === "submitting") {
    setStatus("error", "이전 제출 시도가 지갑 응답 전에 중단됐습니다. 중복 방지를 위해 자동 재시도하지 않습니다."); return;
  }
  if (run.status === "completed") {
    setTimeline("destination", `BSC 도착 확인 · ${formatUnits(run.destinationBalanceWei)} BNB`);
    setStatus("ok", "브리지 완료. BSC 잔액 증가를 확인했습니다."); return;
  }
  setTimeline("submitted", "Robinhood 거래 제출됨", run.txHash);
  setStatus("working", "Robinhood 거래 영수증을 확인 중입니다…");
  await waitForReceipt(state.provider, run.txHash);
  setTimeline("source", "Robinhood 거래 성공");
  setStatus("working", "BSC 도착 잔액을 확인 중입니다…");
  const destination = await waitForDestinationIncrease(state.config.bridge.destination_rpc_url, state.config.bridge.recipient_address, BigInt(run.baselineBscBalanceWei));
  const completed = { ...run, status: "completed", completedAt: Date.now(), destinationBalanceWei: destination.toString() };
  saveRun(completed); setTimeline("destination", `BSC 도착 확인 · ${formatUnits(destination)} BNB`);
  setStatus("ok", "브리지 완료. 이 화면에서는 추가 거래를 만들지 않습니다.");
}

async function resumeStoredRun() {
  const run = storedRun();
  if (!run || !state.provider || !state.address) return;
  state.busy = true; render();
  try { await trackRun(run); } catch (error) { setStatus("error", `거래 추적 중단: ${error.message || error}. 중복 전송은 하지 않습니다.`); }
  finally { state.busy = false; render(); }
}

async function submitBridge() {
  if (storedRun()) { setStatus("error", "이미 제출 기록이 있어 새 거래를 만들지 않습니다."); return; }
  try {
    state.busy = true; render(); setStatus("working", "최종 계정·체인·잔액·가스를 검사합니다…");
    const preflight = await preflightBridge(state.provider, state.config, state.quote, state.address);
    const baseline = await rpcNativeBalance(state.config.bridge.destination_rpc_url, state.config.bridge.recipient_address);
    const submitting = { status: "submitting", fingerprint: state.quote.fingerprint, baselineBscBalanceWei: baseline.toString(), startedAt: Date.now() };
    saveRun(submitting);
    setStatus("working", "OKX Wallet에서 표시된 브리지 거래 1건만 승인하세요.");
    const txHash = await sendBridgeTransaction(state.provider, state.quote, preflight.transaction);
    const pending = { ...submitting, status: "pending", txHash, sentAt: Date.now() };
    saveRun(pending); await trackRun(pending);
  } catch (error) {
    const run = storedRun();
    if (run?.status === "submitting" && (Number(error?.code) === 4001 || /reject|denied/i.test(String(error?.message)))) localStorage.removeItem(storageKey());
    setStatus("error", `브리지 미완료: ${error.message || error}`);
  } finally { state.busy = false; render(); }
}

function disconnect() {
  state.address = null; state.chainId = null; state.balanceWei = 0n; state.provider = null; clearQuote("연결 초기화");
  setStatus("idle", "페이지 연결 상태만 초기화했습니다. 전송 기록은 보존됩니다."); render();
}

async function boot() {
  let response = await fetch("./wallet-config.json", { cache: "no-store" });
  if (!response.ok) response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error("config_load_failed");
  state.config = await response.json();
  $("#expected-address").textContent = shortAddress(state.config.expected_wallet_address);
  $("#expected-address").title = state.config.expected_wallet_address;
  $("#bridge-amount").textContent = `${formatUnits(state.config.bridge.amount_wei)} ETH`;
  $("#hard-minimum").textContent = `${formatUnits(state.config.bridge.min_destination_amount_wei)} BNB`;
  $("#recipient-address").textContent = shortAddress(state.config.bridge.recipient_address);
  $("#recipient-address").title = state.config.bridge.recipient_address;
  $("#connect").addEventListener("click", connect);
  $("#disconnect").addEventListener("click", disconnect);
  $("#switch-source").addEventListener("click", selectSourceChain);
  $("#refresh-quote").addEventListener("click", refreshQuote);
  $("#confirm-risk").addEventListener("change", (event) => { state.confirmed = event.currentTarget.checked; render(); });
  $("#send-bridge").addEventListener("click", submitBridge);
  render();
}

boot().catch((error) => setStatus("error", `초기화 실패: ${error.message || error}`));
