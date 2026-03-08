#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║     MINEBEAN — SNIPER SEPI STRATEGY v4                      ║
 * ║                                                             ║
 * ║  Strategy utama:                                            ║
 * ║  1. TUNGGU dulu 20 detik per round                          ║
 * ║  2. FILTER — skip round whale (pool > 0.05 ETH)             ║
 * ║  3. FILTER — skip jika share < 5% per block                 ║
 * ║  4. AI pilih 3 block terbaik dari round yang lolos filter   ║
 * ║  5. Deploy TERLAMBAT (detik ke-40) bukan awal round         ║
 * ║                                                             ║
 * ║  Goal: dapat share besar per win → BEAN lebih banyak        ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const { ethers }              = require('ethers');
const EventSource             = require('eventsource');
const http                    = require('http');
const { AIAnalyzer }          = require('./src/aiAnalyzer');
const { HybridStrategy, MODES } = require('./src/hybridStrategy');
const { RoundFilter }         = require('./src/roundFilter');

// ── Config ────────────────────────────────────────────────────
const CONFIG = {
  PRIVATE_KEY:     process.env.PRIVATE_KEY     || '',
  AGENT_ADDRESS:   process.env.AGENT_ADDRESS   || '',

  ETH_PER_ROUND:   process.env.ETH_PER_ROUND   || '0.001',   // per BLOCK

  AI_CACHE_ROUNDS: parseInt(process.env.AI_CACHE_ROUNDS) || 10,
  AI_MODEL:        process.env.AI_MODEL        || 'claude-opus-4-6',

  // Round filter
  MAX_POOL_ETH:       process.env.MAX_POOL_ETH       || '0.05',
  MAX_BLOCK_ETH:      process.env.MAX_BLOCK_ETH      || '0.005',
  MIN_SHARE_PCT:      process.env.MIN_SHARE_PCT       || '5',
  WAIT_SECONDS:       process.env.WAIT_SECONDS        || '20',
  FORCE_PLAY_BEANPOT: process.env.FORCE_PLAY_BEANPOT  || '200',

  // Hybrid thresholds
  SNIPER_BEANPOT_MIN:    process.env.SNIPER_BEANPOT_MIN    || '50',
  STEALTH_CROWD_ETH:     process.env.STEALTH_CROWD_ETH     || '0.03',
  ACCUMULATE_BEAN_PRICE: process.env.ACCUMULATE_BEAN_PRICE || '0.00005',

  // Claim & stake
  CLAIM_ETH_MIN:   process.env.CLAIM_ETH_MIN   || '0.001',
  CLAIM_BEAN_MIN:  process.env.CLAIM_BEAN_MIN  || '1',
  AUTO_STAKE:      process.env.AUTO_STAKE === 'true',
  STAKE_MIN_BEAN:  process.env.STAKE_MIN_BEAN  || '5',

  BASE_RPC_URL:    process.env.BASE_RPC_URL    || 'https://mainnet.base.org',
  PORT:            parseInt(process.env.PORT)  || 3001,
};

const CONTRACTS = {
  GridMining: '0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0',
  Bean:       '0x5c72992b83E74c4D5200A8E8920fB946214a5A5D',
  Staking:    '0xfe177128Df8d336cAf99F787b72183D1E68Ff9c2',
};

const ABI_GRID    = ['function deploy(uint8[] calldata blockIds) payable','function claimETH()','function claimBEAN()'];
const ABI_BEAN    = ['function approve(address,uint256) returns (bool)','function balanceOf(address) view returns (uint256)'];
const ABI_STAKING = ['function deposit(uint256)','function compound()','function getStakeInfo(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool)','function getPendingRewards(address) view returns (uint256)'];

const API = 'https://api.minebean.com';

// ── Logger ────────────────────────────────────────────────────
const C = {gold:'\x1b[33m',green:'\x1b[32m',red:'\x1b[31m',cyan:'\x1b[36m',gray:'\x1b[90m',purple:'\x1b[35m',blue:'\x1b[34m',reset:'\x1b[0m'};
const ts  = () => new Date().toISOString().replace('T',' ').slice(0,19);
const log = {
  info:   m => console.log(`${C.gray}[${ts()}]${C.reset} ${C.gold}[BEAN]${C.reset} ${m}`),
  ai:     m => console.log(`${C.gray}[${ts()}]${C.reset} ${C.purple}[ AI ]${C.reset} ${m}`),
  filter: m => console.log(`${C.gray}[${ts()}]${C.reset} ${C.blue}[FILT]${C.reset} ${m}`),
  win:    m => console.log(`${C.gray}[${ts()}]${C.reset} ${C.green}[WIN ]${C.reset} ${C.green}${m}${C.reset}`),
  act:    m => console.log(`${C.gray}[${ts()}]${C.reset} ${C.cyan}[ACT ]${C.reset} ${m}`),
  skip:   m => console.log(`${C.gray}[${ts()}]${C.reset} ${C.gray}[SKIP] ${m}${C.reset}`),
  err:    m => console.error(`${C.gray}[${ts()}]${C.reset} ${C.red}[ERR ] ${m}${C.reset}`),
  wait:   m => console.log(`${C.gray}[${ts()}]${C.reset} ${C.gray}[WAIT] ${m}${C.reset}`),
};

