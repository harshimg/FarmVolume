// ============================================
// FarmVolume — Web Dashboard Server
// ============================================

import express from 'express';
import path from 'path';
import fs from 'fs';
import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { VolumeEngine } from '../engine/volume-engine';
import { TradeTracker } from '../analytics/tracker';
import { AnalyticsReporter } from '../analytics/reporter';
import { TOKENS, PAIRS, toRawAmount, fromRawAmount } from '../utils/tokens';
import { logger } from '../utils/logger';
import { loadConfig } from '../config';
import { TradeStatus, TradeDirection } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface ActiveAutoCycle {
  id: string;
  totalCycles: number;
  completedCycles: number;
  totalSwaps: number;
  completedSwaps: number;
  status: 'running' | 'paused' | 'completed' | 'stopped' | 'error';
  lastError?: string;
  pair: string;
  amount: number;
  exchange: string;
}

export class DashboardServer {
  private app: express.Application;
  private port: number;
  private engine: VolumeEngine | null = null;
  private tracker: TradeTracker;
  private reporter: AnalyticsReporter;
  private server: any = null;
  private rpcUrl: string;
  private connection: Connection;

  // Active hands-free loop state
  private activeAutoCycle: ActiveAutoCycle | null = null;
  private stopAutoCycleRequested: boolean = false;

  constructor(port: number = 3847, tracker?: TradeTracker) {
    this.port = port;
    this.app = express();
    this.tracker = tracker || new TradeTracker();
    this.reporter = new AnalyticsReporter(this.tracker);
    const config = loadConfig();
    this.rpcUrl = config.solanaRpcUrl;
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    this.setupRoutes();
  }

  setEngine(engine: VolumeEngine): void {
    this.engine = engine;

    this.engine.on('trade', (trade) => {
      this.tracker.recordTrade(trade);
    });

    this.engine.on('stopped', (state) => {
      this.tracker.saveSession(state.sessionId, {
        total_volume_usd: state.totalVolumeUsd,
        total_fees_usd: state.totalFeesUsd,
        total_pnl_usd: state.totalPnlUsd,
        total_swaps: state.totalSwaps,
        successful_swaps: state.successfulSwaps,
        failed_swaps: state.failedSwaps,
        skipped_swaps: state.skippedSwaps,
        stopped_at: state.stoppedAt,
        status: state.status,
      });
    });
  }

