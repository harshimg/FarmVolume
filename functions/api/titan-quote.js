// ============================================
// Cloudflare Pages Function: Titan Quote Proxy
// Proxies Titan quote API server-to-server to bypass browser CORS preflight blocks
// ============================================

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const inputMint = url.searchParams.get('inputMint');
    const outputMint = url.searchParams.get('outputMint');
    const amount = url.searchParams.get('amount');
    const userPublicKey = url.searchParams.get('userPublicKey');
    const slippageBps = url.searchParams.get('slippageBps') || '50';
    const apiKey = url.searchParams.get('apiKey') || context.request.headers.get('x-api-key') || 'EUrstrgMVk6zwYf1DLerp09DjhA7VyD5BJGuwBta';

    if (!inputMint || !outputMint || !amount || !userPublicKey) {
      return new Response(JSON.stringify({ error: 'Missing required parameters (inputMint, outputMint, amount, userPublicKey)' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const titanUrl = `https://portal.api.titan.exchange/api/v1/quote/swap?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&userPublicKey=${userPublicKey}&includeAltContents=true&slippageBps=${slippageBps}`;

    const titanRes = await fetch(titanUrl, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
      },
    });

    const responseText = await titanRes.text();

    return new Response(responseText, {
      status: titanRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Titan proxy error: ${err.message}` }), {
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
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    },
  });
}