// ── State ─────────────────────────────────────────────────────
const STATE = {
  currentRound:      null,
  roundEndTime:      null,
  gridBlocks:        Array(25).fill({deployed:'0',deployedFormatted:'0',minerCount:0}),
  beanpotPool:       '0',
  totalDeployed:     '0',
  beanPrice:         {priceNative:'0',priceUsd:'0'},
  deployedThisRound: false,
  pendingDeploy:     null,   // setTimeout handle
  lastAIReco:        null,
  lastDeploy:        null,
  lastFilterResult:  null,
  currentStrategy:   'SNIPER_SEPI',
  lastEV:            null,
  totalWins:         0,
  totalRounds:       0,
  roundsSkipped:     0,
  roundsPlayed:      0,
  totalBeanEarned:   0,
  totalEthWon:       0n,
  totalEthSpent:     0n,
  aiCallCount:       0,
  startTime:         new Date(),
  recentResults:     [],
  pendingETH:        '0',
  pendingBEAN:       '0',
};

// ── Engines ───────────────────────────────────────────────────
const ai     = new AIAnalyzer(CONFIG);
const hybrid = new HybridStrategy(CONFIG);
const filter = new RoundFilter(CONFIG);

// ── API ───────────────────────────────────────────────────────
async function apiFetch(path) {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}
async function fetchRound() {
  const d = await apiFetch(`/api/round/current?user=${CONFIG.AGENT_ADDRESS}`);
  STATE.currentRound  = d.roundId;
  STATE.gridBlocks    = d.blocks || STATE.gridBlocks;
  STATE.beanpotPool   = d.beanpotPoolFormatted  || '0';
  STATE.totalDeployed = d.totalDeployedFormatted || '0';
  STATE.roundEndTime  = d.endTime;
  return d;
}
async function fetchPrice() {
  try { const d = await apiFetch('/api/price'); STATE.beanPrice = d.bean; } catch {}
}
async function fetchRewards() {
  try {
    const d = await apiFetch(`/api/user/${CONFIG.AGENT_ADDRESS}/rewards`);
    STATE.pendingETH  = d.pendingETHFormatted       || '0';
    STATE.pendingBEAN = d.pendingBEAN?.netFormatted || '0';
    return d;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
//  STRATEGY DETECTOR — Sniper Sepi vs Whale Rider
// ─────────────────────────────────────────────────────────────
function detectStrategy() {
  const pool      = parseFloat(STATE.totalDeployed || '0');
  const beanpot   = parseFloat(STATE.beanpotPool   || '0');
  const beanPrice = parseFloat(STATE.beanPrice.priceUsd || '0');

  // Whale Rider: pool besar DAN beanpot bernilai tinggi
  if (pool >= CONFIG.WHALE_THRESHOLD) {
    // Hitung EV: apakah worth main ikut whale?
    const avgBlockEth  = pool / 25;
    const myEth        = avgBlockEth * (CONFIG.WHALE_MATCH_PCT / 100);
    const myShare      = myEth / (avgBlockEth + myEth);
    const beanEV       = myShare * beanPrice;           // BEAN value per win
    const beanpotEV    = (myShare / 777) * beanpot * beanPrice; // jackpot EV
    const ethCost      = myEth * 3;                     // 3 blocks
    const ethCostUsd   = ethCost * (beanPrice > 0 ? 1900 : 1900);
    const totalEV      = (0.12 * beanEV) + beanpotEV;  // 12% win rate × bean value

    STATE.lastEV = { myShare: (myShare*100).toFixed(2), beanEV: beanEV.toFixed(4), totalEV: totalEV.toFixed(4), ethCostUsd: ethCostUsd.toFixed(4) };

    // Force play kalau beanpot besar banget (jackpot worth it)
    if (beanpot >= CONFIG.BEANPOT_FORCE_ETH) {
      return { mode: 'WHALE_RIDER', play: true, reason: `🐋🎯 Whale Rider BEANPOT — jackpot ${beanpot.toFixed(0)} BEAN ($${(beanpot*beanPrice).toFixed(0)}) worth the risk!` };
    }
    // Skip kalau EV negatif dan beanpot kecil
    return { mode: 'WHALE_RIDER', play: false, reason: `🐋 Whale pool ${pool.toFixed(3)} ETH, share ${(myShare*100).toFixed(1)}% — EV terlalu kecil, skip` };
  }

  // Sniper Sepi: pool kecil → filter normal
  return { mode: 'SNIPER_SEPI', play: null, reason: null };
}

// ─────────────────────────────────────────────────────────────
//  CORE DEPLOY LOGIC
// ─────────────────────────────────────────────────────────────
async function tryDeploy(gridContract) {
  if (STATE.deployedThisRound) return;

  // ── Step 0: Deteksi kondisi market ────────────────────────
  const strategyCheck = detectStrategy();
  STATE.currentStrategy = strategyCheck.mode;

  // Whale Rider mode
  if (strategyCheck.mode === 'WHALE_RIDER') {
    STATE.lastFilterResult = { play: strategyCheck.play, reason: strategyCheck.reason };
    log.filter(strategyCheck.reason);
    if (!strategyCheck.play) {
      STATE.roundsSkipped++;
      return;
    }
    // Deploy dengan ETH lebih besar untuk dapat share layak
    const pool        = parseFloat(STATE.totalDeployed || '0');
    const avgBlock    = pool / 25;
    const myEth       = Math.min(avgBlock * (CONFIG.WHALE_MATCH_PCT / 100), parseFloat(CONFIG.ETH_PER_ROUND) * 5).toFixed(6);
    const blocks      = [0, 8, 16]; // spread 3 blocks
    STATE.lastDeploy  = { blocks, ethAmount: myEth, mode: 'WHALE_RIDER' };
    STATE.roundsPlayed++;
    const totalEth    = (parseFloat(myEth) * blocks.length).toFixed(7);
    log.act(`🐋 Whale Rider deploy [${blocks.join(',')}] × ${myEth} = ${totalEth} ETH`);
    try {
      const tx = await gridContract.deploy(blocks, {
        value: ethers.parseEther(totalEth),
        gasLimit: BigInt(150_000),
      });
      await tx.wait();
      STATE.deployedThisRound = true;
      STATE.totalEthSpent += ethers.parseEther(totalEth);
      log.act(`confirmed ✓`);
    } catch (e) {
      if (e.message.includes('AlreadyDeployedThisRound')) STATE.deployedThisRound = true;
      else log.err(`deploy: ${e.message}`);
    }
    return;
  }

  // ── Step 1: AI pilih blocks (Sniper Sepi mode) ────────────
  let aiBlocks = [0, 12, 24];
  try {
    const reco = await ai.recommend({
      numBlocks:   3,
      currentGrid: STATE.gridBlocks,
      beanpotPool: STATE.beanpotPool,
      beanPrice:   STATE.beanPrice,
      roundId:     STATE.currentRound,
    });
    STATE.lastAIReco = reco;
    if (reco.source === 'claude') STATE.aiCallCount++;
    aiBlocks = reco.blocks;
    log.ai(`[${reco.source}/${reco.confidence}] [${aiBlocks.join(',')}] — ${reco.reasoning}`);
  } catch (err) {
    log.err(`AI: ${err.message}`);
  }

  // ── Step 2: Hybrid mode ────────────────────────────────────
  const { mode } = hybrid.decideMode({
    beanpotPool:   STATE.beanpotPool,
    beanPrice:     STATE.beanPrice,
    gridBlocks:    STATE.gridBlocks,
    totalDeployed: STATE.totalDeployed,
  });

  const { blocks, ethAmount } = hybrid.selectBlocks({
    mode, aiBlocks, gridBlocks: STATE.gridBlocks,
  });

  // ── Step 3: ROUND FILTER ───────────────────────────────────
  const ethPerBlock = parseFloat(ethAmount);
  const check = filter.shouldDeploy({
    gridBlocks:    STATE.gridBlocks,
    totalDeployed: STATE.totalDeployed,
    beanpotPool:   STATE.beanpotPool,
    targetBlocks:  blocks,
    ethPerBlock,
  });

  STATE.lastFilterResult = check;
  STATE.lastDeploy = { blocks, ethAmount, mode };

  log.filter(check.reason);

  if (!check.play) {
    STATE.roundsSkipped++;
    log.skip(`Round #${STATE.currentRound} skipped — menunggu round sepi`);
    return;
  }

  // ── Step 4: Deploy ─────────────────────────────────────────
  STATE.roundsPlayed++;
  const totalEth = (ethPerBlock * blocks.length).toFixed(8);

  log.act(`deploy [${blocks.join(',')}] × ${ethAmount} ETH = ${totalEth} ETH total (share ~${check.avgShare||'?'}%)`);

  try {
    const tx = await gridContract.deploy(blocks, {
      value:    ethers.parseEther(totalEth),
      gasLimit: BigInt(80_000 + blocks.length * 25_000),
    });
    log.act(`tx: ${tx.hash}`);
    const receipt = await tx.wait();
    log.act(`confirmed block ${receipt.blockNumber} ✓`);

    STATE.deployedThisRound = true;
    STATE.totalEthSpent += ethers.parseEther(totalEth);

  } catch (err) {
    if (err.message.includes('AlreadyDeployedThisRound')) {
      STATE.deployedThisRound = true;
    } else {
      log.err(`deploy failed: ${err.message}`);
    }
  }
}

// ── TIMED DEPLOY — tunggu WAIT_SECONDS sebelum deploy ─────────
function scheduleDelayedDeploy(gridContract) {
  // Cancel existing timer
  if (STATE.pendingDeploy) {
    clearTimeout(STATE.pendingDeploy);
    STATE.pendingDeploy = null;
  }

  if (STATE.deployedThisRound) return;

  const waitMs = parseInt(CONFIG.WAIT_SECONDS) * 1000;
  log.wait(`Menunggu ${CONFIG.WAIT_SECONDS}s untuk baca grid dulu...`);

  STATE.pendingDeploy = setTimeout(async () => {
    if (!STATE.deployedThisRound) {
      await tryDeploy(gridContract);
    }
  }, waitMs);
}

// ── Claim & stake ─────────────────────────────────────────────
async function maybeClaim(gridC, beanC, stakingC) {
  const r = await fetchRewards();
  if (!r) return;

  if (parseFloat(r.pendingETHFormatted||'0') >= parseFloat(CONFIG.CLAIM_ETH_MIN)) {
    try {
      log.act(`claiming ${r.pendingETHFormatted} ETH`);
      await (await gridC.claimETH({gasLimit:120_000n})).wait();
      STATE.totalEthWon += ethers.parseEther(r.pendingETHFormatted);
      log.win(`ETH claimed ✓`);
    } catch (e) { log.err(`claimETH: ${e.message}`); }
  }

  const beanNet = parseFloat(r.pendingBEAN?.netFormatted||'0');
  if (beanNet >= parseFloat(CONFIG.CLAIM_BEAN_MIN)) {
    try {
      log.act(`claiming ${beanNet.toFixed(4)} BEAN`);
      await (await gridC.claimBEAN({gasLimit:150_000n})).wait();
      STATE.totalBeanEarned += beanNet;
      log.win(`BEAN claimed ✓ (+${beanNet.toFixed(4)} BEAN)`);

      if (CONFIG.AUTO_STAKE) {
        const bal = await beanC.balanceOf(CONFIG.AGENT_ADDRESS);
        const min = ethers.parseEther(CONFIG.STAKE_MIN_BEAN);
        if (bal >= min) {
          await (await beanC.approve(CONTRACTS.Staking, bal, {gasLimit:60_000n})).wait();
          await (await stakingC.deposit(bal, {gasLimit:150_000n})).wait();
          log.win(`staked ${ethers.formatEther(bal)} BEAN ✓`);
        }
      }
    } catch (e) { log.err(`claimBEAN: ${e.message}`); }
  }

  try {
    const info = await stakingC.getStakeInfo(CONFIG.AGENT_ADDRESS);
    if (info[6]) {
      const p = await stakingC.getPendingRewards(CONFIG.AGENT_ADDRESS);
      if (p > 0n) {
        await (await stakingC.compound({gasLimit:120_000n})).wait();
        log.win(`staking yield compounded ✓`);
      }
    }
  } catch {}
}

// ── SSE ───────────────────────────────────────────────────────
function connectSSE(gridC, beanC, stakingC) {
  log.info('connecting SSE...');
  const es = new EventSource(`${API}/api/events/rounds`);
  es.onopen = () => log.info('SSE connected ✓');

  es.onmessage = async (event) => {
    try {
      const { type, data } = JSON.parse(event.data);
      if (type === 'heartbeat') return;

      // Update grid real-time saat ada yang deploy
      if (type === 'deployed') {
        STATE.gridBlocks    = data.blocks;
        STATE.currentRound  = data.roundId;
        STATE.totalDeployed = data.totalDeployedFormatted || STATE.totalDeployed;

        // Jika ada whale masuk dan kita belum deploy → cancel timer, skip round ini
        const newTotal = parseFloat(STATE.totalDeployed);
        if (!STATE.deployedThisRound && newTotal > parseFloat(CONFIG.MAX_POOL_ETH)) {
          if (STATE.pendingDeploy) {
            clearTimeout(STATE.pendingDeploy);
            STATE.pendingDeploy = null;
          }
          STATE.roundsSkipped++;
          log.skip(`🐋 Whale detected mid-round (${newTotal.toFixed(4)} ETH) → cancel deploy`);
        }
      }

      if (type === 'roundTransition') {
        const { settled, newRound } = data;

        // Cancel any pending deploy timer
        if (STATE.pendingDeploy) {
          clearTimeout(STATE.pendingDeploy);
          STATE.pendingDeploy = null;
        }

        STATE.totalRounds++;
        STATE.deployedThisRound = false;

        if (settled) {
          const wb  = settled.winningBlock;
          const won = settled.topMiner?.toLowerCase() === CONFIG.AGENT_ADDRESS.toLowerCase();

          ai.recordResult(wb);
          hybrid.recordResult(won);

          if (won) {
            STATE.totalWins++;
            log.win(`R#${settled.roundId} WON! block ${wb}`);
          } else {
            log.info(`R#${settled.roundId} → block ${wb}`);
          }

          if (settled.beanpotAmount !== '0') {
            log.win(`🫘 BEANPOT ${settled.beanpotAmount} BEAN!`);
          }

          STATE.recentResults.unshift({
            roundId:      settled.roundId,
            winningBlock: wb,
            won,
            played:       STATE.lastDeploy !== null,
            mode:         hybrid.currentMode,
            beanpot:      settled.beanpotAmount !== '0',
          });
          if (STATE.recentResults.length > 30) STATE.recentResults.pop();
        }

        // New round
        STATE.currentRound  = newRound.roundId;
        STATE.beanpotPool   = newRound.beanpotPoolFormatted || '0';
        STATE.totalDeployed = '0';
        STATE.roundEndTime  = newRound.endTime;
        STATE.gridBlocks    = Array(25).fill({deployed:'0',deployedFormatted:'0',minerCount:0});
        STATE.lastDeploy    = null;

        log.info(`─── Round #${newRound.roundId} · beanpot: ${STATE.beanpotPool} BEAN ───`);

        // Periodic tasks
        if (STATE.totalRounds % 5 === 0) {
          await fetchPrice();
          await maybeClaim(gridC, beanC, stakingC);
        }

        // Jadwalkan deploy setelah WAIT_SECONDS
        scheduleDelayedDeploy(gridC);
      }

    } catch (err) {
      log.err(`SSE: ${err.message}`);
    }
  };

  es.onerror = () => {
    log.err('SSE dropped — reconnect 5s...');
    if (STATE.pendingDeploy) { clearTimeout(STATE.pendingDeploy); STATE.pendingDeploy = null; }
    setTimeout(() => connectSSE(gridC, beanC, stakingC), 5000);
    es.close();
  };
}

// ── Health dashboard ──────────────────────────────────────────
function startHealthServer() {
  http.createServer((req, res) => {
    const wins    = STATE.totalWins;
    const rounds  = STATE.totalRounds;
    const played  = STATE.roundsPlayed;
    const skipped = STATE.roundsSkipped;
    const spent   = ethers.formatEther(STATE.totalEthSpent);
    const wonEth  = ethers.formatEther(STATE.totalEthWon);
    const pnl     = (parseFloat(wonEth) - parseFloat(spent)).toFixed(6);
    const uptime  = Math.floor((Date.now() - STATE.startTime) / 60000);
    const winRate = played ? (wins/played*100).toFixed(1) : '0';
    const playRate= rounds ? (played/rounds*100).toFixed(1): '0';
    const reco    = STATE.lastAIReco;
    const heat    = ai.winStats;
    const maxW    = Math.max(...heat, 1);
    const fstat   = filter.getStats();
    const beanVal = (STATE.totalBeanEarned * parseFloat(STATE.beanPrice.priceUsd||'0')).toFixed(2);

    if (req.url === '/health') {
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({status:'ok',uptime}));
    }
    if (req.url === '/status') {
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({
        round:STATE.currentRound, beanpot:STATE.beanpotPool,
        mode:hybrid.currentMode, strategy:STATE.currentStrategy,
        beanPrice:STATE.beanPrice, lastEV:STATE.lastEV,
        wins, rounds, played, skipped, winRate:winRate+'%', playRate:playRate+'%',
        ethSpent:spent, ethWon:wonEth, pnl,
        beanEarned:STATE.totalBeanEarned.toFixed(4), beanValueUsd:beanVal,
        lastFilter:STATE.lastFilterResult,
        filterStats:fstat,
        uptime:uptime+'m',
      },null,2));
    }

    res.writeHead(200,{'Content-Type':'text/html'});
    const statusColor = STATE.pendingDeploy ? '#f59e0b' : STATE.lastFilterResult?.play ? '#10b981' : '#6b7280';
    const statusText  = STATE.pendingDeploy ? 'WAITING' : STATE.lastFilterResult?.play ? 'DEPLOYED' : 'SKIPPED';
    const pnlPositive = parseFloat(pnl) >= 0;
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="8">
<title>MineBean Agent</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#080c10;--surface:#0d1117;--border:#1a2332;--border2:#243040;
  --text:#e2e8f0;--muted:#64748b;--dim:#334155;
  --green:#10b981;--red:#f43f5e;--gold:#f59e0b;--purple:#a78bfa;--blue:#38bdf8;--orange:#fb923c;
  --green-bg:#052e16;--red-bg:#1c0a0f;--gold-bg:#1c1404;--purple-bg:#1a1040;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg);color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:14px;min-height:100vh}
body{max-width:1100px;margin:0 auto;padding:20px 16px 40px}

/* Header */
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.header-left{display:flex;align-items:center;gap:12px}
.logo{width:36px;height:36px;background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.title{font-size:1.1em;font-weight:700;letter-spacing:-.01em}
.subtitle{font-size:.75em;color:var(--muted);margin-top:1px;font-family:'JetBrains Mono',monospace}
.header-right{display:flex;align-items:center;gap:8px}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
.live-text{font-size:.72em;color:var(--muted);font-family:'JetBrains Mono',monospace}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}

/* Status bar */
.statusbar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.status-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;font-size:.72em;font-weight:600;font-family:'JetBrains Mono',monospace;letter-spacing:.03em;border:1px solid}
.pill-wait{background:#1c1404;color:var(--gold);border-color:#3d2c08}
.pill-play{background:var(--green-bg);color:var(--green);border-color:#065f46}
.pill-skip{background:#111827;color:var(--muted);border-color:var(--border2)}
.pill-round{background:var(--surface);color:var(--blue);border-color:var(--border2)}
.pill-bean{background:#0f172a;color:var(--purple);border-color:#312e81}

/* KPI grid */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
@media(max-width:640px){.kpi-grid{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;position:relative;overflow:hidden}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.kpi-green::before{background:linear-gradient(90deg,var(--green),transparent)}
.kpi-red::before{background:linear-gradient(90deg,var(--red),transparent)}
.kpi-gold::before{background:linear-gradient(90deg,var(--gold),transparent)}
.kpi-purple::before{background:linear-gradient(90deg,var(--purple),transparent)}
.kpi-blue::before{background:linear-gradient(90deg,var(--blue),transparent)}
.kpi-label{font-size:.65em;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;font-weight:500}
.kpi-value{font-size:1.5em;font-weight:700;font-family:'JetBrains Mono',monospace;line-height:1;letter-spacing:-.02em}
.kpi-sub{font-size:.68em;color:var(--muted);margin-top:4px;font-family:'JetBrains Mono',monospace}

/* Main grid */
.main-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:700px){.main-grid{grid-template-columns:1fr}}

/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}
.card-title{font-size:.68em;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:6px}
.card-title span{color:var(--border2)}

/* Stats rows */
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:.8em}
.stat-row:last-child{border-bottom:none;padding-bottom:0}
.stat-label{color:var(--muted)}
.stat-value{font-family:'JetBrains Mono',monospace;font-weight:500}
.c-green{color:var(--green)}.c-red{color:var(--red)}.c-gold{color:var(--gold)}.c-purple{color:var(--purple)}.c-blue{color:var(--blue)}.c-orange{color:var(--orange)}.c-muted{color:var(--muted)}

/* 5x5 Grid */
.grid5{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.cell{border-radius:6px;padding:6px 3px;text-align:center;border:1px solid var(--border);background:#0a0f15;transition:border-color .2s;position:relative}
.cell-num{font-size:.6em;color:var(--dim);font-family:'JetBrains Mono',monospace;margin-bottom:2px}
.cell-eth{font-size:.65em;font-family:'JetBrains Mono',monospace;color:var(--muted);min-height:12px}
.cell-wins{font-size:.6em;color:var(--gold-bg);margin-top:1px;font-family:'JetBrains Mono',monospace}
.cell-bar{height:2px;background:var(--border);border-radius:1px;margin-top:3px;overflow:hidden}
.cell-fill{height:100%;border-radius:1px;background:var(--border2);transition:width .3s}
.cell-tag{font-size:.55em;font-weight:700;letter-spacing:.04em;margin-top:2px}
.cell.is-ai{border-color:#7c3aed;background:#0f0a1e}
.cell.is-ai .cell-tag{color:#a78bfa}
.cell.is-target{border-color:#d97706;background:#130f02}
.cell.is-target .cell-tag{color:#f59e0b}
.cell.is-ai.is-target{border-color:#a78bfa;background:#120e20}

/* Recent rounds */
.round-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:.78em}
.round-row:last-child{border-bottom:none;padding-bottom:0}
.r-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.r-dot-play{background:var(--green)}.r-dot-skip{background:var(--dim)}
.r-id{color:var(--muted);font-family:'JetBrains Mono',monospace;min-width:52px;font-size:.9em}
.r-block{color:var(--text);font-family:'JetBrains Mono',monospace}
.r-win{color:var(--green);font-weight:600;margin-left:auto}
.r-lose{color:var(--dim);margin-left:auto}
.r-skip-label{color:var(--dim);font-size:.9em}
.r-bean{color:var(--orange);margin-left:4px}

/* AI box */
.ai-box{background:#0a0814;border:1px solid #2d1b69;border-radius:10px;padding:12px 14px;margin-bottom:12px}
.ai-header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ai-badge{background:#1e1040;color:var(--purple);font-size:.65em;padding:2px 8px;border-radius:4px;font-weight:600;font-family:'JetBrains Mono',monospace}
.ai-conf{font-size:.65em;color:var(--muted)}
.ai-blocks{font-family:'JetBrains Mono',monospace;color:var(--gold);font-size:.9em;font-weight:600;margin-bottom:4px}
.ai-reasoning{font-size:.75em;color:#94a3b8;line-height:1.5}

/* Filter reason */
.filter-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.75em;display:flex;align-items:flex-start;gap:8px}
.filter-icon{flex-shrink:0;margin-top:1px}
.filter-text{color:var(--muted);line-height:1.5;font-family:'JetBrains Mono',monospace}

/* Bottom grid */
.bottom-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
@media(max-width:700px){.bottom-grid{grid-template-columns:1fr}}

/* Footer */
.footer{margin-top:20px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:gap}
.footer-left{font-size:.68em;color:var(--dim);font-family:'JetBrains Mono',monospace}
.footer-links{display:flex;gap:12px}
.footer-links a{font-size:.68em;color:var(--dim);text-decoration:none;font-family:'JetBrains Mono',monospace}
.footer-links a:hover{color:var(--muted)}
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-left">
    <div class="logo">🫘</div>
    <div>
      <div class="title">MineBean Agent</div>
      <div class="subtitle">Sniper Sepi · Base Mainnet · ${CONFIG.AI_MODEL}</div>
    </div>
  </div>
  <div class="header-right">
    <div class="live-dot"></div>
    <div class="live-text">LIVE · refresh 8s</div>
  </div>
</div>

<!-- Status pills -->
<div class="statusbar">
  <span class="status-pill ${STATE.pendingDeploy?'pill-wait':STATE.lastFilterResult?.play?'pill-play':'pill-skip'}">
    ${STATE.pendingDeploy?'⏳ WAITING '+CONFIG.WAIT_SECONDS+'s':STATE.lastFilterResult?.play?'✅ DEPLOYED':'⏭ SKIPPED'}
  </span>
  <span class="status-pill pill-round">Round #${STATE.currentRound||'—'}</span>
  <span class="status-pill pill-bean">🫘 ${parseFloat(STATE.beanpotPool).toFixed(1)} BEAN pot</span>
  <span class="status-pill pill-round" style="color:${STATE.currentStrategy==='WHALE_RIDER'?'#fb923c':'#38bdf8'}">
    ${STATE.currentStrategy==='WHALE_RIDER'?'🐋 WHALE RIDER':'🥷 SNIPER SEPI'}
  </span>
</div>

<!-- KPI row -->
<div class="kpi-grid">
  <div class="kpi kpi-gold">
    <div class="kpi-label">BEAN Earned</div>
    <div class="kpi-value c-gold">${STATE.totalBeanEarned.toFixed(3)}</div>
    <div class="kpi-sub">≈ $${beanVal} · $${STATE.beanPrice.priceUsd||'?'}/BEAN</div>
  </div>
  <div class="kpi ${pnlPositive?'kpi-green':'kpi-red'}">
    <div class="kpi-label">ETH PNL</div>
    <div class="kpi-value ${pnlPositive?'c-green':'c-red'}">${pnlPositive?'+':''}${pnl}</div>
    <div class="kpi-sub">spent ${spent} · won ${wonEth}</div>
  </div>
  <div class="kpi kpi-blue">
    <div class="kpi-label">Win Rate</div>
    <div class="kpi-value c-blue">${winRate}%</div>
    <div class="kpi-sub">${wins} wins of ${played} played</div>
  </div>
  <div class="kpi kpi-purple">
    <div class="kpi-label">Play Rate</div>
    <div class="kpi-value c-purple">${playRate}%</div>
    <div class="kpi-sub">${played} played · ${skipped} skipped</div>
  </div>
</div>

<!-- AI Recommendation -->
${reco?`
<div class="ai-box">
  <div class="ai-header">
    <span class="ai-badge">AI ${reco.source?.toUpperCase()}</span>
    <span class="ai-conf">${reco.confidence?.toUpperCase()} confidence · ${reco.history||'?'} rounds history</span>
  </div>
  <div class="ai-blocks">Blocks [${reco.blocks?.join(', ')}]</div>
  <div class="ai-reasoning">${reco.reasoning||'—'}</div>
</div>`:''}

<!-- Filter reason -->
<div class="filter-box">
  <span class="filter-icon">${STATE.pendingDeploy?'⏳':STATE.lastFilterResult?.play?'✅':'⏭'}</span>
  <span class="filter-text">${STATE.lastFilterResult?.reason||'Menunggu round baru...'}</span>
</div>

<!-- Main grid: heatmap + recent -->
<div class="main-grid">
  <div class="card">
    <div class="card-title">5×5 Grid Heatmap <span>· 🟣 AI pick · 🟡 deployed</span></div>
    <div class="grid5">
      ${Array.from({length:25},(_,i)=>{
        const b    = STATE.gridBlocks[i]||{};
        const dep  = parseFloat(b.deployedFormatted||'0');
        const w    = heat[i]||0;
        const pct  = Math.round(w/maxW*100);
        const isAI = reco?.blocks?.includes(i);
        const isTgt= STATE.lastDeploy?.blocks?.includes(i);
        const fillColor = pct>60?'#d97706':pct>30?'#7c3aed':'#1e3a5f';
        const ethColor  = dep>0?(dep>0.01?'#f43f5e':dep>0.005?'#f59e0b':'#64748b'):'#1e293b';
        return `<div class="cell ${isAI?'is-ai':''} ${isTgt?'is-target':''}">
  <div class="cell-num">#${i}</div>
  <div class="cell-eth" style="color:${ethColor}">${dep>0?dep.toFixed(4):'·'}</div>
  <div class="cell-bar"><div class="cell-fill" style="width:${pct}%;background:${fillColor}"></div></div>
  <div class="cell-tag">${isAI&&isTgt?'AI+D':isAI?'AI':isTgt?'DEP':w>0?w+'w':''}</div>
</div>`;}).join('')}
    </div>
  </div>

  <div class="card">
    <div class="card-title">Recent Rounds</div>
    ${STATE.recentResults.length===0?'<div style="color:var(--muted);font-size:.8em;text-align:center;padding:20px 0">Menunggu round pertama...</div>':''}
    ${STATE.recentResults.slice(0,15).map(r=>`
    <div class="round-row">
      <div class="r-dot ${r.played?'r-dot-play':'r-dot-skip'}"></div>
      <span class="r-id">R#${r.roundId}</span>
      ${r.played
        ? `<span class="r-block">blk <b>${r.winningBlock}</b></span>`
        : `<span class="r-skip-label">skipped</span>`}
      ${r.beanpot?`<span class="r-bean">🫘</span>`:''}
      ${r.won
        ? `<span class="r-win">✓ WIN</span>`
        : r.played?`<span class="r-lose">—</span>`:''}
    </div>`).join('')}
  </div>
</div>

<!-- Bottom 3-col -->
<div class="bottom-grid">
  <div class="card">
    <div class="card-title">Performance</div>
    <div class="stat-row"><span class="stat-label">Total Rounds</span><span class="stat-value">${rounds}</span></div>
    <div class="stat-row"><span class="stat-label">Played</span><span class="stat-value c-green">${played}</span></div>
    <div class="stat-row"><span class="stat-label">Skipped</span><span class="stat-value c-muted">${skipped}</span></div>
    <div class="stat-row"><span class="stat-label">Wins</span><span class="stat-value c-green">${wins}</span></div>
    <div class="stat-row"><span class="stat-label">AI Calls</span><span class="stat-value c-purple">${STATE.aiCallCount}×</span></div>
    <div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">${uptime}m</span></div>
  </div>
  <div class="card">
    <div class="card-title">Financials</div>
    <div class="stat-row"><span class="stat-label">ETH Spent</span><span class="stat-value c-red">−${spent}</span></div>
    <div class="stat-row"><span class="stat-label">ETH Won</span><span class="stat-value c-green">+${wonEth}</span></div>
    <div class="stat-row"><span class="stat-label">ETH PNL</span><span class="stat-value ${pnlPositive?'c-green':'c-red'}">${pnlPositive?'+':''}${pnl}</span></div>
    <div class="stat-row"><span class="stat-label">Pending ETH</span><span class="stat-value c-orange">${STATE.pendingETH}</span></div>
    <div class="stat-row"><span class="stat-label">BEAN Earned</span><span class="stat-value c-gold">${STATE.totalBeanEarned.toFixed(4)}</span></div>
    <div class="stat-row"><span class="stat-label">Pending BEAN</span><span class="stat-value c-orange">${STATE.pendingBEAN}</span></div>
  </div>
  <div class="card">
    <div class="card-title">Filter Config</div>
    <div class="stat-row"><span class="stat-label">Max Pool</span><span class="stat-value">${CONFIG.MAX_POOL_ETH} ETH</span></div>
    <div class="stat-row"><span class="stat-label">Max Block</span><span class="stat-value">${CONFIG.MAX_BLOCK_ETH} ETH</span></div>
    <div class="stat-row"><span class="stat-label">Min Share</span><span class="stat-value">${CONFIG.MIN_SHARE_PCT}%</span></div>
    <div class="stat-row"><span class="stat-label">Wait Time</span><span class="stat-value">${CONFIG.WAIT_SECONDS}s</span></div>
    <div class="stat-row"><span class="stat-label">Force Beanpot</span><span class="stat-value c-gold">${CONFIG.FORCE_PLAY_BEANPOT} BEAN</span></div>
    <div class="stat-row"><span class="stat-label">ETH/Block</span><span class="stat-value">${CONFIG.ETH_PER_ROUND}</span></div>
  </div>
</div>

<!-- Footer -->
<div class="footer">
  <div class="footer-left">wallet ${CONFIG.AGENT_ADDRESS?.slice(0,6)}...${CONFIG.AGENT_ADDRESS?.slice(-4)} · Base Mainnet</div>
  <div class="footer-links">
    <a href="/health">health</a>
    <a href="/status">json</a>
    <a href="https://minebean.com" target="_blank">minebean.com</a>
  </div>
</div>

</body></html>`);
  }).listen(CONFIG.PORT, () => log.info(`dashboard: http://localhost:${CONFIG.PORT}`));
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log.info('');
  log.info('  🫘  MINEBEAN SNIPER SEPI v4');
  log.info('  ════════════════════════════');
  log.info(`  wallet:      ${CONFIG.AGENT_ADDRESS||'(not set)'}`);
  log.info(`  ETH/block:   ${CONFIG.ETH_PER_ROUND}`);
  log.info(`  max pool:    ${CONFIG.MAX_POOL_ETH} ETH (skip whale)`);
  log.info(`  min share:   ${CONFIG.MIN_SHARE_PCT}%`);
  log.info(`  wait:        ${CONFIG.WAIT_SECONDS}s sebelum deploy`);
  log.info(`  AI model:    ${CONFIG.AI_MODEL}`);
  log.info('');

  if (!CONFIG.PRIVATE_KEY)   throw new Error('Missing PRIVATE_KEY');
  if (!CONFIG.AGENT_ADDRESS) throw new Error('Missing AGENT_ADDRESS');

  const provider  = new ethers.JsonRpcProvider(CONFIG.BASE_RPC_URL);
  const wallet    = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
  if (wallet.address.toLowerCase() !== CONFIG.AGENT_ADDRESS.toLowerCase())
    throw new Error('Wallet mismatch');

  const gridC    = new ethers.Contract(CONTRACTS.GridMining, ABI_GRID,    wallet);
  const beanC    = new ethers.Contract(CONTRACTS.Bean,       ABI_BEAN,    wallet);
  const stakingC = new ethers.Contract(CONTRACTS.Staking,    ABI_STAKING, wallet);

  const bal = await provider.getBalance(wallet.address);
  log.info(`balance: ${ethers.formatEther(bal)} ETH`);

  await fetchRound();
  await fetchPrice();
  log.info(`round #${STATE.currentRound} · pool: ${STATE.totalDeployed} ETH · beanpot: ${STATE.beanpotPool} BEAN`);
  log.info(`BEAN: $${STATE.beanPrice.priceUsd||'?'}`);

  await maybeClaim(gridC, beanC, stakingC);
  scheduleDelayedDeploy(gridC);
  connectSSE(gridC, beanC, stakingC);
  startHealthServer();

  log.info('running 24/7 ✓\n');
}

process.on('SIGINT',  () => { log.info('shutdown'); process.exit(0); });
process.on('SIGTERM', () => { log.info('shutdown'); process.exit(0); });
process.on('unhandledRejection', e => log.err(`unhandled: ${e.message}`));
main().catch(e => { log.err(`fatal: ${e.message}`); process.exit(1); });
