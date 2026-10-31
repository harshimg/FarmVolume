// ============================================
// FarmVolume — Base Exchange Adapter
// ============================================

import { Token, SwapQuote, SwapResult, IExchangeAdapter, ExchangeId } from '../types';
import { logger } from '../utils/logger';

/**
 * Abstract base class for all exchange adapters.
 * Provides common functionality and enforces the adapter interface.
 */
export abstract class BaseExchangeAdapter implements IExchangeAdapter {
  abstract readonly id: ExchangeId;
  abstract readonly name: string;

  protected connected: boolean = false;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract getQuote(
    inputToken: Token,
    outputToken: Token,
    inputAmount: number,
    slippageBps: number
  ): Promise<SwapQuote>;
  abstract executeSwap(quote: SwapQuote): Promise<SwapResult>;
  abstract getBalance(token: Token): Promise<number>;

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Validate a quote before execution
   */
  protected validateQuote(quote: SwapQuote): boolean {
    // Check quote is not expired
    if (quote.expiresAt && Date.now() > quote.expiresAt) {
      logger.warn(`Quote expired for ${quote.inputToken.symbol} → ${quote.outputToken.symbol}`);
      return false;
    }

    // Check for reasonable price impact
    if (quote.priceImpactPercent > 5) {
      logger.warn(
        `High price impact: ${quote.priceImpactPercent.toFixed(2)}% for ${quote.inputToken.symbol} → ${quote.outputToken.symbol}`
      );
      return false;
    }

    // Check output is positive
    if (quote.expectedOutputAmount <= 0) {
      logger.warn(`Invalid output amount: ${quote.expectedOutputAmount}`);
      return false;
    }

    return true;
  }

  /**
   * Log a successful connection
   */
  protected logConnected(): void {
    logger.success(`Connected to ${this.name}`);
    this.connected = true;
  }

  /**
   * Log disconnection
   */
  protected logDisconnected(): void {
    logger.info(`Disconnected from ${this.name}`);
    this.connected = false;
  }
}
