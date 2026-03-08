/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  ROUND FILTER — Skip Whale Rounds                           ║
 * ║                                                             ║
 * ║  Hanya deploy jika kondisi round menguntungkan:             ║
 * ║  1. Total ETH di pool masih rendah (round sepi)             ║
 * ║  2. Winning block yang kita pilih tidak terlalu ramai       ║
 * ║  3. Expected BEAN share cukup besar                         ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

class RoundFilter {
  constructor(config) {
    this.config = {
      // Skip jika total pool sudah > ini (ada whale)
      MAX_POOL_ETH:        parseFloat(config.MAX_POOL_ETH        || '0.05'),
      // Skip jika block target sudah > ini ETH (block ramai)
      MAX_BLOCK_ETH:       parseFloat(config.MAX_BLOCK_ETH       || '0.005'),
      // Minimum share kita di block target (%)
      MIN_SHARE_PCT:       parseFloat(config.MIN_SHARE_PCT       || '5'),
      // Deploy amount per block (untuk hitung share)
      ETH_PER_ROUND:       parseFloat(config.ETH_PER_ROUND       || '0.001'),
      // Tunggu N detik sebelum deploy (lihat siapa masuk dulu)
      WAIT_SECONDS:        parseInt(config.WAIT_SECONDS          || '20'),
      // Beanpot besar = selalu main meski ramai
      FORCE_PLAY_BEANPOT:  parseFloat(config.FORCE_PLAY_BEANPOT  || '200'),
    };

    this.stats = {
      roundsSeen:    0,
      roundsPlayed:  0,
      roundsSkipped: 0,
      skipReasons:   { whale: 0, blockBusy: 0, shareTooSmall: 0 },
    };

    this.waitTimer   = null;
    this.roundStart  = null;
  }

  // ── Main check: boleh deploy atau tidak? ───────────────────
  shouldDeploy({ gridBlocks, totalDeployed, beanpotPool, targetBlocks, ethPerBlock }) {
    this.stats.roundsSeen++;

    const totalEth  = parseFloat(totalDeployed || '0');
    const beanpot   = parseFloat(beanpotPool   || '0');

    // FORCE PLAY: beanpot sangat besar → selalu main
    if (beanpot >= this.config.FORCE_PLAY_BEANPOT) {
      this.stats.roundsPlayed++;
      return {
        play:   true,
        reason: `🎯 Force play — beanpot ${beanpot.toFixed(1)} BEAN ≥ ${this.config.FORCE_PLAY_BEANPOT}`,
      };
    }

    // CHECK 1: Total pool terlalu besar (whale masuk)
    if (totalEth > this.config.MAX_POOL_ETH) {
      this.stats.roundsSkipped++;
      this.stats.skipReasons.whale++;
      return {
        play:   false,
        reason: `🐋 Skip — whale detected: pool ${totalEth.toFixed(4)} ETH > max ${this.config.MAX_POOL_ETH} ETH`,
      };
    }

    // CHECK 2: Block target sudah ramai
    const busyBlocks = targetBlocks.filter(blockId => {
      const block   = gridBlocks[blockId] || {};
      const blockEth = parseFloat(block.deployedFormatted || '0');
      return blockEth > this.config.MAX_BLOCK_ETH;
    });

    if (busyBlocks.length > Math.floor(targetBlocks.length / 2)) {
      this.stats.roundsSkipped++;
      this.stats.skipReasons.blockBusy++;
      return {
        play:   false,
        reason: `🚫 Skip — target blocks terlalu ramai: [${busyBlocks.join(',')}] sudah > ${this.config.MAX_BLOCK_ETH} ETH`,
      };
    }

    // CHECK 3: Share terlalu kecil
    const worstBlock = targetBlocks.reduce((worst, blockId) => {
      const block    = gridBlocks[blockId] || {};
      const blockEth = parseFloat(block.deployedFormatted || '0');
      const shareAfterDeploy = ethPerBlock / (blockEth + ethPerBlock) * 100;
      return shareAfterDeploy < worst.share
        ? { id: blockId, share: shareAfterDeploy, blockEth }
        : worst;
    }, { share: 100, id: -1, blockEth: 0 });

    if (worstBlock.share < this.config.MIN_SHARE_PCT) {
      this.stats.roundsSkipped++;
      this.stats.skipReasons.shareTooSmall++;
      return {
        play:   false,
        reason: `📉 Skip — share terlalu kecil: block #${worstBlock.id} hanya ${worstBlock.share.toFixed(1)}% < min ${this.config.MIN_SHARE_PCT}%`,
      };
    }

    // SEMUA CHECK LOLOS — deploy!
    const avgShare = targetBlocks.reduce((sum, blockId) => {
      const block    = gridBlocks[blockId] || {};
      const blockEth = parseFloat(block.deployedFormatted || '0');
      return sum + (ethPerBlock / (blockEth + ethPerBlock) * 100);
    }, 0) / targetBlocks.length;

    this.stats.roundsPlayed++;
    return {
      play:     true,
      avgShare: avgShare.toFixed(1),
      reason:   `✅ Play — pool ${totalEth.toFixed(4)} ETH, avg share ${avgShare.toFixed(1)}%`,
    };
  }

  // ── Timing: kapan dalam round sebaiknya deploy ─────────────
  // Tunggu dulu 20 detik untuk lihat siapa masuk, lalu deploy
  // jika masih sepi. Terlalu awal = orang lain bisa copy block kita.
  // Terlalu telat = tx bisa miss round (Base ~2s block).
  getDeployTiming(roundEndTime) {
    const now        = Date.now() / 1000;
    const timeLeft   = roundEndTime - now;
    const waitUntil  = this.config.WAIT_SECONDS;

    if (timeLeft > waitUntil + 5) {
      // Masih ada waktu, tunggu dulu
      return {
        deployNow: false,
        waitMs:    (timeLeft - waitUntil) * 1000,
        reason:    `Tunggu ${(timeLeft - waitUntil).toFixed(0)}s lagi sebelum deploy`,
      };
    }

    return {
      deployNow: true,
      waitMs:    0,
      reason:    `Deploy sekarang — ${timeLeft.toFixed(0)}s tersisa`,
    };
  }

  getStats() {
    const playRate = this.stats.roundsSeen
      ? (this.stats.roundsPlayed / this.stats.roundsSeen * 100).toFixed(1)
      : '0';
    return {
      ...this.stats,
      playRate: playRate + '%',
    };
  }
}

module.exports = { RoundFilter };
