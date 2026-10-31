// ============================================
// FarmVolume — Type Definitions
// ============================================

/** Solana token mint address */
export type MintAddress = string;

/** Token information */
export interface Token {
  symbol: string;
  name: string;
  mint: MintAddress;
  decimals: number;
  /** Approximate USD price (updated periodically) */
  priceUsd?: number;
}

/** A trading pair */
export interface TokenPair {
  id: string; // e.g. "USDC_USDT"
  tokenA: Token;
  tokenB: Token;
  /** Is this a stablecoin pair? Used for special optimization */
  isStablePair: boolean;
}

/** Direction of a swap */
export enum TradeDirection {
  A_TO_B = 'A_TO_B',
  B_TO_A = 'B_TO_A',
}

/** Status of a trade */
export enum TradeStatus {
  PENDING = 'PENDING',
  QUOTED = 'QUOTED',
  SUBMITTED = 'SUBMITTED',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED', // Skipped due to risk/slippage
}

/** A quote from an exchange */
export interface SwapQuote {
  exchange: string;
  inputToken: Token;
  outputToken: Token;
  inputAmount: number; // In token decimals (human-readable)
  expectedOutputAmount: number;
  minimumOutputAmount: number;
  priceImpactPercent: number;
  estimatedFeeLamports: number;
  estimatedFeeUsd: number;
  route?: string; // Routing description
  /** Raw transaction data from exchange */
  rawTransaction?: any;
  /** Timestamp when quote was fetched */
  quotedAt: number;
  /** Quote expiry timestamp */
  expiresAt?: number;
}

/** Result of an executed swap */
export interface SwapResult {
  success: boolean;
  txSignature?: string;
  inputAmount: number;
  outputAmount: number;
  feePaid: number; // in USD
  slippageActual: number; // percentage
  executedAt: number;
  error?: string;
  blockTime?: number;
}

/** Complete record of a trade (quote + execution) */
export interface TradeRecord {
  id: string;
  sessionId: string;
  pairId: string;
  exchange: string;
  direction: TradeDirection;
  status: TradeStatus;
  inputToken: string; // symbol
  outputToken: string; // symbol
  inputAmount: number;
  expectedOutputAmount: number;
  actualOutputAmount?: number;
  slippageBps: number;
  actualSlippageBps?: number;
  feePaidUsd: number;
  pnlUsd: number; // profit/loss for this trade
  txSignature?: string;
  error?: string;
  /** Was this a "distraction" trade on a different pair? */
  isDistraction: boolean;
  createdAt: number;
  executedAt?: number;
}

// ============================================
// Configuration Types
// ============================================

/** Human behavior simulation config */
export interface HumanBehaviorConfig {
  enabled: boolean;

  // --- Timing ---
  /** Min delay between trades in seconds */
  minDelaySeconds: number;
  /** Max delay between trades in seconds */
  maxDelaySeconds: number;
  /** Standard deviation factor for Gaussian delay distribution (0-1) */
  delayGaussianFactor: number;

  // --- Session Simulation ---
  /** Min active trading period in minutes */
  sessionActiveMinutesMin: number;
  /** Max active trading period in minutes */
  sessionActiveMinutesMax: number;
  /** Min break between sessions in minutes */
  sessionBreakMinutesMin: number;
  /** Max break between sessions in minutes */
  sessionBreakMinutesMax: number;

  // --- Pair Rotation ---
  /** Switch to distraction pair after N trades (min) */
  pairSwitchAfterTradesMin: number;
  /** Switch to distraction pair after N trades (max) */
  pairSwitchAfterTradesMax: number;
  /** Number of distraction trades to execute (min) */
  distractionTradesMin: number;
  /** Number of distraction trades to execute (max) */
  distractionTradesMax: number;
  /** Available distraction pairs */
  distractionPairs: TokenPair[];

  // --- Trade Size Variation ---
  /** Jitter percentage for trade size (e.g., 0.2 = ±20%) */
  tradeSizeJitterPercent: number;
  /** Probability of using a "round" number (e.g., 10, 25, 50) */
  roundNumberProbability: number;

  // --- Fatigue Simulation ---
  /** Increase delays by this factor as session progresses (1.0 = no fatigue) */
  fatigueFactor: number;
  /** Max fatigue multiplier (caps the slowdown) */
  fatigueMaxMultiplier: number;

  // --- Behavioral Quirks ---
  /** Probability of skipping a trade (human changed mind) */
  skipTradeProbability: number;
  /** Probability of a "micro-pause" (1-3s, like checking something) before confirming */
  microPauseProbability: number;
  /** Micro-pause duration range [min, max] in seconds */
  microPauseDuration: [number, number];

