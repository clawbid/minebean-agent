/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  HYBRID STRATEGY ENGINE                                     ║
 * ║                                                             ║
 * ║  Combines 3 layers:                                         ║
 * ║  Layer 1 — BEAN Accumulator (3 blocks, always deploy)       ║
 * ║  Layer 2 — AI Hunter       (2 blocks, AI picks crowd-free)  ║
 * ║  Layer 3 — Beanpot Sniper  (1 block, activate when big)     ║
 * ║                                                             ║
 * ║  Total: 5–6 blocks → 20–24% win rate                        ║
 * ║  Mode switches automatically based on conditions            ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  MODE LOGIC:
 *
 *  NORMAL mode   (beanpot < threshold):
 *    3 AI blocks + 2 reactive blocks = 5 blocks total
 *    Goal: steady BEAN accumulation + crowd-avoidance ETH edge
 *
 *  SNIPER mode   (beanpot ≥ threshold):
 *    3 AI blocks + 2 reactive + 1 extra sniper = 6 blocks total
 *    Goal: maximize chance of hitting jackpot
 *
 *  STEALTH mode  (round very crowded, total ETH > threshold):
 *    Deploy to 2 emptiest blocks only
 *    Goal: avoid dilution, wait for quieter round
 *
 *  ACCUMULATE mode (BEAN price high, ETH price context):
 *    Deploy all 25 blocks at minimum ETH
 *    Goal: guarantee 1 BEAN per round when BEAN is valuable
 */

const MODES = {
  NORMAL:     'normal',
  SNIPER:     'sniper',
  STEALTH:    'stealth',
  ACCUMULATE: 'accumulate',
};

class HybridStrategy {
  constructor(config) {
    this.config = {
      // Beanpot threshold to activate sniper mode (BEAN)
      SNIPER_BEANPOT_MIN:    parseFloat(config.SNIPER_BEANPOT_MIN    || '50'),
      // If round total ETH > this, switch to stealth (avoid crowded rounds)
      STEALTH_CROWD_ETH:     parseFloat(config.STEALTH_CROWD_ETH     || '0.05'),
      // If BEAN price > this in ETH, switch to accumulate mode
      ACCUMULATE_BEAN_PRICE: parseFloat(config.ACCUMULATE_BEAN_PRICE || '0.00005'),
      // Minimum ETH per block (from minebean contract: 0.0000025)
      MIN_ETH_PER_BLOCK:     '0.000003',
      ...config,
    };

    this.currentMode    = MODES.NORMAL;
    this.modeHistory    = [];
    this.roundsInMode   = 0;
    this.stats = {
      normal:     { rounds: 0, wins: 0 },
      sniper:     { rounds: 0, wins: 0 },
      stealth:    { rounds: 0, wins: 0 },
      accumulate: { rounds: 0, wins: 0 },
    };
  }

  // ── Decide mode for this round ──────────────────────────────
  decideMode({ beanpotPool, beanPrice, gridBlocks, totalDeployed }) {
    const beanpot   = parseFloat(beanpotPool || '0');
    const beanEth   = parseFloat(beanPrice?.priceNative || '0');
    const totalEth  = parseFloat(totalDeployed || '0');

    let mode = MODES.NORMAL;
    let reason = '';

    // Priority 1: ACCUMULATE — BEAN price is high, guarantee 1 BEAN/round
    if (beanEth >= this.config.ACCUMULATE_BEAN_PRICE) {
      mode   = MODES.ACCUMULATE;
      reason = `BEAN price ${beanEth.toFixed(6)} ETH ≥ threshold ${this.config.ACCUMULATE_BEAN_PRICE} → deploy all 25 blocks`;
    }
    // Priority 2: SNIPER — beanpot is large, increase coverage
    else if (beanpot >= this.config.SNIPER_BEANPOT_MIN) {
      mode   = MODES.SNIPER;
      reason = `Beanpot ${beanpot.toFixed(1)} BEAN ≥ ${this.config.SNIPER_BEANPOT_MIN} → add extra block for jackpot coverage`;
    }
    // Priority 3: STEALTH — round too crowded, reduce exposure
    else if (totalEth >= this.config.STEALTH_CROWD_ETH) {
      mode   = MODES.STEALTH;
      reason = `Round crowded: ${totalEth.toFixed(5)} ETH ≥ ${this.config.STEALTH_CROWD_ETH} → deploy only 2 emptiest blocks`;
    }
    // Default: NORMAL
    else {
      mode   = MODES.NORMAL;
      reason = `Normal conditions → 3 AI + 2 reactive blocks`;
    }

    if (mode !== this.currentMode) {
      this.modeHistory.unshift({ from: this.currentMode, to: mode, reason, ts: new Date().toISOString() });
      if (this.modeHistory.length > 20) this.modeHistory.pop();
      this.roundsInMode = 0;
    }

    this.currentMode = mode;
    this.roundsInMode++;
    this.stats[mode].rounds++;

    return { mode, reason };
  }

