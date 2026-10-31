// ============================================
// FarmVolume — Titan Exchange Adapter
// ============================================
//
// Titan Exchange is a Solana meta-DEX aggregator using
// WebSocket-based quote streaming via their SDK.
// Docs: https://titan-exchange.gitbook.io/titan/
// SDK: @titanexchange/sdk-ts
// ============================================

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { Token, SwapQuote, SwapResult, ExchangeId } from '../types';
import { BaseExchangeAdapter } from './base';
import { logger } from '../utils/logger';
import { toRawAmount, fromRawAmount } from '../utils/tokens';
import { retry, sleep } from '../utils/helpers';

interface TitanConfig {
  apiEndpoint: string;
  authToken: string;
  rpcUrl: string;
  wallet: Keypair;
}

/**
 * Titan Exchange adapter using their WebSocket SDK.
 *
 * Titan provides zero platform fees and uses the Argos routing
 * algorithm for optimal trade execution on Solana.
 *
 * NOTE: This adapter uses the Titan REST/quote API approach as a
 * fallback when the WebSocket SDK is not available. For production,
 * install @titanexchange/sdk-ts and use the V1Client for
 * live quote streaming.
 */
export class TitanExchangeAdapter extends BaseExchangeAdapter {
  readonly id: ExchangeId = 'titan';
  readonly name = 'Titan Exchange';

  private config: TitanConfig;
  private connection: Connection;
  private titanClient: any = null; // V1Client from @titanexchange/sdk-ts

  constructor(config: TitanConfig) {
    super();
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
  }

