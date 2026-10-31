// ============================================
// FarmVolume — Logger Utility
// ============================================

import chalk from 'chalk';
import { LogLevel } from '../types';

class Logger {
  private level: LogLevel = LogLevel.INFO;
  private sessionId: string | null = null;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  private getTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }

  private getPrefix(): string {
    const ts = this.getTimestamp();
    const session = this.sessionId ? ` [${this.sessionId.substring(0, 8)}]` : '';
    return `${chalk.gray(ts)}${chalk.cyan(session)}`;
  }

  debug(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.log(`${this.getPrefix()} ${chalk.gray('DEBUG')} ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.INFO) {
      console.log(`${this.getPrefix()} ${chalk.blue('INFO ')} ${message}`, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.WARN) {
      console.log(`${this.getPrefix()} ${chalk.yellow('WARN ')} ${message}`, ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.ERROR) {
      console.log(`${this.getPrefix()} ${chalk.red('ERROR')} ${message}`, ...args);
    }
  }

  success(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.SUCCESS) {
      console.log(`${this.getPrefix()} ${chalk.green('  ✓  ')} ${message}`, ...args);
    }
  }

  trade(direction: string, inputAmount: number, inputSymbol: string, outputAmount: number, outputSymbol: string): void {
    const arrow = chalk.yellow('→');
    console.log(
      `${this.getPrefix()} ${chalk.magenta('TRADE')} ${inputAmount.toFixed(4)} ${inputSymbol} ${arrow} ${outputAmount.toFixed(4)} ${outputSymbol}`
    );
  }

  volume(totalVolume: number, pnl: number, fees: number): void {
    const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
    console.log(
      `${this.getPrefix()} ${chalk.cyan('STATS')} Volume: $${totalVolume.toFixed(2)} | P&L: ${pnlColor('$' + pnl.toFixed(4))} | Fees: ${chalk.yellow('$' + fees.toFixed(4))}`
    );
  }

  humanBehavior(action: string, detail?: string): void {
    const detailStr = detail ? ` ${chalk.gray(`(${detail})`)}` : '';
    console.log(
      `${this.getPrefix()} ${chalk.yellow('HUMAN')} ${action}${detailStr}`
    );
  }

  divider(): void {
    console.log(chalk.gray('─'.repeat(70)));
  }

  banner(): void {
    console.log('');
    console.log(chalk.cyan('  ███████╗ █████╗ ██████╗ ███╗   ███╗██╗   ██╗ ██████╗ ██╗     '));
    console.log(chalk.cyan('  ██╔════╝██╔══██╗██╔══██╗████╗ ████║██║   ██║██╔═══██╗██║     '));
    console.log(chalk.cyan('  █████╗  ███████║██████╔╝██╔████╔██║██║   ██║██║   ██║██║     '));
    console.log(chalk.cyan('  ██╔══╝  ██╔══██║██╔══██╗██║╚██╔╝██║╚██╗ ██╔╝██║   ██║██║     '));
    console.log(chalk.cyan('  ██║     ██║  ██║██║  ██║██║ ╚═╝ ██║ ╚████╔╝ ╚██████╔╝███████╗'));
    console.log(chalk.cyan('  ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═══╝   ╚═════╝ ╚══════╝'));
    console.log('');
    console.log(chalk.gray('  DEX Volume Generation Engine with Human-Like Behavior'));
    console.log(chalk.gray('  ─────────────────────────────────────────────────────'));
    console.log('');
  }
}

export const logger = new Logger();
