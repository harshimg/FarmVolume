# ⚡ FarmVolume — DEX Volume Generation Engine with Human Behavior Simulation

FarmVolume is an automated volume generator designed for DEX aggregators (like **Titan Exchange** and **Jupiter** on Solana). It executes intelligent swap cycles on chosen pairs (such as `USDC/USDT`) while minimizing fee and slippage losses and simulating authentic human trading activity to avoid bot detection.

---

## 🌟 Core Features

### 1. 🔄 Low-Loss Volume Generation
- **A ⇄ B Cyclic Swapping**: Continuously cycles between Token A and Token B (e.g., `USDC` → `USDT` → `USDC`).
- **Stablecoin Optimized**: Special tight-slippage guards (< 0.1% / 10-30 bps) designed specifically for pegged assets (`USDC/USDT`).
- **Trade Splitting**: Large allocations are automatically split into micro-chunks to prevent price impact on liquidity pools.
- **Titan Exchange Meta-Aggregation**: Directly leverages Titan's zero-platform-fee architecture and *Argos* routing across Orca, Raydium, Meteora, and Phoenix.

### 2. 🎭 Human Behavior Simulation Engine
Makes trading patterns indistinguishable from a real human trader:
- **Gaussian-Distributed Delays**: Wait times follow natural bell curves (e.g. 8–45s) instead of predictable fixed intervals.
- **Session Breaks & Fatigue**: Simulates trading fatigue by slightly increasing delays over time and taking periodic 5–15 min coffee breaks.
- **Pair Switching / Distraction Swaps**: After a few swaps on the main pair, the bot briefly performs 1–2 small swaps on other pairs (like `SOL/USDC` or `JUP/USDC`) before returning.
- **Human Micro-Pauses**: Simulates a user "reading the quote" for 1–3s before confirming.
- **Round Number Bias**: Real humans often trade round amounts ($10, $25, $50); the engine randomly snaps amounts to natural increments.
- **Skip Probabilities**: Simulates occasional "changed my mind" trade cancellations.

### 3. 🛡️ Multi-Tier Risk Management
- **Max Loss Stop**: Automatically halts if cumulative losses reach your configured dollar or percentage threshold.
- **Per-Trade Slippage Limit**: Skips quotes where price impact or spread is unacceptable.
- **SOL Gas Guard**: Verifies you maintain sufficient SOL balance for gas so transactions never fail mid-cycle.
- **Emergency Kill Switch**: One-click halt from the CLI or live web UI.

### 4. 📊 Live Dark-Mode Web Dashboard & SQLite Analytics
- Real-time P&L, fees, and volume counter updated every 2 seconds.
- Human behavior status monitor showing fatigue multiplier and next distraction swap.
- Full audit log of all transactions saved to an embedded SQLite database (`farmvolume.db`).

---

## 🚀 Quick Start

### 1. Installation
```bash
npm install
# or
pnpm install
```

### 2. Setup Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` with your Solana details:
```env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PRIVATE_KEY=your_base58_private_key_here

TITAN_API_ENDPOINT=wss://router-api.titan.exchange/ws
TITAN_AUTH_TOKEN=your_titan_auth_token_here
```

### 3. Build & Run
```bash
# Build TypeScript
npm run build

# Start volume generation on USDC/USDT with $100 budget
npm start -- start -p USDC_USDT -f 100 --min-size 10 --max-size 50 -t 5000

# Open Dashboard in your browser:
# http://localhost:3847
```

---

## 🕹️ CLI Commands

| Command | Description |
|---|---|
| `farmvolume start -p <PAIR> -f <FUNDS>` | Start volume generation on a pair |
| `farmvolume start --profile cautious` | Run with conservative human simulation delays |
| `farmvolume start --profile aggressive` | Run with faster burst trading |
| `farmvolume dashboard` | Start standalone analytics UI on port 3847 |
| `farmvolume report` | View terminal summary of historical sessions |

---

## 💡 Advanced Features to Add

1. **Spread & Peg Deviation Arbitrage**:
   - Only swap `USDC → USDT` when USDT trades at a discount (e.g. $0.9998) and swap back when it normalizes. This generates volume while **earning small profits** instead of paying fees.
2. **Multi-Wallet Sybil Obfuscation**:
   - Automatically split funds across 3–5 sub-wallets that trade asynchronously to prevent on-chain cluster identification.
3. **Auto SOL Balance Refill**:
   - Automatically swap $5 USDC into SOL whenever the wallet balance drops below 0.02 SOL.
4. **Telegram / Discord Alerts**:
   - Real-time milestone updates directly to your phone when you hit $10k, $50k, or $100k volume.

