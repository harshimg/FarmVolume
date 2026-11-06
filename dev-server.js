const http = require('http');
const fs = require('fs');
const path = require('path');

let Connection, PublicKey, getAssociatedTokenAddress, getAccount;
try {
  const web3 = require('@solana/web3.js');
  Connection = web3.Connection;
  PublicKey = web3.PublicKey;
  const spl = require('@solana/spl-token');
  getAssociatedTokenAddress = spl.getAssociatedTokenAddress;
  getAccount = spl.getAccount;
} catch (e) {
  console.warn('Solana Web3 / SPL module note:', e.message);
}

const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
let connection;
if (Connection) {
  connection = new Connection(RPC_URL, 'confirmed');
}

const TOKENS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

const server = http.createServer(async (req, res) => {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const baseURL = 'http://' + (req.headers.host || 'localhost');
  const parsedUrl = new URL(req.url, baseURL);
  const pathname = parsedUrl.pathname;

  // API 1: /api/wallet-balances
  if (pathname === '/api/wallet-balances') {
    const pubkeyStr = parsedUrl.searchParams.get('pubkey');
    if (!pubkeyStr || !connection) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing pubkey or Solana connection not available' }));
      return;
    }

    try {
      const pubkey = new PublicKey(pubkeyStr);

      // 1. SOL balance
      const lamports = await connection.getBalance(pubkey);
      const sol = lamports / 1e9;

      // 2. USDC balance
      let usdc = 0;
      try {
        const usdcMint = new PublicKey(TOKENS.USDC);
        const parsed = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: usdcMint });
        for (const item of parsed.value) {
          usdc += item.account.data.parsed.info.tokenAmount.uiAmount || 0;
        }
      } catch (_) {}

      if (usdc === 0 && getAssociatedTokenAddress) {
        try {
          const usdcAta = await getAssociatedTokenAddress(new PublicKey(TOKENS.USDC), pubkey);
          const bal = await connection.getTokenAccountBalance(usdcAta);
          usdc = bal?.value?.uiAmount || 0;
        } catch (_) {}
      }

      // 3. USDT balance
      let usdt = 0;
      try {
        const usdtMint = new PublicKey(TOKENS.USDT);
        const parsed = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: usdtMint });
        for (const item of parsed.value) {
          usdt += item.account.data.parsed.info.tokenAmount.uiAmount || 0;
        }
      } catch (_) {}

      if (usdt === 0 && getAssociatedTokenAddress) {
        try {
          const usdtAta = await getAssociatedTokenAddress(new PublicKey(TOKENS.USDT), pubkey);
          const bal = await connection.getTokenAccountBalance(usdtAta);
          usdt = bal?.value?.uiAmount || 0;
        } catch (_) {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sol, usdc, usdt }));
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // API 2: /api/titan-quote (Server proxy for Titan Exchange to bypass browser CORS)
  if (pathname === '/api/titan-quote') {
    const inputMint = parsedUrl.searchParams.get('inputMint');
    const outputMint = parsedUrl.searchParams.get('outputMint');
    const amount = parsedUrl.searchParams.get('amount');
    const userPublicKey = parsedUrl.searchParams.get('userPublicKey');
    const slippageBps = parsedUrl.searchParams.get('slippageBps') || '50';
    const apiKey = parsedUrl.searchParams.get('apiKey') || req.headers['x-api-key'] || process.env.TITAN_AUTH_TOKEN || 'EUrstrgMVk6zwYf1DLerp09DjhA7VyD5BJGuwBta';

    if (!inputMint || !outputMint || !amount || !userPublicKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameters for Titan quote' }));
      return;
    }

    try {
      const fetch = (await import('node-fetch')).default;
      const titanUrl = `https://portal.api.titan.exchange/api/v1/quote/swap?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&userPublicKey=${userPublicKey}&includeAltContents=true&slippageBps=${slippageBps}`;
      
      const titanRes = await fetch(titanUrl, {
        headers: {
          'x-api-key': apiKey,
          'Accept': 'application/json',
        },
      });

      const responseText = await titanRes.text();
      res.writeHead(titanRes.status, { 'Content-Type': 'application/json' });
      res.end(responseText);
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Titan proxy error: ${err.message}` }));
      return;
    }
  }

  // API 2: /api/rpc (Proxy for Solana RPC JSON-RPC calls)
  if (pathname === '/api/rpc') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', async () => {
      try {
        const fetch = (await import('node-fetch')).default;
        const rpcRes = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyData,
        });
        const rpcText = await rpcRes.text();
        res.writeHead(rpcRes.status, { 'Content-Type': 'application/json' });
        res.end(rpcText);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static File Serving
  let reqPath = pathname === '/' ? 'index.html' : pathname;
  let filePath = path.join(__dirname, reqPath);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  const contentType = mimeTypes[ext] || 'text/html';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n===========================================`);
  console.log(`🚀 FarmVolume Web3 dApp Running!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`===========================================\n`);
});
