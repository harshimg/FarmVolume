// ============================================
// Cloudflare Pages Function: Wallet Balances
// ============================================

const TOKENS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

async function rpcCall(method, params) {
  const res = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });
  return await res.json();
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const pubkey = url.searchParams.get('pubkey');

  if (!pubkey) {
    return new Response(JSON.stringify({ error: 'Missing pubkey parameter' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  try {
    // 1. Fetch SOL Balance
    const solData = await rpcCall('getBalance', [pubkey]);
    const sol = (solData?.result?.value || 0) / 1e9;

    // 2. Fetch USDC Balance
    let usdc = 0;
    try {
      const usdcData = await rpcCall('getTokenAccountsByOwner', [
        pubkey,
        { mint: TOKENS.USDC },
        { encoding: 'jsonParsed' }
      ]);
      const accounts = usdcData?.result?.value || [];
      for (const acc of accounts) {
        usdc += acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      }
    } catch (_) {}

    // 3. Fetch USDT Balance
    let usdt = 0;
    try {
      const usdtData = await rpcCall('getTokenAccountsByOwner', [
        pubkey,
        { mint: TOKENS.USDT },
        { encoding: 'jsonParsed' }
      ]);
      const accounts = usdtData?.result?.value || [];
      for (const acc of accounts) {
        usdt += acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      }
    } catch (_) {}

    return new Response(JSON.stringify({ sol, usdc, usdt }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