  async connect(): Promise<void> {
    try {
      // Try to use the official Titan SDK
      try {
        // @ts-ignore
        const titanSdk = await import('@titanexchange/sdk-ts');
        const url = `${this.config.apiEndpoint}?auth=${this.config.authToken}`;
        this.titanClient = await titanSdk.V1Client.connect(url);
        logger.info('Connected via Titan SDK (WebSocket)');
      } catch (sdkError) {
        // SDK not installed — use REST API fallback
        logger.warn('Titan SDK not installed, using REST API fallback');
        logger.info('Install SDK for better performance: npm install @titanexchange/sdk-ts');
        this.titanClient = null;
      }

      // Verify RPC connection
      const blockHeight = await this.connection.getBlockHeight();
      logger.debug(`Solana block height: ${blockHeight}`);

      this.logConnected();
    } catch (error) {
      logger.error(`Failed to connect to Titan: ${(error as Error).message}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.titanClient) {
        await this.titanClient.close();
        this.titanClient = null;
      }
      this.logDisconnected();
    } catch (error) {
      logger.error(`Error disconnecting from Titan: ${(error as Error).message}`);
    }
  }

  async getQuote(
    inputToken: Token,
    outputToken: Token,
    inputAmount: number,
    slippageBps: number
  ): Promise<SwapQuote> {
    const rawAmount = toRawAmount(inputAmount, inputToken.decimals);

    if (this.titanClient) {
      return this.getQuoteViaSDK(inputToken, outputToken, inputAmount, rawAmount, slippageBps);
    }

    return this.getQuoteViaREST(inputToken, outputToken, inputAmount, rawAmount, slippageBps);
  }

  /**
   * Get quote via Titan WebSocket SDK (preferred)
   */
  private async getQuoteViaSDK(
    inputToken: Token,
    outputToken: Token,
    inputAmount: number,
    rawAmount: bigint,
    slippageBps: number
  ): Promise<SwapQuote> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Quote timeout')), 10000);

      try {
        // Use the SDK's streaming quote
        const stream = this.titanClient.swap_stream({
          input_mint: inputToken.mint,
          output_mint: outputToken.mint,
          amount: rawAmount.toString(),
          slippage_bps: slippageBps,
          swap_mode: 'ExactIn',
          wallet: this.config.wallet.publicKey.toBase58(),
        });

        // Get the first quote from the stream
        const onQuote = async () => {
          try {
            for await (const result of stream) {
              clearTimeout(timeout);

              const outputAmount = fromRawAmount(
                BigInt(result.out_amount || result.expected_output || '0'),
                outputToken.decimals
              );
              const minOutput = fromRawAmount(
                BigInt(result.min_out_amount || result.minimum_output || '0'),
                outputToken.decimals
              );

              // Cancel the stream after getting the first quote
              if (stream.cancel) stream.cancel();

              resolve({
                exchange: this.id,
                inputToken,
                outputToken,
                inputAmount,
                expectedOutputAmount: outputAmount,
                minimumOutputAmount: minOutput,
                priceImpactPercent: result.price_impact_pct
                  ? parseFloat(result.price_impact_pct)
                  : 0,
                estimatedFeeLamports: result.fee_amount ? parseInt(result.fee_amount) : 5000,
                estimatedFeeUsd: 0.001, // Titan has zero platform fees
                route: result.route_plan
                  ? JSON.stringify(result.route_plan)
                  : 'Argos optimized',
                rawTransaction: result.transaction || result.swap_transaction,
                quotedAt: Date.now(),
                expiresAt: Date.now() + 30000, // 30s expiry
              });
              return;
            }
          } catch (err) {
            clearTimeout(timeout);
            reject(err);
          }
        };

        onQuote();
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  /**
   * Get quote via Titan REST API (fallback)
   */
  private async getQuoteViaREST(
    inputToken: Token,
    outputToken: Token,
    inputAmount: number,
    rawAmount: bigint,
    slippageBps: number
  ): Promise<SwapQuote> {
    const fetch = (await import('node-fetch')).default;

    // Titan REST API endpoint for quotes
    const baseUrl = this.config.apiEndpoint
      .replace('wss://', 'https://')
      .replace('/ws', '');

    const quoteUrl = `${baseUrl}/quote?` +
      `inputMint=${inputToken.mint}` +
      `&outputMint=${outputToken.mint}` +
      `&amount=${rawAmount.toString()}` +
      `&slippageBps=${slippageBps}` +
      `&swapMode=ExactIn`;

    const response = await retry(async () => {
      const res = await fetch(quoteUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.authToken}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        throw new Error(`Titan API error: ${res.status} ${res.statusText}`);
      }
      return res.json() as Promise<any>;
    }, 2);

    const outputAmount = fromRawAmount(
      BigInt(response.outAmount || response.expectedOutput || '0'),
      outputToken.decimals
    );
    const minOutput = fromRawAmount(
      BigInt(response.otherAmountThreshold || response.minOutAmount || '0'),
      outputToken.decimals
    );

    // Now get the swap transaction
    let rawTransaction: any = null;
    try {
      const swapUrl = `${baseUrl}/swap`;
      const swapRes = await fetch(swapUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse: response,
          userPublicKey: this.config.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicSlippage: { maxBps: slippageBps },
        }),
      });
      if (swapRes.ok) {
        const swapData = await swapRes.json() as any;
        rawTransaction = swapData.swapTransaction;
      }
    } catch (err) {
      logger.debug(`Could not pre-fetch swap tx: ${(err as Error).message}`);
    }

    return {
      exchange: this.id,
      inputToken,
      outputToken,
      inputAmount,
      expectedOutputAmount: outputAmount,
      minimumOutputAmount: minOutput,
      priceImpactPercent: parseFloat(response.priceImpactPct || '0'),
      estimatedFeeLamports: 5000,
      estimatedFeeUsd: 0.001,
      route: response.routePlan
        ? `${response.routePlan.length} hops via Argos`
        : 'Argos optimized',
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
      if (!quote.rawTransaction) {
        throw new Error('No transaction data in quote — cannot execute');
      }

      // Deserialize the transaction
      const txBuffer = Buffer.from(quote.rawTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuffer);

      // Sign with our wallet
      transaction.sign([this.config.wallet]);

      // Send and confirm
      const signature = await retry(async () => {
        const sig = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 2,
          preflightCommitment: 'confirmed',
        });

        // Wait for confirmation
        const confirmation = await this.connection.confirmTransaction(sig, 'confirmed');
        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return sig;
      }, 2);

      logger.success(
        `Swap executed: ${quote.inputAmount} ${quote.inputToken.symbol} → ${quote.expectedOutputAmount} ${quote.outputToken.symbol}`
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
      logger.error(`Swap failed: ${errMsg}`);
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
        // Native SOL
        const balance = await this.connection.getBalance(this.config.wallet.publicKey);
        return fromRawAmount(BigInt(balance), 9);
      }

      // SPL Token
      const { getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token');
      const { PublicKey } = await import('@solana/web3.js');

      const tokenMint = new PublicKey(token.mint);
      const ata = await getAssociatedTokenAddress(tokenMint, this.config.wallet.publicKey);

      try {
        const account = await getAccount(this.connection, ata);
        return fromRawAmount(account.amount, token.decimals);
      } catch {
        // Token account doesn't exist — balance is 0
        return 0;
      }
    } catch (error) {
      logger.error(`Failed to get balance for ${token.symbol}: ${(error as Error).message}`);
      return 0;
    }
  }
}
