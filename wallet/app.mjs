import {
  CHAINS,
  connectOkx,
  discoverOkxProvider,
  formatNativeBalance,
  normalizeAddress,
  switchChain,
} from "./wallet.mjs";

const $ = (selector) => document.querySelector(selector);
const state = { provider: null, config: null, address: null, chainId: null, balanceWei: 0n };

function shortAddress(value) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "미연결";
}

function setStatus(kind, text) {
  const node = $("#status");
  node.dataset.kind = kind;
  node.textContent = text;
}

function render() {
  const connected = Boolean(state.address);
  $("#wallet-address").textContent = shortAddress(state.address);
  $("#wallet-address").title = state.address || "";
  $("#address-check").textContent = connected ? "일치" : "대기";
  $("#chain-name").textContent = state.chainId ? (CHAINS[state.chainId]?.chainName || `Chain ${state.chainId}`) : "대기";
  $("#native-balance").textContent = connected ? formatNativeBalance(state.balanceWei, state.chainId) : "대기";
  $("#connect").disabled = connected;
  $("#disconnect").disabled = !connected;
  for (const button of document.querySelectorAll("[data-chain]")) button.disabled = !connected;
}

async function refreshAccount() {
  if (!state.provider || !state.config) return;
  const accounts = await state.provider.request({ method: "eth_accounts" });
  const address = accounts?.[0];
  if (!address || normalizeAddress(address) !== normalizeAddress(state.config.expected_wallet_address)) {
    state.address = null;
    state.chainId = null;
    state.balanceWei = 0n;
    setStatus("error", "등록 지갑과 다른 주소이거나 연결이 해제됐습니다.");
    render();
    return;
  }
  const chainHex = await state.provider.request({ method: "eth_chainId" });
  state.address = address;
  state.chainId = Number.parseInt(chainHex, 16);
  const balanceHex = await state.provider.request({ method: "eth_getBalance", params: [address, "latest"] });
  state.balanceWei = BigInt(balanceHex);
  setStatus("ok", "OKX Wallet이 읽기 전용으로 연결됐습니다. 거래 전송은 잠겨 있습니다.");
  render();
}

async function connect() {
  try {
    setStatus("working", "OKX Wallet을 찾고 있습니다…");
    state.provider = await discoverOkxProvider(window);
    const result = await connectOkx(state.provider, state.config.expected_wallet_address);
    Object.assign(state, result);
    state.provider.on?.("accountsChanged", refreshAccount);
    state.provider.on?.("chainChanged", refreshAccount);
    setStatus("ok", "주소 확인 완료. 거래 전송 기능은 아직 비활성입니다.");
    render();
  } catch (error) {
    const messages = {
      okx_wallet_not_found: "OKX Wallet 확장 프로그램을 찾지 못했습니다.",
      wallet_address_mismatch: "연결된 주소가 등록된 실행 지갑과 다릅니다.",
    };
    setStatus("error", messages[error.message] || `연결 실패: ${error.message || error}`);
  }
}

async function selectChain(event) {
  try {
    const chainId = Number(event.currentTarget.dataset.chain);
    setStatus("working", `${CHAINS[chainId].chainName}으로 전환을 요청합니다…`);
    await switchChain(state.provider, chainId);
    await refreshAccount();
  } catch (error) {
    setStatus("error", `체인 전환 실패: ${error.message || error}`);
  }
}

function disconnect() {
  state.address = null;
  state.chainId = null;
  state.balanceWei = 0n;
  setStatus("idle", "페이지 연결 상태만 초기화했습니다. OKX Wallet 권한은 지갑 앱에서 관리하세요.");
  render();
}

async function boot() {
  let response = await fetch("./wallet-config.json", { cache: "no-store" });
  if (!response.ok) response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error("config_load_failed");
  state.config = await response.json();
  $("#expected-address").textContent = shortAddress(state.config.expected_wallet_address);
  $("#expected-address").title = state.config.expected_wallet_address;
  $("#execution-mode").textContent = state.config.execution.broadcast_enabled ? "활성" : "잠금";
  $("#connect").addEventListener("click", connect);
  $("#disconnect").addEventListener("click", disconnect);
  for (const button of document.querySelectorAll("[data-chain]")) button.addEventListener("click", selectChain);
  render();
}

boot().catch((error) => setStatus("error", `초기화 실패: ${error.message || error}`));
