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
//  CORE DEPLOY LOGIC
// ─────────────────────────────────────────────────────────────
async function tryDeploy(gridContract) {
  if (STATE.deployedThisRound) return;

  // ── Step 1: AI pilih blocks ────────────────────────────────
  let aiBlocks = [0, 12, 24]; // fallback
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
        mode:hybrid.currentMode, beanPrice:STATE.beanPrice,
        wins, rounds, played, skipped, winRate:winRate+'%', playRate:playRate+'%',
        ethSpent:spent, ethWon:wonEth, pnl,
        beanEarned:STATE.totalBeanEarned.toFixed(4), beanValueUsd:beanVal,
        lastFilter:STATE.lastFilterResult,
        filterStats:fstat,
        uptime:uptime+'m',
      },null,2));
    }

    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(`<!DOCTYPE html>
<html><head><title>🫘 Sniper Sepi</title>
<meta http-equiv="refresh" content="8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#050608;color:#c0b8a8;font-family:'Courier New',monospace;padding:22px;max-width:900px}
h1{color:#f0c040;font-size:1.2em;letter-spacing:.06em;margin-bottom:3px}
.sub{color:#484440;font-size:.68em;margin-bottom:18px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.card{background:#080b12;border:1px solid #0e1520;padding:12px 14px}
.ct{color:#484440;font-size:.62em;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px}
.big{font-size:1.5em;font-weight:bold;line-height:1.1}
.row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #080c12;font-size:.76em}
.lbl{color:#484440}.val{text-align:right}
.g{color:#2aff8a}.a{color:#e07820}.gold{color:#f0c040}.r{color:#ff5555}.pu{color:#c084fc}.bl{color:#60a5fa}
.badge{padding:2px 8px;font-size:.68em;border-radius:2px}
.b-ok{background:#0e1a0e;color:#2aff8a;border:1px solid #1a3a1a}
.b-skip{background:#1a0e0e;color:#ff5555;border:1px solid #3a1a1a}
.b-wait{background:#0e0e1a;color:#60a5fa;border:1px solid #1a1a3a}
.grid5{display:grid;grid-template-columns:repeat(5,1fr);gap:2px}
.cell{padding:5px 2px;text-align:center;font-size:.58em;border:1px solid #0a0d14}
.cell.ai{border-color:#c084fc;background:#0a0814}
.cell.target{border-color:#f0c04066}
.hb{height:2px;margin-top:2px}.hf{height:100%}
.rr{display:flex;gap:8px;padding:3px 0;border-bottom:1px solid #080b12;font-size:.68em;align-items:center}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.dot-played{background:#2aff8a}.dot-skipped{background:#484440}
</style></head><body>

<h1>🫘 MineBean — Sniper Sepi Strategy</h1>
<div class="sub">Tunggu 20s → Filter whale → AI pick sepi block · auto-refresh 8s · <a href="/status" style="color:#2a3040">json</a></div>

<div class="g3">
  <div class="card">
    <div class="ct">Filter Status</div>
    <div class="badge ${STATE.lastFilterResult?.play?'b-ok':STATE.pendingDeploy?'b-wait':'b-skip'}">
      ${STATE.pendingDeploy ? '⏳ WAITING '+CONFIG.WAIT_SECONDS+'s' : STATE.lastFilterResult?.play ? '✅ PLAYED' : '⏭ SKIPPED'}
    </div>
    <div style="font-size:.62em;color:#484440;margin-top:6px">${STATE.lastFilterResult?.reason?.slice(0,60)||'—'}</div>
  </div>
  <div class="card">
    <div class="ct">Round</div>
    <div class="big gold">#${STATE.currentRound||'—'}</div>
    <div style="font-size:.7em;margin-top:4px">Beanpot: <span class="a">${parseFloat(STATE.beanpotPool).toFixed(1)} BEAN</span></div>
    <div style="font-size:.7em">Pool: <span>${STATE.totalDeployed} ETH</span></div>
  </div>
  <div class="card">
    <div class="ct">BEAN Earned</div>
    <div class="big gold">${STATE.totalBeanEarned.toFixed(3)}</div>
    <div style="font-size:.7em;margin-top:4px">≈ <span class="g">$${beanVal}</span> @ $${STATE.beanPrice.priceUsd||'?'}</div>
  </div>
</div>

<div class="g3">
  <div class="card">
    <div class="row"><span class="lbl">Total rounds</span><span class="val">${rounds}</span></div>
    <div class="row"><span class="lbl">Played</span><span class="val g">${played} (${playRate}%)</span></div>
    <div class="row"><span class="lbl">Skipped</span><span class="val" style="color:#484440">${skipped}</span></div>
    <div class="row"><span class="lbl">Wins</span><span class="val g">${wins}</span></div>
    <div class="row"><span class="lbl">Win rate</span><span class="val g">${winRate}%</span></div>
  </div>
  <div class="card">
    <div class="row"><span class="lbl">ETH spent</span><span class="val r">−${spent}</span></div>
    <div class="row"><span class="lbl">ETH won</span><span class="val g">+${wonEth}</span></div>
    <div class="row"><span class="lbl">ETH PNL</span><span class="val ${parseFloat(pnl)>=0?'g':'r'}">${parseFloat(pnl)>=0?'+':''}${pnl}</span></div>
    <div class="row"><span class="lbl">Pending ETH</span><span class="val a">${STATE.pendingETH}</span></div>
    <div class="row"><span class="lbl">Pending BEAN</span><span class="val a">${STATE.pendingBEAN}</span></div>
  </div>
  <div class="card">
    <div class="row"><span class="lbl">AI calls</span><span class="val pu">${STATE.aiCallCount}×</span></div>
    <div class="row"><span class="lbl">Max pool</span><span class="val">${CONFIG.MAX_POOL_ETH} ETH</span></div>
    <div class="row"><span class="lbl">Max block</span><span class="val">${CONFIG.MAX_BLOCK_ETH} ETH</span></div>
    <div class="row"><span class="lbl">Min share</span><span class="val">${CONFIG.MIN_SHARE_PCT}%</span></div>
    <div class="row"><span class="lbl">Wait</span><span class="val">${CONFIG.WAIT_SECONDS}s</span></div>
  </div>
</div>

${reco?`<div class="card" style="margin-bottom:8px;font-size:.76em">
  <span style="color:#c084fc">[AI ${reco.source}/${reco.confidence}]</span>
  <span class="gold"> [${reco.blocks?.join(',')}]</span>
  <span style="color:#c0b8a8"> — ${reco.reasoning}</span>
</div>`:''}

<div class="g2">
  <div class="card">
    <div class="ct">5×5 Heatmap (🟣 AI pick)</div>
    <div class="grid5" style="margin-top:6px">
      ${Array.from({length:25},(_,i)=>{
        const b   = STATE.gridBlocks[i]||{};
        const dep = parseFloat(b.deployedFormatted||'0');
        const w   = heat[i]||0;
        const pct = Math.round(w/maxW*100);
        const isAI = reco?.blocks?.includes(i);
        const isTgt= STATE.lastDeploy?.blocks?.includes(i);
        const hcol = `hsl(38,${15+pct*.4}%,${10+pct*.18}%)`;
        return `<div class="cell ${isAI?'ai':''} ${isTgt?'target':''}">
<div style="color:#484440">#${i}</div>
<div style="color:${dep>0?'#c0b8a8':'#181410'}">${dep>0?dep.toFixed(4):'·'}</div>
<div style="color:#f0c04077">${w>0?w+'w':''}</div>
<div class="hb"><div class="hf" style="width:${pct}%;background:${hcol}"></div></div>
${isAI?'<div style="color:#c084fc;font-size:.9em">AI</div>':''}
</div>`;}).join('')}
    </div>
  </div>

  <div class="card">
    <div class="ct">Recent Rounds</div>
    ${STATE.recentResults.slice(0,15).map(r=>`
    <div class="rr">
      <div class="dot ${r.played?'dot-played':'dot-skipped'}"></div>
      <span style="color:#484440">R#${r.roundId}</span>
      ${r.played?`<span>blk <span class="gold">${r.winningBlock}</span></span>`:'<span style="color:#2a2620">skipped</span>'}
      <span style="color:${r.won?'#2aff8a':'#2a2620'}">${r.won?'✓ WIN':r.played?'—':''}</span>
      ${r.beanpot?'<span class="a">🫘</span>':''}
    </div>`).join('')}
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