  private setupRoutes(): void {
    this.app.use(express.json());
    const publicDir = fs.existsSync(path.join(__dirname, 'public'))
      ? path.join(__dirname, 'public')
      : path.join(__dirname, '../../src/dashboard/public');
    this.app.use(express.static(publicDir));

    // API: Fast Blockhash proxy (solves browser 403 CORS error)
    this.app.get('/api/blockhash', async (req, res) => {
      try {
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        res.json({ blockhash });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // API: Live status & analytics
    this.app.get('/api/status', (req, res) => {
      const recentTrades = this.tracker.getRecentTrades(undefined, 25);
      let totalVol = 0;
      let totalPnl = 0;
      let totalFees = 0;
      for (const t of recentTrades) {
        if (t.status === 'CONFIRMED') totalVol += t.inputAmount;
        totalPnl += t.pnlUsd || 0;
        totalFees += t.feePaidUsd || 0;
      }

      const confirmedCount = recentTrades.filter((t) => t.status === 'CONFIRMED').length;

      res.json({
        session: {
          sessionId: 'browser-wallet-session',
          status: this.activeAutoCycle ? this.activeAutoCycle.status : (this.engine ? this.engine.getState().status : 'idle'),
          totalSwaps: recentTrades.length,
          totalCycles: Math.floor(confirmedCount / 2),
          successfulSwaps: confirmedCount,
          failedSwaps: recentTrades.filter((t) => t.status === 'FAILED').length,
          skippedSwaps: 0,
          distractionSwaps: recentTrades.filter((t) => t.isDistraction).length,
          totalVolumeUsd: totalVol,
          totalFeesUsd: totalFees,
          totalPnlUsd: totalPnl,
          currentPhase: 'active',
          tradesInCurrentBurst: this.activeAutoCycle ? this.activeAutoCycle.completedSwaps : 0,
          tradesUntilPairSwitch: 5,
          currentFatigueMultiplier: 1.0,
        },
        autoCycle: this.activeAutoCycle,
        recentTrades,
        avgSlippageBps: 2.5,
        volumePerHour: 0,
      });
    });

    // API: Wallet Balances (SOL, USDC, USDT)
    this.app.get('/api/wallet-balances', async (req, res) => {
      try {
        const pubkeyStr = req.query.pubkey as string;
        if (!pubkeyStr) {
          return res.status(400).json({ error: 'Missing pubkey query parameter' });
        }

        const pubkey = new PublicKey(pubkeyStr);

        // Fetch SOL balance
        const solLamports = await this.connection.getBalance(pubkey);
        const solBalance = solLamports / 1e9;

        // Fetch USDC balance
        let usdcBalance = 0;
        try {
          const usdcMint = new PublicKey(TOKENS.USDC.mint);
          const usdcAta = await getAssociatedTokenAddress(usdcMint, pubkey);
          const acc = await getAccount(this.connection, usdcAta);
          usdcBalance = fromRawAmount(acc.amount, TOKENS.USDC.decimals);
        } catch {
          usdcBalance = 0;
        }

        // Fetch USDT balance
        let usdtBalance = 0;
        try {
          const usdtMint = new PublicKey(TOKENS.USDT.mint);
          const usdtAta = await getAssociatedTokenAddress(usdtMint, pubkey);
          const acc = await getAccount(this.connection, usdtAta);
          usdtBalance = fromRawAmount(acc.amount, TOKENS.USDT.decimals);
        } catch {
          usdtBalance = 0;
        }

        res.json({
          sol: solBalance,
          usdc: usdcBalance,
          usdt: usdtBalance,
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // API: Titan Quote Proxy (bypasses browser CORS preflight restrictions)
    this.app.get('/api/titan-quote', async (req, res) => {
      try {
        const { inputMint, outputMint, amount, userPublicKey, slippageBps = '50', apiKey } = req.query;
        if (!inputMint || !outputMint || !amount || !userPublicKey) {
          return res.status(400).json({ error: 'Missing required parameters (inputMint, outputMint, amount, userPublicKey)' });
        }
        const config = loadConfig();
        const key = (apiKey as string) || (req.headers['x-api-key'] as string) || config.titanAuthToken || 'EUrstrgMVk6zwYf1DLerp09DjhA7VyD5BJGuwBta';
        const fetch = (await import('node-fetch')).default;
        const titanUrl = `https://portal.api.titan.exchange/api/v1/quote/swap?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&userPublicKey=${userPublicKey}&includeAltContents=true&slippageBps=${slippageBps}`;
        const titanRes = await fetch(titanUrl, {
          headers: {
            'x-api-key': key,
            Accept: 'application/json',
          },
        });
        const data = await titanRes.text();
        res.status(titanRes.status).send(data);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // API: Prepare Swap Transaction for Browser Wallet Signing
    // OPTIMIZED for minimum SOL cost and direct single-hop routing!
    this.app.post('/api/prepare-swap', async (req, res) => {
      try {
        const {
          userPublicKey,
          inputMint,
          outputMint,
          amount,
          slippageBps = 30,
          exchange = 'jupiter',
          titanApiKey = '',
          priorityFeeLamports = 5000, // Minimal fixed priority fee: ~0.000005 SOL ($0.0008)
          onlyDirectRoutes = true,     // Direct routes prevent 3-hop intermediate rent fees!
        } = req.body;

        if (!userPublicKey || !inputMint || !outputMint || !amount) {
          return res.status(400).json({ error: 'Missing required parameters' });
        }

        const fetch = (await import('node-fetch')).default;
        const config = loadConfig();

        let inputDecimals = 6;
        if (inputMint === TOKENS.SOL.mint) inputDecimals = 9;
        const rawAmount = toRawAmount(parseFloat(amount), inputDecimals);

        let outputDecimals = 6;
        if (outputMint === TOKENS.SOL.mint) outputDecimals = 9;

        // ============================================
        // Route 1: Titan Exchange (DART Architecture)
        // ============================================
        if (exchange === 'titan') {
          const apiKey = titanApiKey || config.titanAuthToken || 'EUrstrgMVk6zwYf1DLerp09DjhA7VyD5BJGuwBta';
          if (!apiKey) {
            return res.status(400).json({
              error:
                'Titan API key required! Please enter your Titan API key from developer.titan.exchange, or switch to Jupiter for instant swaps without an API key.',
            });
          }

          const titanUrl =
            `https://portal.api.titan.exchange/api/v1/quote/swap?` +
            `inputMint=${inputMint}` +
            `&outputMint=${outputMint}` +
            `&amount=${rawAmount.toString()}` +
            `&userPublicKey=${userPublicKey}` +
            `&includeAltContents=true` +
            `&slippageBps=${slippageBps}`;

          const titanRes = await fetch(titanUrl, {
            headers: {
              'x-api-key': apiKey,
              Accept: 'application/json',
            },
          });

          if (!titanRes.ok) {
            const errText = await titanRes.text();
            return res.status(400).json({ error: `Titan Exchange error: ${errText}` });
          }

          const titanData = (await titanRes.json()) as any;
          const dart = titanData.quotes?.['Titan-DART'] || (titanData.quotes && Object.values(titanData.quotes)[0]);

          if (!dart || !dart.instructions) {
            return res.status(400).json({ error: 'No Titan DART routing instructions found for this pair' });
          }

          const lookupTableAccounts = (titanData.alts || []).map((alt: any) => new AddressLookupTableAccount({
            key: new PublicKey(alt.p),
            state: {
              deactivationSlot: BigInt('18446744073709551615'),
              lastExtendedSlot: 0,
              lastExtendedSlotStartIndex: 0,
              authority: undefined,
              addresses: alt.a.map((addr: string) => new PublicKey(addr)),
            }
          }));

          const instructions: TransactionInstruction[] = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
          ];

          for (const ix of dart.instructions) {
            if (ix.p === ComputeBudgetProgram.programId.toBase58()) continue;
            instructions.push(new TransactionInstruction({
              programId: new PublicKey(ix.p),
              keys: ix.a.map((acc: any) => ({
                pubkey: new PublicKey(acc.p),
                isSigner: acc.s,
                isWritable: acc.w,
              })),
              data: Buffer.from(ix.d, 'base64'),
            }));
          }

          const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

          const messageV0 = new TransactionMessage({
            payerKey: new PublicKey(userPublicKey),
            recentBlockhash: blockhash,
            instructions,
          }).compileToV0Message(lookupTableAccounts);

          const tx = new VersionedTransaction(messageV0);
          const txBase64 = Buffer.from(tx.serialize()).toString('base64');
          const outAmount = fromRawAmount(BigInt(dart.outAmount || '0'), outputDecimals);

          return res.json({
            swapTransaction: txBase64,
            inputAmount: parseFloat(amount),
            expectedOutput: outAmount,
            priceImpactPct: 0.01,
            routePlan: 'Titan-DART (Argos Meta-DEX Router)',
            exchange: 'titan',
          });
        }

        // ============================================
        // Route 2: Jupiter Aggregator (Optimized low-fee)
        // ============================================
        const directParam = onlyDirectRoutes ? '&onlyDirectRoutes=true' : '';
        const quoteUrl =
          `https://api.jup.ag/swap/v1/quote?` +
          `inputMint=${inputMint}` +
          `&outputMint=${outputMint}` +
          `&amount=${rawAmount.toString()}` +
          `&slippageBps=${slippageBps}` +
          `&swapMode=ExactIn` +
          directParam;

        const quoteRes = await fetch(quoteUrl);
        if (!quoteRes.ok) {
          // If direct routes had no liquidity, fallback to standard quote
          const fallbackUrl =
            `https://api.jup.ag/swap/v1/quote?` +
            `inputMint=${inputMint}` +
            `&outputMint=${outputMint}` +
            `&amount=${rawAmount.toString()}` +
            `&slippageBps=${slippageBps}` +
            `&swapMode=ExactIn`;

          const fallbackRes = await fetch(fallbackUrl);
          if (!fallbackRes.ok) {
            const errorText = await fallbackRes.text();
            return res.status(400).json({ error: `Jupiter Quote failed: ${errorText}` });
          }
          const quoteResponse = await fallbackRes.json();
          return this.buildJupiterSwap(quoteResponse, userPublicKey, priorityFeeLamports, parseFloat(amount), outputDecimals, res);
        }

        const quoteResponse = await quoteRes.json();
        return this.buildJupiterSwap(quoteResponse, userPublicKey, priorityFeeLamports, parseFloat(amount), outputDecimals, res);
      } catch (err) {
        logger.error(`Error in /api/prepare-swap: ${(err as Error).message}`);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // API: Record a transaction executed in the browser wallet
    this.app.post('/api/record-swap', (req, res) => {
      try {
        const {
          signature,
          inputToken,
          outputToken,
          inputAmount,
          outputAmount,
          exchange = 'titan',
          isDistraction = false,
        } = req.body;

        const inputUsd = parseFloat(inputAmount);
        const outputUsd = parseFloat(outputAmount);
        const feeUsd = exchange === 'titan' ? 0.0001 : 0.0003;
        const pnlUsd = outputUsd - inputUsd - feeUsd;
        const slippageBps = ((inputUsd - outputUsd) / inputUsd) * 10000;

        const tradeRecord = {
          id: uuidv4(),
          sessionId: 'browser-wallet-session',
          pairId: `${inputToken}_${outputToken}`,
          exchange,
          direction: TradeDirection.A_TO_B,
          status: TradeStatus.CONFIRMED,
          inputToken,
          outputToken,
          inputAmount: inputUsd,
          expectedOutputAmount: outputUsd,
          actualOutputAmount: outputUsd,
          slippageBps: 30,
          actualSlippageBps: slippageBps,
          feePaidUsd: feeUsd,
          pnlUsd,
          txSignature: signature,
          isDistraction,
          createdAt: Date.now(),
          executedAt: Date.now(),
        };

        this.tracker.recordTrade(tradeRecord);
        res.json({ success: true, trade: tradeRecord });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // ============================================
    // API: Prepare Funding Transaction for Delegated Session
    // Transfers the swap token (USDT/USDC) + 0.003 SOL to the session keypair in 1 signature!
    // ============================================
    this.app.post('/api/auto-cycle/prepare-funding-tx', async (req, res) => {
      try {
        const { userPublicKey, amount, tokenSymbol = 'USDT' } = req.body;
        if (!userPublicKey || !amount) {
          return res.status(400).json({ error: 'Missing userPublicKey or amount' });
        }

        const userPubkey = new PublicKey(userPublicKey);
        const sessionKeypair = Keypair.generate();
        const sessionPubkey = sessionKeypair.publicKey;

        const token = tokenSymbol === 'USDC' ? TOKENS.USDC : TOKENS.USDT;
        const mintPubkey = new PublicKey(token.mint);
        const rawAmount = toRawAmount(parseFloat(amount), token.decimals);

        const usdcMint = new PublicKey(TOKENS.USDC.mint);
        const usdtMint = new PublicKey(TOKENS.USDT.mint);

        const userAta = await getAssociatedTokenAddress(mintPubkey, userPubkey);
        const sessionUsdcAta = await getAssociatedTokenAddress(usdcMint, sessionPubkey);
        const sessionUsdtAta = await getAssociatedTokenAddress(usdtMint, sessionPubkey);

        const tx = new Transaction();

        // 1. Transfer 0.005 SOL to session keypair for gas/fees
        tx.add(
          SystemProgram.transfer({
            fromPubkey: userPubkey,
            toPubkey: sessionPubkey,
            lamports: 5000000, // 0.005 SOL
          })
        );

        // 2. Initialize BOTH USDC and USDT ATAs for the session so swaps can bounce back and forth freely
        tx.add(
          createAssociatedTokenAccountInstruction(
            userPubkey,
            sessionUsdcAta,
            sessionPubkey,
            usdcMint
          )
        );
        tx.add(
          createAssociatedTokenAccountInstruction(
            userPubkey,
            sessionUsdtAta,
            sessionPubkey,
            usdtMint
          )
        );

        // 3. Transfer the funded capital to the respective session ATA
        const targetSessionAta = tokenSymbol === 'USDC' ? sessionUsdcAta : sessionUsdtAta;
        tx.add(
          createTransferInstruction(
            userAta,
            targetSessionAta,
            userPubkey,
            rawAmount
          )
        );

        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = userPubkey;

        const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

        res.json({
          sessionPublicKey: sessionPubkey.toBase58(),
          sessionSecretKey: bs58.encode(sessionKeypair.secretKey),
          transaction: serialized.toString('base64'),
          tokenSymbol: token.symbol,
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // ============================================
    // API: Start Hands-Free Auto-Cycle Loop
    // ============================================
    this.app.post('/api/auto-cycle/start', async (req, res) => {
      try {
        const {
          cycles = 5,
          amount = 1.0,
          pair = 'USDC_USDT',
          exchange = 'titan',
          delayMs = 0,
          sessionSecretKey,
          returnAddress,
        } = req.body;

        const config = loadConfig();

        let keypair: Keypair;
        if (sessionSecretKey) {
          keypair = Keypair.fromSecretKey(bs58.decode(sessionSecretKey));
        } else if (config.solanaKeypair) {
          keypair = config.solanaKeypair;
        } else {
          return res.status(400).json({
            error: 'No session keypair provided and no SOLANA_PRIVATE_KEY in .env',
          });
        }

        const totalSwaps = cycles * 2;
        this.activeAutoCycle = {
          id: uuidv4(),
          totalCycles: cycles,
          completedCycles: 0,
          totalSwaps,
          completedSwaps: 0,
          status: 'running',
          pair,
          amount: parseFloat(amount),
          exchange,
        };

        this.stopAutoCycleRequested = false;

        res.json({
          success: true,
          message: `Auto-cycle loop started for ${cycles} cycles (${totalSwaps} swaps hands-free) on ${exchange.toUpperCase()}!`,
          autoCycle: this.activeAutoCycle,
        });

        // Run the loop in background
        this.runHandsFreeLoop(keypair, cycles, parseFloat(amount), pair, exchange, delayMs, returnAddress);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // API: Stop active Auto-Cycle Loop
    this.app.post('/api/auto-cycle/stop', (req, res) => {
      this.stopAutoCycleRequested = true;
      if (this.activeAutoCycle) {
        this.activeAutoCycle.status = 'stopped';
      }
      res.json({ success: true, message: 'Auto-cycle loop stop requested' });
    });

    // API: Withdraw Session Funds back to User's Phantom Wallet
    this.app.post('/api/auto-cycle/withdraw', async (req, res) => {
      try {
        const { sessionSecretKey, returnAddress } = req.body;
        if (!sessionSecretKey || !returnAddress) {
          return res.status(400).json({ error: 'Missing sessionSecretKey or returnAddress' });
        }

        const sessionKeypair = Keypair.fromSecretKey(bs58.decode(sessionSecretKey));
        const results = await this.sweepFunds(sessionKeypair, returnAddress);

        res.json({ success: true, details: results });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // API: Control - Emergency Stop
    this.app.post('/api/control/emergency-stop', (req, res) => {
      this.stopAutoCycleRequested = true;
      if (this.activeAutoCycle) {
        this.activeAutoCycle.status = 'stopped';
      }
      if (this.engine) {
        this.engine.emergencyStop();
      }
      res.json({ success: true, status: 'emergency_stopped' });
    });
  }

  // ============================================
  // Background Hands-Free Loop Execution
  // ============================================
  private async runHandsFreeLoop(
    keypair: Keypair,
    cycles: number,
    amount: number,
    pairId: string,
    exchange: string,
    delayMs: number,
    returnAddress?: string
  ): Promise<void> {
    const fetch = (await import('node-fetch')).default;

    // Check starting token balances in session wallet
    let hasUsdc = 0;
    let hasUsdt = 0;
    try {
      const usdcAta = await getAssociatedTokenAddress(new PublicKey(TOKENS.USDC.mint), keypair.publicKey);
      const acc = await getAccount(this.connection, usdcAta);
      hasUsdc = fromRawAmount(acc.amount, 6);
    } catch {}
    try {
      const usdtAta = await getAssociatedTokenAddress(new PublicKey(TOKENS.USDT.mint), keypair.publicKey);
      const acc = await getAccount(this.connection, usdtAta);
      hasUsdt = fromRawAmount(acc.amount, 6);
    } catch {}

    let firstToken = TOKENS.USDT;
    let secondToken = TOKENS.USDC;
    if (hasUsdc >= amount && hasUsdt < amount) {
      firstToken = TOKENS.USDC;
      secondToken = TOKENS.USDT;
    }

    logger.info(`🚀 Starting Hands-Free Auto-Cycle: ${cycles} cycles (${cycles * 2} swaps) on ${pairId} via ${exchange.toUpperCase()}`);
    logger.info(`Initial session balance: ${hasUsdt.toFixed(2)} USDT, ${hasUsdc.toFixed(2)} USDC. Starting with ${firstToken.symbol} → ${secondToken.symbol}`);

    let currentInputToken = firstToken;
    let currentOutputToken = secondToken;
    let currentAmount = amount;

    for (let cycle = 1; cycle <= cycles; cycle++) {
      if (this.stopAutoCycleRequested) break;

      // Swap 1: firstToken -> secondToken
      logger.info(`[Cycle ${cycle}/${cycles}] Step 1: Swapping $${currentAmount.toFixed(4)} ${currentInputToken.symbol} → ${currentOutputToken.symbol} on ${exchange.toUpperCase()}...`);
      const res1 = await this.executeSingleDirectSwap(
        keypair,
        currentInputToken.mint,
        currentOutputToken.mint,
        currentAmount,
        currentInputToken.symbol,
        currentOutputToken.symbol,
        exchange,
        fetch
      );

      if (!res1.success) {
        logger.error(`Cycle ${cycle} Step 1 failed: ${res1.error}`);
        if (this.activeAutoCycle) {
          this.activeAutoCycle.status = 'error';
          this.activeAutoCycle.lastError = res1.error;
        }
        break;
      }

      if (this.activeAutoCycle) {
        this.activeAutoCycle.completedSwaps++;
      }

      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      if (this.stopAutoCycleRequested) break;

      // Swap 2 (Instant Swap Back): secondToken -> firstToken
      const returnAmount = res1.outputAmount || currentAmount;
      logger.info(`[Cycle ${cycle}/${cycles}] Step 2 (Instant Swap Back): Swapping $${returnAmount.toFixed(4)} ${currentOutputToken.symbol} → ${currentInputToken.symbol} on ${exchange.toUpperCase()}...`);
      const res2 = await this.executeSingleDirectSwap(
        keypair,
        currentOutputToken.mint,
        currentInputToken.mint,
        returnAmount,
        currentOutputToken.symbol,
        currentInputToken.symbol,
        exchange,
        fetch
      );

      if (!res2.success) {
        logger.error(`Cycle ${cycle} Step 2 failed: ${res2.error}`);
        if (this.activeAutoCycle) {
          this.activeAutoCycle.status = 'error';
          this.activeAutoCycle.lastError = res2.error;
        }
        break;
      }

      if (this.activeAutoCycle) {
        this.activeAutoCycle.completedSwaps++;
        this.activeAutoCycle.completedCycles = cycle;
      }

      currentAmount = res2.outputAmount || currentAmount;
      logger.success(`✅ Cycle ${cycle}/${cycles} completed! Swap & Swap-back success on ${exchange.toUpperCase()}.`);

      if (delayMs > 0 && cycle < cycles) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (this.activeAutoCycle && this.activeAutoCycle.status !== 'error') {
      this.activeAutoCycle.status = 'completed';
      logger.success(`🎉 ALL ${cycles} CYCLES COMPLETED HANDS-FREE ON ${exchange.toUpperCase()}!`);
    }

    // Auto-sweep remaining funds back to returnAddress
    if (returnAddress) {
      await this.sweepFunds(keypair, returnAddress);
    }
  }

  // ============================================
  // Sweep funds back to user wallet and reclaim rent
  // ============================================
  private async sweepFunds(keypair: Keypair, destinationAddress: string): Promise<string[]> {
    const results: string[] = [];
    const destination = new PublicKey(destinationAddress);
    logger.info(`Auto-sweeping funds back to ${destinationAddress}...`);

    // 1. Sweep USDC & reclaim ATA rent
    try {
      const usdcMint = new PublicKey(TOKENS.USDC.mint);
      const fromAta = await getAssociatedTokenAddress(usdcMint, keypair.publicKey);
      const toAta = await getAssociatedTokenAddress(usdcMint, destination);
      const acc = await getAccount(this.connection, fromAta);
      if (acc.amount > BigInt(0)) {
        const tx = new Transaction();
        try {
          await getAccount(this.connection, toAta);
        } catch {
          tx.add(createAssociatedTokenAccountInstruction(keypair.publicKey, toAta, destination, usdcMint));
        }
        tx.add(createTransferInstruction(fromAta, toAta, keypair.publicKey, acc.amount));
        tx.add(createCloseAccountInstruction(fromAta, destination, keypair.publicKey));
        const sig = await this.connection.sendTransaction(tx, [keypair]);
        await this.connection.confirmTransaction(sig, 'confirmed');
        results.push(`Transferred ${fromRawAmount(acc.amount, 6)} USDC & reclaimed ATA rent`);
        logger.success(`Swept ${fromRawAmount(acc.amount, 6)} USDC back to user`);
      } else {
        // Just close empty ATA to reclaim rent
        const tx = new Transaction().add(createCloseAccountInstruction(fromAta, destination, keypair.publicKey));
        await this.connection.sendTransaction(tx, [keypair]);
      }
    } catch (e) {
      logger.debug(`USDC sweep note: ${(e as Error).message}`);
    }

    // 2. Sweep USDT & reclaim ATA rent
    try {
      const usdtMint = new PublicKey(TOKENS.USDT.mint);
      const fromAta = await getAssociatedTokenAddress(usdtMint, keypair.publicKey);
      const toAta = await getAssociatedTokenAddress(usdtMint, destination);
      const acc = await getAccount(this.connection, fromAta);
      if (acc.amount > BigInt(0)) {
        const tx = new Transaction();
        try {
          await getAccount(this.connection, toAta);
        } catch {
          tx.add(createAssociatedTokenAccountInstruction(keypair.publicKey, toAta, destination, usdtMint));
        }
        tx.add(createTransferInstruction(fromAta, toAta, keypair.publicKey, acc.amount));
        tx.add(createCloseAccountInstruction(fromAta, destination, keypair.publicKey));
        const sig = await this.connection.sendTransaction(tx, [keypair]);
        await this.connection.confirmTransaction(sig, 'confirmed');
        results.push(`Transferred ${fromRawAmount(acc.amount, 6)} USDT & reclaimed ATA rent`);
        logger.success(`Swept ${fromRawAmount(acc.amount, 6)} USDT back to user`);
      } else {
        // Just close empty ATA to reclaim rent
        const tx = new Transaction().add(createCloseAccountInstruction(fromAta, destination, keypair.publicKey));
        await this.connection.sendTransaction(tx, [keypair]);
      }
    } catch (e) {
      logger.debug(`USDT sweep note: ${(e as Error).message}`);
    }

    // 3. Sweep all remaining SOL
    try {
      const solBalance = await this.connection.getBalance(keypair.publicKey);
      if (solBalance > 10000) {
        const sendAmount = solBalance - 5000;
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: destination,
            lamports: sendAmount,
          })
        );
        const sig = await this.connection.sendTransaction(tx, [keypair]);
        await this.connection.confirmTransaction(sig, 'confirmed');
        results.push(`Transferred ${(sendAmount / 1e9).toFixed(4)} SOL`);
        logger.success(`Swept ${(sendAmount / 1e9).toFixed(4)} SOL back to user`);
      }
    } catch (e) {
      logger.debug(`SOL sweep error: ${(e as Error).message}`);
    }

    return results;
  }

  // ============================================
  // Execute single swap directly with session keypair
  // ============================================
  private async executeSingleDirectSwap(
    keypair: Keypair,
    inputMint: string,
    outputMint: string,
    amount: number,
    inputSymbol: string,
    outputSymbol: string,
    exchange: string,
    fetch: any
  ): Promise<{ success: boolean; signature?: string; outputAmount?: number; error?: string }> {
    try {
      const config = loadConfig();

      // Retrieve the exact token balance in session wallet so we never fail with rounding discrepancies
      let actualAmount = amount;
      let actualRawAmount = toRawAmount(amount, 6);
      try {
        const inputMintPubkey = new PublicKey(inputMint);
        const inputAta = await getAssociatedTokenAddress(inputMintPubkey, keypair.publicKey);
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const acc = await getAccount(this.connection, inputAta);
            if (acc.amount > BigInt(0)) {
              actualRawAmount = acc.amount;
              actualAmount = fromRawAmount(acc.amount, 6);
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 600));
        }
      } catch {}

      // Ensure destination token account exists on-chain before swapping
      try {
        const outMintPubkey = new PublicKey(outputMint);
        const outAta = await getAssociatedTokenAddress(outMintPubkey, keypair.publicKey);
        try {
          await getAccount(this.connection, outAta);
        } catch {
          const createAtaTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              keypair.publicKey,
              outAta,
              keypair.publicKey,
              outMintPubkey
            )
          );
          const sig = await this.connection.sendTransaction(createAtaTx, [keypair]);
          await this.connection.confirmTransaction(sig, 'confirmed');
          logger.info(`Initialized missing destination ATA on-chain for ${outputSymbol}`);
        }
      } catch {}

      if (exchange === 'titan') {
        const apiKey = config.titanAuthToken || 'EUrstrgMVk6zwYf1DLerp09DjhA7VyD5BJGuwBta';
        const titanUrl =
          `https://portal.api.titan.exchange/api/v1/quote/swap?` +
          `inputMint=${inputMint}` +
          `&outputMint=${outputMint}` +
          `&amount=${actualRawAmount.toString()}` +
          `&userPublicKey=${keypair.publicKey.toBase58()}` +
          `&includeAltContents=true` +
          `&slippageBps=30`;

        const titanRes = await fetch(titanUrl, {
          headers: {
            'x-api-key': apiKey,
            Accept: 'application/json',
          },
        });

        if (!titanRes.ok) {
          const errText = await titanRes.text();
          return { success: false, error: `Titan quote error: ${errText}` };
        }

        const titanData = (await titanRes.json()) as any;
        const dart = titanData.quotes?.['Titan-DART'] || (titanData.quotes && Object.values(titanData.quotes)[0]);
        if (!dart || !dart.instructions) {
          return { success: false, error: 'No Titan DART route available' };
        }

        const lookupTableAccounts = (titanData.alts || []).map((alt: any) => new AddressLookupTableAccount({
          key: new PublicKey(alt.p),
          state: {
            deactivationSlot: BigInt('18446744073709551615'),
            lastExtendedSlot: 0,
            lastExtendedSlotStartIndex: 0,
            authority: undefined,
            addresses: alt.a.map((addr: string) => new PublicKey(addr)),
          }
        }));

        // Set safe 400,000 Compute Unit limit (prevents "exceeded CUs meter at BPF instruction")
        const instructions: TransactionInstruction[] = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
        ];

        for (const ix of dart.instructions) {
          if (ix.p === ComputeBudgetProgram.programId.toBase58()) continue;
          instructions.push(new TransactionInstruction({
            programId: new PublicKey(ix.p),
            keys: ix.a.map((acc: any) => ({
              pubkey: new PublicKey(acc.p),
              isSigner: acc.s,
              isWritable: acc.w,
            })),
            data: Buffer.from(ix.d, 'base64'),
          }));
        }

        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

        const messageV0 = new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message(lookupTableAccounts);

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([keypair]);

        const sig = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
          preflightCommitment: 'confirmed',
        });

        await this.connection.confirmTransaction(sig, 'confirmed');

        const expectedOutput = fromRawAmount(BigInt(dart.outAmount || '0'), 6);
        const feeUsd = 0.0001; // Titan zero protocol fees

        // Record trade
        const tradeRecord = {
          id: uuidv4(),
          sessionId: 'hands-free-session',
          pairId: `${inputSymbol}_${outputSymbol}`,
          exchange: 'titan',
          direction: TradeDirection.A_TO_B,
          status: TradeStatus.CONFIRMED,
          inputToken: inputSymbol,
          outputToken: outputSymbol,
          inputAmount: amount,
          expectedOutputAmount: expectedOutput,
          actualOutputAmount: expectedOutput,
          slippageBps: 30,
          actualSlippageBps: ((amount - expectedOutput) / amount) * 10000,
          feePaidUsd: feeUsd,
          pnlUsd: expectedOutput - amount - feeUsd,
          txSignature: sig,
          isDistraction: false,
          createdAt: Date.now(),
          executedAt: Date.now(),
        };

        this.tracker.recordTrade(tradeRecord);

        return {
          success: true,
          signature: sig,
          outputAmount: expectedOutput,
        };
      } else {
        // Jupiter Route
        const quoteUrl =
          `https://api.jup.ag/swap/v1/quote?` +
          `inputMint=${inputMint}` +
          `&outputMint=${outputMint}` +
          `&amount=${actualRawAmount.toString()}` +
          `&slippageBps=30` +
          `&swapMode=ExactIn&onlyDirectRoutes=true`;

        let quoteRes = await fetch(quoteUrl);
        if (!quoteRes.ok) {
          quoteRes = await fetch(
            `https://api.jup.ag/swap/v1/quote?` +
            `inputMint=${inputMint}` +
            `&outputMint=${outputMint}` +
            `&amount=${actualRawAmount.toString()}` +
            `&slippageBps=30` +
            `&swapMode=ExactIn`
          );
        }

        if (!quoteRes.ok) {
          const text = await quoteRes.text();
          return { success: false, error: `Quote failed: ${text}` };
        }

        const quoteData = await quoteRes.json();
        const expectedOutput = fromRawAmount(BigInt(quoteData.outAmount), 6);

        const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteResponse: quoteData,
            userPublicKey: keypair.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 5000,
          }),
        });

        if (!swapRes.ok) {
          const text = await swapRes.text();
          return { success: false, error: `Swap transaction failed: ${text}` };
        }

        const swapData = await swapRes.json();
        const txBuffer = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(txBuffer);

        transaction.sign([keypair]);

        const sig = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 2,
          preflightCommitment: 'confirmed',
        });

        await this.connection.confirmTransaction(sig, 'confirmed');

        const tradeRecord = {
          id: uuidv4(),
          sessionId: 'hands-free-session',
          pairId: `${inputSymbol}_${outputSymbol}`,
          exchange: 'jupiter',
          direction: TradeDirection.A_TO_B,
          status: TradeStatus.CONFIRMED,
          inputToken: inputSymbol,
          outputToken: outputSymbol,
          inputAmount: amount,
          expectedOutputAmount: expectedOutput,
          actualOutputAmount: expectedOutput,
          slippageBps: 30,
          actualSlippageBps: ((amount - expectedOutput) / amount) * 10000,
          feePaidUsd: 0.0003,
          pnlUsd: expectedOutput - amount - 0.0003,
          txSignature: sig,
          isDistraction: false,
          createdAt: Date.now(),
          executedAt: Date.now(),
        };

        this.tracker.recordTrade(tradeRecord);

        return {
          success: true,
          signature: sig,
          outputAmount: expectedOutput,
        };
      }
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
      };
    }
  }

  private async buildJupiterSwap(quoteResponse: any, userPublicKey: string, priorityFeeLamports: number, amount: number, outputDecimals: number, res: express.Response) {
    const fetch = (await import('node-fetch')).default;
    const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priorityFeeLamports || 5000,
      }),
    });

    if (!swapRes.ok) {
      const errorText = await swapRes.text();
      return res.status(400).json({ error: `Jupiter Swap build failed: ${errorText}` });
    }

    const swapData = await swapRes.json();
    const expectedOutput = fromRawAmount(BigInt(quoteResponse.outAmount), outputDecimals);

    return res.json({
      swapTransaction: swapData.swapTransaction,
      inputAmount: amount,
      expectedOutput,
      priceImpactPct: parseFloat(quoteResponse.priceImpactPct || '0'),
      routePlan: quoteResponse.routePlan,
      exchange: 'jupiter',
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        logger.success(`🚀 Live Dashboard active at: http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
    }
  }
}
