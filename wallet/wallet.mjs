export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const CHAINS = {
  56: {
    chainId: "0x38",
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.bnbchain.org"],
  },
  4663: {
    chainId: "0x1237",
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  },
};

export function normalizeAddress(value) {
  return String(value || "").toLowerCase();
}

export function isOkxProvider(detail) {
  const rdns = String(detail?.info?.rdns || "").toLowerCase();
  const name = String(detail?.info?.name || "").toLowerCase();
  return rdns.includes("okx") || rdns.includes("okex") || name.includes("okx");
}

export function fallbackOkxProvider(windowObject = globalThis.window) {
  const injected = windowObject?.okxwallet;
  return injected?.ethereum || injected || null;
}

export async function discoverOkxProvider(windowObject = globalThis.window, timeoutMs = 500) {
  const discovered = [];
  const onAnnounce = (event) => {
    if (isOkxProvider(event.detail) && event.detail?.provider) discovered.push(event.detail.provider);
  };
  windowObject?.addEventListener?.("eip6963:announceProvider", onAnnounce);
  windowObject?.dispatchEvent?.(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  windowObject?.removeEventListener?.("eip6963:announceProvider", onAnnounce);
  return discovered[0] || fallbackOkxProvider(windowObject);
}

export async function connectOkx(provider, expectedAddress) {
  if (!provider?.request) throw new Error("okx_wallet_not_found");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("wallet_account_missing");
  if (normalizeAddress(address) !== normalizeAddress(expectedAddress)) throw new Error("wallet_address_mismatch");
  const chainHex = await provider.request({ method: "eth_chainId" });
  const balanceHex = await provider.request({ method: "eth_getBalance", params: [address, "latest"] });
  return { address, chainId: Number.parseInt(chainHex, 16), balanceWei: BigInt(balanceHex) };
}

export async function switchChain(provider, chainId) {
  const chain = CHAINS[Number(chainId)];
  if (!chain) throw new Error("chain_not_supported");
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.chainId }] });
  } catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [chain] });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.chainId }] });
  }
  return Number(chainId);
}

export function formatUnits(value, decimals = 18, digits = 6) {
  return (Number(BigInt(value)) / (10 ** decimals)).toFixed(digits);
}

export function formatNativeBalance(balanceWei, chainId) {
  const symbol = CHAINS[Number(chainId)]?.nativeCurrency?.symbol || "NATIVE";
  return `${formatUnits(balanceWei)} ${symbol}`;
}

