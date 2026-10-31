const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

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

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // API 1: /api/wallet-balances
  if (pathname === '/api/wallet-balances') {
    const pubkeyStr = parsedUrl.query.pubkey;
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
        const usdcAta = await getAssociatedTokenAddress(usdcMint, pubkey);
        const acc = await getAccount(connection, usdcAta);
        usdc = Number(acc.amount) / 1e6;
      } catch (_) {
        try {
          const usdcMint = new PublicKey(TOKENS.USDC);
          const parsed = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: usdcMint });
          for (const item of parsed.value) {
            usdc += item.account.data.parsed.info.tokenAmount.uiAmount || 0;
          }
        } catch (_) {}
      }

      // 3. USDT balance
      let usdt = 0;
      try {
        const usdtMint = new PublicKey(TOKENS.USDT);
        const usdtAta = await getAssociatedTokenAddress(usdtMint, pubkey);
        const acc = await getAccount(connection, usdtAta);
        usdt = Number(acc.amount) / 1e6;
      } catch (_) {
        try {
          const usdtMint = new PublicKey(TOKENS.USDT);
          const parsed = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: usdtMint });
          for (const item of parsed.value) {
            usdt += item.account.data.parsed.info.tokenAmount.uiAmount || 0;
          }
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
