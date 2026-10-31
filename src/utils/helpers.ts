// ============================================
// FarmVolume — Helper Utilities
// ============================================

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep for a given number of seconds
 */
export function sleepSeconds(seconds: number): Promise<void> {
  return sleep(seconds * 1000);
}

/**
 * Generate a random number between min and max (inclusive)
 */
export function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Generate a random integer between min and max (inclusive)
 */
export function randomIntBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a Gaussian (normal distribution) random number
 * Uses Box-Muller transform
 * @param mean - Center of the distribution
 * @param stdDev - Standard deviation
 */
export function gaussianRandom(mean: number, stdDev: number): number {
  let u1 = Math.random();
  let u2 = Math.random();
  // Avoid log(0)
  while (u1 === 0) u1 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stdDev;
}

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round to a "human-like" number
 * Humans tend to use round numbers like 10, 25, 50, 100
 */
export function humanRoundNumber(value: number): number {
  if (value < 1) return Math.round(value * 100) / 100;
  if (value < 10) return Math.round(value * 2) / 2; // 0.5 increments
  if (value < 50) return Math.round(value); // whole numbers
  if (value < 100) return Math.round(value / 5) * 5; // 5 increments
  if (value < 500) return Math.round(value / 10) * 10; // 10 increments
  if (value < 1000) return Math.round(value / 25) * 25; // 25 increments
  return Math.round(value / 50) * 50; // 50 increments
}

/**
 * Format USD amount for display
 */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Format a large number with commas
 */
export function formatNumber(num: number, decimals: number = 2): string {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format basis points for display
 */
export function formatBps(bps: number): string {
  return `${bps.toFixed(1)} bps`;
}

/**
 * Format duration in seconds to human-readable string
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Calculate percentage change
 */
export function percentChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

/**
 * Retry an async function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        const jitter = delay * 0.1 * Math.random(); // 10% jitter
        await sleep(delay + jitter);
      }
    }
  }
  throw lastError;
}

/**
 * Get current UTC hour (0-23)
 */
export function getCurrentUtcHour(): number {
  return new Date().getUTCHours();
}

/**
 * Check if current time is on a weekend (Saturday or Sunday)
 */
export function isWeekend(): boolean {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Check if current hour is within a range
 */
export function isInHourRange(currentHour: number, start: number, end: number): boolean {
  if (start <= end) {
    return currentHour >= start && currentHour < end;
  }
  // Wraps around midnight
  return currentHour >= start || currentHour < end;
}

/**
 * Generate a unique session ID (short, human-readable)
 */
export function generateSessionId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const segments = [4, 4];
  return segments
    .map((len) =>
      Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    )
    .join('-');
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}
