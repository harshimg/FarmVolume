// ============================================
// FarmVolume — Jupiter Aggregator Adapter
// ============================================
//
// Jupiter is the leading Solana DEX aggregator.
// API: https://api.jup.ag/swap/v1
// ============================================

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { Token, SwapQuote, SwapResult, ExchangeId } from '../types';
import { BaseExchangeAdapter } from './base';
import { logger } from '../utils/logger';
import { toRawAmount, fromRawAmount } from '../utils/tokens';
import { retry } from '../utils/helpers';

interface JupiterConfig {
  apiUrl: string;
  rpcUrl: string;
  wallet: Keypair;
}

/**
 * Jupiter Aggregator adapter using their REST API v6.
 *
 * Jupiter aggregates liquidity across all major Solana DEXes
 * (Raydium, Orca, Meteora, Lifinity, etc.) to find the best routes.
 */
export class JupiterExchangeAdapter extends BaseExchangeAdapter {
  readonly id: ExchangeId = 'jupiter';
  readonly name = 'Jupiter Aggregator';

  private config: JupiterConfig;
  private connection: Connection;

  constructor(config: JupiterConfig) {
    super();
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
  }

  async connect(): Promise<void> {
    try {
      // Verify Jupiter API is reachable
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(`${this.config.apiUrl}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50`);

      if (!res.ok) {
        throw new Error(`Jupiter API returned ${res.status}`);
      }

      // Verify RPC connection
      await this.connection.getBlockHeight();

      this.logConnected();
    } catch (error) {
      logger.error(`Failed to connect to Jupiter: ${(error as Error).message}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.logDisconnected();
  }

  async getQuote(
    inputToken: Token,
    outputToken: Token,
    inputAmount: number,
    slippageBps: number
  ): Promise<SwapQuote> {
    const fetch = (await import('node-fetch')).default;
    const rawAmount = toRawAmount(inputAmount, inputToken.decimals);

    // Step 1: Get quote from Jupiter
    const quoteUrl =
      `${this.config.apiUrl}/quote?` +
      `inputMint=${inputToken.mint}` +
      `&outputMint=${outputToken.mint}` +
      `&amount=${rawAmount.toString()}` +
      `&slippageBps=${slippageBps}` +
      `&swapMode=ExactIn` +
      `&onlyDirectRoutes=false` +
      `&asLegacyTransaction=false`;

    const quoteResponse = await retry(async () => {
      const res = await fetch(quoteUrl);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Jupiter quote error: ${res.status} — ${body}`);
      }
      return res.json() as Promise<any>;
    }, 2);

    const outputAmount = fromRawAmount(
      BigInt(quoteResponse.outAmount),
      outputToken.decimals
    );
    const minOutput = fromRawAmount(
      BigInt(quoteResponse.otherAmountThreshold),
      outputToken.decimals
    );

    // Step 2: Get the swap transaction
    let rawTransaction: string | null = null;
    try {
      const swapRes = await fetch(`${this.config.apiUrl}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: this.config.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: { maxBps: slippageBps },
          prioritizationFeeLamports: 'auto',
        }),
      });

      if (swapRes.ok) {
        const swapData = (await swapRes.json()) as any;
        rawTransaction = swapData.swapTransaction;
      }
    } catch (err) {
      logger.debug(`Could not pre-fetch Jupiter swap tx: ${(err as Error).message}`);
    }

    // Calculate fees
    const routePlan = quoteResponse.routePlan || [];
    const totalFees = routePlan.reduce(
      (sum: number, step: any) => sum + (step.swapInfo?.feeAmount ? parseInt(step.swapInfo.feeAmount) : 0),
      0
    );

    return {
      exchange: this.id,
      inputToken,
      outputToken,
      inputAmount,
      expectedOutputAmount: outputAmount,
      minimumOutputAmount: minOutput,
      priceImpactPercent: parseFloat(quoteResponse.priceImpactPct || '0'),
      estimatedFeeLamports: totalFees || 5000,
      estimatedFeeUsd: (totalFees || 5000) * 0.00000015, // Approximate SOL price
      route: routePlan.length > 0
        ? routePlan.map((r: any) => r.swapInfo?.label || 'unknown').join(' → ')
        : 'Jupiter best route',
      rawTransaction,
      quotedAt: Date.now(),
      expiresAt: Date.now() + 30000,
    };
  }

  async executeSwap(quote: SwapQuote): Promise<SwapResult> {
    const startTime = Date.now();

    if (!this.validateQuote(quote)) {
      return {
        success: false,
        inputAmount: quote.inputAmount,
        outputAmount: 0,
        feePaid: 0,
        slippageActual: 0,
        executedAt: startTime,
        error: 'Quote validation failed',
      };
    }

    try {
      let txBase64 = quote.rawTransaction;

      // If we don't have a pre-fetched transaction, get one now
      if (!txBase64) {
        const fetch = (await import('node-fetch')).default;
        const rawAmount = toRawAmount(quote.inputAmount, quote.inputToken.decimals);

        // Re-fetch quote (might have better pricing)
        const quoteUrl =
          `${this.config.apiUrl}/quote?` +
          `inputMint=${quote.inputToken.mint}` +
          `&outputMint=${quote.outputToken.mint}` +
          `&amount=${rawAmount.toString()}` +
          `&slippageBps=50` +
          `&swapMode=ExactIn`;

        const quoteRes = await fetch(quoteUrl);
        const quoteResponse = await quoteRes.json();

        const swapRes = await fetch(`${this.config.apiUrl}/swap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteResponse,
            userPublicKey: this.config.wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            dynamicSlippage: { maxBps: 100 },
            prioritizationFeeLamports: 'auto',
          }),
        });

        if (!swapRes.ok) {
          throw new Error(`Jupiter swap API error: ${swapRes.status}`);
        }

        const swapData = (await swapRes.json()) as any;
        txBase64 = swapData.swapTransaction;
      }

      if (!txBase64) {
        throw new Error('No transaction data available');
      }

      // Deserialize and sign
      const txBuffer = Buffer.from(txBase64, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuffer);
      transaction.sign([this.config.wallet]);

      // Send and confirm
      const signature = await retry(async () => {
        const sig = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 2,
          preflightCommitment: 'confirmed',
        });

        const confirmation = await this.connection.confirmTransaction(sig, 'confirmed');
        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return sig;
      }, 2);

      logger.success(
        `Jupiter swap executed: ${quote.inputAmount} ${quote.inputToken.symbol} → ${quote.expectedOutputAmount} ${quote.outputToken.symbol}`
      );
      logger.debug(`TX: ${signature}`);

      return {
        success: true,
        txSignature: signature,
        inputAmount: quote.inputAmount,
        outputAmount: quote.expectedOutputAmount,
        feePaid: quote.estimatedFeeUsd,
        slippageActual: quote.priceImpactPercent,
        executedAt: Date.now(),
      };
    } catch (error) {
      const errMsg = (error as Error).message;
      logger.error(`Jupiter swap failed: ${errMsg}`);
      return {
        success: false,
        inputAmount: quote.inputAmount,
        outputAmount: 0,
        feePaid: 0,
        slippageActual: 0,
        executedAt: Date.now(),
        error: errMsg,
      };
    }
  }

  async getBalance(token: Token): Promise<number> {
    try {
      if (token.mint === 'So11111111111111111111111111111111111111112') {
        const balance = await this.connection.getBalance(this.config.wallet.publicKey);
        return fromRawAmount(BigInt(balance), 9);
      }

      const { getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token');
      const { PublicKey } = await import('@solana/web3.js');

      const tokenMint = new PublicKey(token.mint);
      const ata = await getAssociatedTokenAddress(tokenMint, this.config.wallet.publicKey);

      try {
        const account = await getAccount(this.connection, ata);
        return fromRawAmount(account.amount, token.decimals);
      } catch {
        return 0;
      }
    } catch (error) {
      logger.error(`Failed to get ${token.symbol} balance: ${(error as Error).message}`);
      return 0;
    }
  }
}