  // --- Time Awareness ---
  /** Peak trading hours (UTC) — trades more frequently */
  peakHoursUtc: [number, number]; // [startHour, endHour]
  /** Multiplier for delay during off-peak hours */
  offPeakDelayMultiplier: number;
  /** Reduce activity on weekends */
  weekendReduction: boolean;
  /** Weekend delay multiplier */
  weekendDelayMultiplier: number;
}

/** Risk management config */
export interface RiskConfig {
  /** Max total loss in USD before stopping */
  maxTotalLossUsd: number;
  /** Max total loss as percentage of allocated funds */
  maxTotalLossPercent: number;
  /** Max loss per individual trade in USD */
  maxPerTradeLossUsd: number;
  /** Max slippage in basis points to accept a quote */
  maxSlippageBps: number;
  /** Max price impact percentage to accept */
  maxPriceImpactPercent: number;
  /** Min wallet balance to maintain (in SOL, for gas) */
  minSolBalance: number;
  /** Daily loss cap in USD */
  dailyLossCapUsd: number;
  /** Cooldown in seconds after a failed trade */
  failedTradeCooldownSeconds: number;
  /** Max consecutive failures before pausing */
  maxConsecutiveFailures: number;
}

/** Trade optimization config */
export interface OptimizerConfig {
  /** Split trades above this USD value into chunks */
  splitThresholdUsd: number;
  /** Max number of chunks to split into */
  maxChunks: number;
  /** Min chunk size in USD */
  minChunkSizeUsd: number;
  /** Delay between chunks in seconds [min, max] */
  chunkDelaySeconds: [number, number];
  /** Use multiple exchanges for best routing */
  crossExchangeRouting: boolean;
  /** Priority fee in lamports (for faster inclusion) */
  priorityFeeLamports: number;
  /** Compute unit limit */
  computeUnitLimit: number;
}

/** Volume engine session config */
export interface SessionConfig {
  id: string;
  /** Primary pair to generate volume on */
  primaryPair: TokenPair;
  /** Exchange to use */
  exchange: string;
  /** Total funds allocated in USD */
  allocatedFundsUsd: number;
  /** Trade size range [min, max] in USD */
  tradeSizeRange: [number, number];
  /** Target total volume in USD (0 = unlimited) */
  targetVolumeUsd: number;
  /** Max session duration in minutes (0 = unlimited) */
  maxDurationMinutes: number;
  /** Max number of swap cycles (0 = unlimited) */
  maxCycles: number;

  humanBehavior: HumanBehaviorConfig;
  risk: RiskConfig;
  optimizer: OptimizerConfig;
}

/** Live session state */
export interface SessionState {
  sessionId: string;
  status: 'idle' | 'running' | 'paused' | 'stopped' | 'error';
  startedAt?: number;
  pausedAt?: number;
  stoppedAt?: number;

  // Counters
  totalSwaps: number;
  totalCycles: number; // A cycle = A→B + B→A
  successfulSwaps: number;
  failedSwaps: number;
  skippedSwaps: number;
  distractionSwaps: number;

  // Financials
  totalVolumeUsd: number;
  totalFeesUsd: number;
  totalPnlUsd: number;
  currentBalanceA: number;
  currentBalanceB: number;

  // Human behavior state
  currentPhase: 'active' | 'break' | 'distraction';
  tradesInCurrentBurst: number;
  tradesUntilPairSwitch: number;
  currentFatigueMultiplier: number;

  // Risk state
  consecutiveFailures: number;
  dailyLossUsd: number;

  /** Last error message */
  lastError?: string;
}

/** Analytics snapshot for dashboard */
export interface AnalyticsSnapshot {
  session: SessionState;
  recentTrades: TradeRecord[];
  hourlyVolume: { hour: string; volume: number }[];
  pnlOverTime: { time: number; pnl: number }[];
  exchangeBreakdown: { exchange: string; volume: number; fees: number }[];
  avgSlippageBps: number;
  avgFeePerTrade: number;
  volumePerHour: number;
  estimatedTimeToTarget: number | null; // seconds
}

/** Supported exchange identifiers */
export type ExchangeId = 'titan' | 'jupiter';

/** Exchange adapter interface */
export interface IExchangeAdapter {
  readonly id: ExchangeId;
  readonly name: string;

  /** Initialize connection to exchange */
  connect(): Promise<void>;

  /** Disconnect from exchange */
  disconnect(): Promise<void>;

  /** Check if connected */
  isConnected(): boolean;

  /** Get a swap quote */
  getQuote(
    inputToken: Token,
    outputToken: Token,
    inputAmount: number,
    slippageBps: number
  ): Promise<SwapQuote>;

  /** Execute a swap from a quote */
  executeSwap(quote: SwapQuote): Promise<SwapResult>;

  /** Get current token balance */
  getBalance(token: Token): Promise<number>;

  /** Get supported pairs (optional) */
  getSupportedPairs?(): Promise<TokenPair[]>;
}

/** Logger levels */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SUCCESS = 4,
}

/** Dashboard API response wrapper */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}
