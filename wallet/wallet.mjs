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
  return new URL("https://api.relay.link/quote");
}

export function buildRelayQuoteBody(config, address) {
  const bridge = config.bridge;
  return {
    user: address,
    recipient: bridge.recipient_address || address,
    originChainId: Number(bridge.from_chain_id),
    destinationChainId: Number(bridge.to_chain_id),
    originCurrency: bridge.from_token_address,
    destinationCurrency: bridge.to_token_address,
    amount: bridge.amount_wei,
    tradeType: "EXACT_INPUT",
  };
}

export function totalCostUsd(estimate) {
  return [...(estimate?.feeCosts || []), ...(estimate?.gasCosts || [])]
    .reduce((sum, item) => sum + Number(item?.amountUSD || 0), 0);
}

function numericChain(value) {
  if (typeof value === "string" && value.startsWith("0x")) return Number.parseInt(value, 16);
  return Number(value);
}

function hexQuantity(value) {
  if (typeof value === "string" && value.startsWith("0x")) return value;
  return `0x${BigInt(value).toString(16)}`;
}

export function normalizeTransactionRequest(transactionRequest) {
  const tx = { ...transactionRequest };
  if (tx.chainId !== undefined) tx.chainId = hexQuantity(tx.chainId);
  if (tx.value !== undefined) tx.value = hexQuantity(tx.value);
  if (tx.gasPrice !== undefined) tx.gasPrice = hexQuantity(tx.gasPrice);
  if (tx.maxFeePerGas !== undefined) tx.maxFeePerGas = hexQuantity(tx.maxFeePerGas);
  if (tx.maxPriorityFeePerGas !== undefined) tx.maxPriorityFeePerGas = hexQuantity(tx.maxPriorityFeePerGas);
  if (tx.gas !== undefined) tx.gas = hexQuantity(tx.gas);
  if (tx.gasLimit !== undefined && tx.gas === undefined) tx.gas = hexQuantity(tx.gasLimit);
  delete tx.gasLimit;
  return tx;
}

export function quoteFingerprint(quote) {
  const tx = quote?.transactionRequest || {};
  return [quote?.id || "", tx.to || "", tx.data || "", tx.value || "", quote?.estimate?.toAmountMin || ""].join("|");
}

export function normalizeRelayQuote(payload) {
  const details = payload?.details || {};
  const tx = payload?.steps?.find((step) => step.kind === "transaction")?.items?.[0]?.data;
  const impactUsd = Math.abs(Number(details?.totalImpact?.usd || 0));
  return {
    id: payload?.steps?.[0]?.requestId,
    tool: "relay",
    action: {
      fromChainId: details?.currencyIn?.currency?.chainId,
      toChainId: details?.currencyOut?.currency?.chainId,
      fromToken: { address: details?.currencyIn?.currency?.address },
      toToken: { address: details?.currencyOut?.currency?.address },
      fromAmount: details?.currencyIn?.amount,
      fromAddress: details?.sender,
      toAddress: details?.recipient,
    },
    estimate: {
      toAmount: details?.currencyOut?.amount,
      toAmountMin: details?.currencyOut?.minimumAmount,
      feeCosts: [{ amountUSD: String(impactUsd) }],
      gasCosts: [],
    },
    transactionRequest: tx,
    relay: payload,
  };
}

export function validateBridgeQuote(quote, config, address, fetchedAt, now = Date.now()) {
  const bridge = config.bridge;
  const action = quote?.action || {};
  const tx = quote?.transactionRequest || {};
  const fromToken = action.fromToken?.address || action.fromToken;
  const toToken = action.toToken?.address || action.toToken;
  const fromAddress = action.fromAddress || tx.from;
  const recipient = bridge.recipient_address || address;
  const toAddress = action.toAddress || recipient;
  if (now - fetchedAt > bridge.quote_ttl_seconds * 1000) throw new Error("quote_stale");
  if (numericChain(action.fromChainId) !== Number(bridge.from_chain_id)) throw new Error("quote_from_chain_mismatch");
  if (numericChain(action.toChainId) !== Number(bridge.to_chain_id)) throw new Error("quote_to_chain_mismatch");
  if (normalizeAddress(fromToken) !== normalizeAddress(bridge.from_token_address)) throw new Error("quote_from_token_mismatch");
  if (normalizeAddress(toToken) !== normalizeAddress(bridge.to_token_address)) throw new Error("quote_to_token_mismatch");
  if (String(action.fromAmount) !== String(bridge.amount_wei)) throw new Error("quote_amount_mismatch");
  if (normalizeAddress(fromAddress) !== normalizeAddress(address)) throw new Error("quote_sender_mismatch");
  if (normalizeAddress(toAddress) !== normalizeAddress(recipient)) throw new Error("quote_recipient_mismatch");
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
  const response = await fetcher(buildQuoteUrl(config, address), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(buildRelayQuoteBody(config, address)),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`quote_http_${response.status}`);
  return validateBridgeQuote(normalizeRelayQuote(await response.json()), config, address, now, now);
}

export async function preflightBridge(provider, config, record, address, now = Date.now()) {
  validateBridgeQuote(record.quote, config, address, record.fetchedAt, now);
  const accounts = await provider.request({ method: "eth_accounts" });
  if (normalizeAddress(accounts?.[0]) !== normalizeAddress(address)) throw new Error("preflight_account_changed");
  const chainId = numericChain(await provider.request({ method: "eth_chainId" }));
  if (chainId !== Number(config.bridge.from_chain_id)) throw new Error("preflight_wrong_chain");
  const tx = normalizeTransactionRequest(record.quote.transactionRequest);
  const balance = BigInt(await provider.request({ method: "eth_getBalance", params: [address, "latest"] }));
  const networkGasPrice = BigInt(await provider.request({ method: "eth_gasPrice" }));
  const quotedGasPrice = BigInt(tx.maxFeePerGas || tx.gasPrice || 0);
  const gasPrice = [quotedGasPrice, networkGasPrice * 125n / 100n].reduce((a, b) => a > b ? a : b);
  if (tx.maxFeePerGas !== undefined) {
    tx.maxFeePerGas = hexQuantity(gasPrice);
    tx.maxPriorityFeePerGas = hexQuantity(tx.maxPriorityFeePerGas || 0);
    delete tx.gasPrice;
  } else {
    tx.gasPrice = hexQuantity(gasPrice);
  }
  const estimateTx = { ...tx };
  delete estimateTx.gas;
  const estimatedGas = BigInt(await provider.request({ method: "eth_estimateGas", params: [estimateTx] }));
  const quotedGas = BigInt(tx.gas || 0);
  const gas = [quotedGas, estimatedGas * 120n / 100n].reduce((a, b) => a > b ? a : b);
  tx.gas = hexQuantity(gas);
  const required = BigInt(tx.value || 0) + gas * gasPrice;
  if (balance < required) throw new Error("preflight_insufficient_balance");
  return { balance, gas, gasPrice, required, transaction: tx };
}

export async function sendBridgeTransaction(provider, record, preparedTransaction = null) {
  const transaction = preparedTransaction || normalizeTransactionRequest(record.quote.transactionRequest);
  return provider.request({ method: "eth_sendTransaction", params: [transaction] });
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