  // ── Select blocks based on mode ─────────────────────────────
  selectBlocks({ mode, aiBlocks, gridBlocks }) {
    const emptiest = this._getEmptiestBlocks(gridBlocks);

    switch (mode) {

      case MODES.ACCUMULATE: {
        // All 25 blocks at minimum ETH
        return {
          blocks:    Array.from({ length: 25 }, (_, i) => i),
          ethAmount: this.config.MIN_ETH_PER_BLOCK,
          label:     'ALL 25 — accumulate BEAN',
        };
      }

      case MODES.SNIPER: {
        // AI top 3 + 2 reactive + 1 most empty = 6 blocks
        const base    = this._mergeUnique(aiBlocks.slice(0, 3), emptiest.slice(0, 2));
        const sniper  = emptiest.find(b => !base.includes(b)) ?? emptiest[0];
        const blocks  = this._mergeUnique(base, [sniper]).slice(0, 6);
        return {
          blocks,
          ethAmount: this.config.ETH_PER_ROUND,
          label:     '3 AI + 2 reactive + 1 sniper (6 blocks)',
        };
      }

      case MODES.STEALTH: {
        // Only 2 emptiest blocks — minimum exposure
        return {
          blocks:    emptiest.slice(0, 2),
          ethAmount: this.config.ETH_PER_ROUND,
          label:     '2 emptiest blocks — stealth mode',
        };
      }

      case MODES.NORMAL:
      default: {
        // AI top 3 + 2 reactive = 5 blocks
        const blocks = this._mergeUnique(aiBlocks.slice(0, 3), emptiest.slice(0, 2)).slice(0, 5);
        return {
          blocks,
          ethAmount: this.config.ETH_PER_ROUND,
          label:     '3 AI + 2 reactive (5 blocks)',
        };
      }
    }
  }

  // ── Record round result ─────────────────────────────────────
  recordResult(won) {
    if (won) this.stats[this.currentMode].wins++;
  }

  // ── Get emptiest blocks by deployed ETH ────────────────────
  _getEmptiestBlocks(gridBlocks) {
    return [...gridBlocks]
      .map((b, i) => ({ id: i, dep: parseFloat(b.deployedFormatted || '0'), miners: b.minerCount || 0 }))
      .sort((a, b) => a.dep - b.dep || a.miners - b.miners)
      .map(b => b.id);
  }

  // ── Merge two arrays, deduplicated ─────────────────────────
  _mergeUnique(a, b) {
    const result = [...a];
    for (const x of b) if (!result.includes(x)) result.push(x);
    return result;
  }

  // ── Win rate per mode ───────────────────────────────────────
  getModeStats() {
    return Object.entries(this.stats).map(([mode, s]) => ({
      mode,
      rounds:  s.rounds,
      wins:    s.wins,
      winRate: s.rounds ? `${(s.wins / s.rounds * 100).toFixed(1)}%` : '0%',
    }));
  }
}

module.exports = { HybridStrategy, MODES };