export function buildQuoteUrl(config, address) {
  const bridge = config.bridge;
  const url = new URL("https://li.quest/v1/quote");
  const params = {
    fromChain: String(bridge.from_chain_id), toChain: String(bridge.to_chain_id),
    fromToken: bridge.from_token_address, toToken: bridge.to_token_address,
    fromAmount: bridge.amount_wei, fromAddress: address, toAddress: address,
    slippage: String(bridge.slippage),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

export function totalCostUsd(estimate) {
  return [...(estimate?.feeCosts || []), ...(estimate?.gasCosts || [])]
    .reduce((sum, item) => sum + Number(item?.amountUSD || 0), 0);
}

function numericChain(value) {
  if (typeof value === "string" && value.startsWith("0x")) return Number.parseInt(value, 16);
  return Number(value);
}

export function quoteFingerprint(quote) {
  const tx = quote?.transactionRequest || {};
  return [quote?.id || "", tx.to || "", tx.data || "", tx.value || "", quote?.estimate?.toAmountMin || ""].join("|");
}

export function validateBridgeQuote(quote, config, address, fetchedAt, now = Date.now()) {
  const bridge = config.bridge;
  const action = quote?.action || {};
  const tx = quote?.transactionRequest || {};
  const fromToken = action.fromToken?.address || action.fromToken;
  const toToken = action.toToken?.address || action.toToken;
  const fromAddress = action.fromAddress || tx.from;
  const toAddress = action.toAddress || address;
  if (now - fetchedAt > bridge.quote_ttl_seconds * 1000) throw new Error("quote_stale");
  if (numericChain(action.fromChainId) !== Number(bridge.from_chain_id)) throw new Error("quote_from_chain_mismatch");
  if (numericChain(action.toChainId) !== Number(bridge.to_chain_id)) throw new Error("quote_to_chain_mismatch");
  if (normalizeAddress(fromToken) !== normalizeAddress(bridge.from_token_address)) throw new Error("quote_from_token_mismatch");
  if (normalizeAddress(toToken) !== normalizeAddress(bridge.to_token_address)) throw new Error("quote_to_token_mismatch");
  if (String(action.fromAmount) !== String(bridge.amount_wei)) throw new Error("quote_amount_mismatch");
  if (normalizeAddress(fromAddress) !== normalizeAddress(address)) throw new Error("quote_sender_mismatch");
  if (normalizeAddress(toAddress) !== normalizeAddress(address)) throw new Error("quote_recipient_mismatch");
  if (BigInt(quote?.estimate?.toAmountMin || 0) < BigInt(bridge.min_destination_amount_wei)) throw new Error("quote_minimum_too_low");
  const costUsd = totalCostUsd(quote.estimate);
  if (!Number.isFinite(costUsd) || costUsd > Number(bridge.max_total_cost_usd)) throw new Error("quote_cost_too_high");
  if (!tx.to || !tx.data) throw new Error("quote_transaction_missing");
  if (numericChain(tx.chainId) !== Number(bridge.from_chain_id)) throw new Error("quote_transaction_chain_mismatch");
  if (normalizeAddress(tx.from) !== normalizeAddress(address)) throw new Error("quote_transaction_sender_mismatch");
  if (BigInt(tx.value || 0) !== BigInt(bridge.amount_wei)) throw new Error("quote_transaction_value_mismatch");
  return { quote, fetchedAt, expiresAt: fetchedAt + bridge.quote_ttl_seconds * 1000, fingerprint: quoteFingerprint(quote), costUsd };
}

export async function fetchBridgeQuote(config, address, fetcher = fetch, now = Date.now()) {
  const response = await fetcher(buildQuoteUrl(config, address), { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`quote_http_${response.status}`);
  return validateBridgeQuote(await response.json(), config, address, now, now);
}

export async function preflightBridge(provider, config, record, address, now = Date.now()) {
  validateBridgeQuote(record.quote, config, address, record.fetchedAt, now);
  const accounts = await provider.request({ method: "eth_accounts" });
  if (normalizeAddress(accounts?.[0]) !== normalizeAddress(address)) throw new Error("preflight_account_changed");
  const chainId = numericChain(await provider.request({ method: "eth_chainId" }));
  if (chainId !== Number(config.bridge.from_chain_id)) throw new Error("preflight_wrong_chain");
  const tx = record.quote.transactionRequest;
  const balance = BigInt(await provider.request({ method: "eth_getBalance", params: [address, "latest"] }));
  const gas = BigInt(await provider.request({ method: "eth_estimateGas", params: [tx] }));
  const gasPrice = BigInt(await provider.request({ method: "eth_gasPrice" }));
  const required = BigInt(tx.value || 0) + gas * gasPrice;
  if (balance < required) throw new Error("preflight_insufficient_balance");
  return { balance, gas, gasPrice, required };
}

export async function sendBridgeTransaction(provider, record) {
  return provider.request({ method: "eth_sendTransaction", params: [record.quote.transactionRequest] });
}

export async function waitForReceipt(provider, txHash, { attempts = 120, intervalMs = 3000 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error("source_transaction_failed");
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("source_receipt_timeout");
}

export async function rpcNativeBalance(rpcUrl, address, fetcher = fetch) {
  const response = await fetcher(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  if (!response.ok) throw new Error(`destination_rpc_http_${response.status}`);
  const payload = await response.json();
  if (payload.error || !payload.result) throw new Error("destination_rpc_error");
  return BigInt(payload.result);
}

export async function waitForDestinationIncrease(rpcUrl, address, baseline, { attempts = 120, intervalMs = 5000, fetcher = fetch } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const balance = await rpcNativeBalance(rpcUrl, address, fetcher);
    if (balance > BigInt(baseline)) return balance;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("destination_balance_timeout");
}
