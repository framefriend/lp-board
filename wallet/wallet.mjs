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
  const matched = normalizeAddress(address) === normalizeAddress(expectedAddress);
  if (!matched) throw new Error("wallet_address_mismatch");
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

export function formatNativeBalance(balanceWei, chainId) {
  const amount = Number(balanceWei) / 1e18;
  const symbol = CHAINS[Number(chainId)]?.nativeCurrency?.symbol || "NATIVE";
  return `${amount.toFixed(6)} ${symbol}`;
}
