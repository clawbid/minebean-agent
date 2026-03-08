/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  AI ANALYZER — MineBean Block Intelligence                  ║
 * ║                                                              ║
 * ║  1. Fetch historical round data (100+ rounds)               ║
 * ║  2. Build win frequency + pattern stats per block           ║
 * ║  3. Ask Claude to pick optimal blocks given context         ║
 * ║  4. Cache recommendation, refresh every N rounds            ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * NOTE on VRF fairness:
 * Chainlink VRF is cryptographically uniform — no block has
 * better *true* odds than any other. However, short-term win
 * clusters can appear (gambler's fallacy territory), and the
 * REAL edge is in crowd-avoidance: winning a block with low
 * miner competition gives a bigger reward share.
 * The AI combines both signals.
 */

const API = 'https://api.minebean.com';

class AIAnalyzer {
  constructor(config) {
    this.config          = config;
    this.cache           = null;       // { blocks, reasoning, confidence, builtAt, roundId }
    this.cacheTTL        = config.AI_CACHE_ROUNDS || 10;  // refresh every N rounds
    this.roundsSinceReco = 0;
    this.history         = [];         // local rolling history
    this.winStats        = new Array(25).fill(0);  // win count per block
    this.totalSettled    = 0;
  }

  // ── Feed new round result into local stats ──────────────────
  recordResult(winningBlock) {
    if (winningBlock === null || winningBlock === undefined) return;
    this.winStats[winningBlock]++;
    this.totalSettled++;
    this.roundsSinceReco++;
  }

  // ── Is it time to refresh AI recommendation? ───────────────
  needsRefresh() {
    if (!this.cache) return true;
    if (this.roundsSinceReco >= this.cacheTTL) return true;
    return false;
  }

  // ── Fetch historical rounds from API ───────────────────────
  async fetchHistory(limit = 100) {
    const rounds = [];
    const pages  = Math.ceil(limit / 20);

    for (let page = 1; page <= pages; page++) {
      try {
        const res  = await fetch(`${API}/api/rounds?page=${page}&limit=20&settled=true`);
        const data = await res.json();
        if (data.rounds) rounds.push(...data.rounds);
        if (!data.hasMore) break;
        await sleep(200); // gentle rate limiting
      } catch (err) {
        console.error(`[AI] History fetch page ${page} failed: ${err.message}`);
        break;
      }
    }

    return rounds.slice(0, limit);
  }

  // ── Build block statistics from history ────────────────────
  buildStats(rounds) {
    const stats = Array.from({length: 25}, (_, i) => ({
      blockId:     i,
      wins:        0,
      winRate:     0,
      avgMinerCount:    0,
      avgDeployedOnWin: 0,
      avgRewardOnWin:   0,
      roundsAppeared:   0,
      hotStreak:   0,  // consecutive wins
      lastWonRound: null,
    }));

    let consecutive = {};

    for (const round of rounds) {
      if (!round.settled || round.winningBlock === undefined) continue;
      const wb = round.winningBlock;

      // Win count
      stats[wb].wins++;
      stats[wb].lastWonRound = round.roundId;

      // Streak tracking
      for (let i = 0; i < 25; i++) {
        if (i === wb) {
          consecutive[i] = (consecutive[i] || 0) + 1;
          stats[i].hotStreak = Math.max(stats[i].hotStreak, consecutive[i]);
        } else {
          consecutive[i] = 0;
        }
      }
    }

    // Win rates
    const total = rounds.filter(r => r.settled).length || 1;
    for (const s of stats) {
      s.winRate = (s.wins / total * 100).toFixed(1);
    }

    // Sort by wins desc
    return stats.sort((a, b) => b.wins - a.wins);
  }

  // ── Main: get AI block recommendation ──────────────────────
  async recommend({ numBlocks, currentGrid, beanpotPool, beanPrice, roundId }) {
    if (!this.needsRefresh()) {
      return this.cache;
    }

    console.log('[AI] Fetching 100 rounds of history for analysis...');
    const rounds = await this.fetchHistory(100);

    if (rounds.length < 5) {
      console.log('[AI] Not enough history, falling back to reactive strategy');
      return this._fallback(currentGrid, numBlocks);
    }

    const blockStats  = this.buildStats(rounds);
    const gridCurrent = currentGrid.map((b, i) => ({
      id:       i,
      deployed: parseFloat(b.deployedFormatted || '0'),
      miners:   b.minerCount || 0,
    }));

    // Build prompt payload
    const prompt = buildPrompt({
      blockStats,
      gridCurrent,
      numBlocks,
      beanpotPool,
      beanPrice,
      roundId,
      totalRoundsAnalyzed: rounds.length,
    });

    console.log('[AI] Querying Claude for block recommendation...');
    const aiResponse = await callClaude(prompt);

    if (!aiResponse) {
      console.log('[AI] Claude unavailable, using stats-based fallback');
      return this._statsFallback(blockStats, gridCurrent, numBlocks);
    }

    // Parse AI response
    const parsed = parseAIResponse(aiResponse, numBlocks);
    this.cache = {
      ...parsed,
      builtAt:  new Date().toISOString(),
      roundId,
      history:  rounds.length,
    };
    this.roundsSinceReco = 0;

    console.log(`[AI] Recommendation: blocks [${parsed.blocks.join(', ')}]`);
    console.log(`[AI] Confidence: ${parsed.confidence} | Reasoning: ${parsed.reasoning.slice(0, 120)}...`);

    return this.cache;
  }

  // ── Fallback: pure stats (no Claude) ───────────────────────
  _statsFallback(blockStats, gridCurrent, numBlocks) {
    // Score = winRate × (1 / (currentDeployed + 0.01)) — want high wins + low crowd
    const scored = blockStats.map(s => {
      const grid    = gridCurrent.find(g => g.id === s.blockId) || { deployed: 0 };
      const crowdPenalty = 1 / (grid.deployed + 0.001);
      const score   = parseFloat(s.winRate) * crowdPenalty;
      return { ...s, score, currentDeployed: grid.deployed };
    }).sort((a, b) => b.score - a.score);

    const blocks = scored.slice(0, numBlocks).map(s => s.blockId);

    return {
      blocks,
      reasoning: `Stats-based: top ${numBlocks} blocks by win-rate÷crowd-density score`,
      confidence: 'medium',
      builtAt:    new Date().toISOString(),
      source:     'stats',
    };
  }

  _fallback(currentGrid, numBlocks) {
    const sorted = [...currentGrid]
      .map((b, i) => ({ id: i, deployed: parseFloat(b.deployedFormatted || '0') }))
      .sort((a, b) => a.deployed - b.deployed);
    return {
      blocks:     sorted.slice(0, numBlocks).map(b => b.id),
      reasoning:  'Reactive fallback: least crowded blocks',
      confidence: 'low',
      source:     'reactive',
    };
  }
}

// ─────────────────────────────────────────────────────────────
//  PROMPT BUILDER
// ─────────────────────────────────────────────────────────────
function buildPrompt({ blockStats, gridCurrent, numBlocks, beanpotPool, beanPrice, roundId, totalRoundsAnalyzed }) {
  const topBlocks  = blockStats.slice(0, 10);
  const gridSummary = gridCurrent
    .filter(b => b.deployed > 0)
    .sort((a, b) => a.deployed - b.deployed)
    .map(b => `  Block ${b.id}: ${b.deployed.toFixed(5)} ETH, ${b.miners} miners`)
    .join('\n');

  return `You are an AI agent playing MineBean — a 5×5 grid mining game on Base blockchain.

## Game Rules
- 25 blocks (0–24), Chainlink VRF picks winning block randomly (uniform 1/25 odds)
- You deploy ETH to blocks. If your block wins, you get proportional share of prize pool
- Strategy edge: winning a block with fewer miners/ETH gives you a bigger reward share
- 1 BEAN token reward per round (split or single winner)
- Beanpot jackpot: 1/777 chance per round

## Historical Win Data (last ${totalRoundsAnalyzed} rounds)
Block | Wins | Win Rate | Hot Streak
${topBlocks.map(b => `  ${String(b.blockId).padStart(2)} |  ${String(b.wins).padStart(3)} | ${String(b.winRate).padStart(5)}%  | streak ${b.hotStreak}`).join('\n')}

## Current Grid State (this round so far)
${gridSummary || '  (No deployments yet this round)'}

## Context
- Beanpot pool: ${beanpotPool} BEAN
- BEAN price: $${beanPrice?.priceUsd || 'unknown'}
- Round: #${roundId}

## Your Task
Choose the ${numBlocks} best blocks to deploy to THIS round.

Consider:
1. Historical win frequency (higher = slightly more likely in short runs, though VRF is truly random)
2. Current crowd density (less ETH on a block = bigger share if it wins)
3. Balance between hot historical blocks and uncrowded ones

Respond in this EXACT JSON format (no markdown, no explanation outside JSON):
{
  "blocks": [<block_id>, <block_id>, ...],
  "confidence": "high|medium|low",
  "reasoning": "<one sentence explaining the choice>"
}`;
}

// ─────────────────────────────────────────────────────────────
//  CLAUDE API CALL
// ─────────────────────────────────────────────────────────────
async function callClaude(prompt) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      'claude-opus-4-6',
        max_tokens: 300,
        system:     'You are a precise JSON-only responder. Output only valid JSON, nothing else.',
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error(`[AI] Claude API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.content?.[0]?.text || null;

  } catch (err) {
    console.error(`[AI] Claude fetch failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  RESPONSE PARSER
// ─────────────────────────────────────────────────────────────
function parseAIResponse(text, numBlocks) {
  try {
    const clean  = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Validate blocks array
    let blocks = (parsed.blocks || [])
      .map(b => parseInt(b))
      .filter(b => b >= 0 && b <= 24);

    // Dedupe and trim to numBlocks
    blocks = [...new Set(blocks)].slice(0, numBlocks);

    // Pad with random if AI returned too few
    while (blocks.length < numBlocks) {
      const rand = Math.floor(Math.random() * 25);
      if (!blocks.includes(rand)) blocks.push(rand);
    }

    return {
      blocks,
      confidence: parsed.confidence || 'medium',
      reasoning:  parsed.reasoning  || 'AI recommendation',
      source:     'claude',
    };

  } catch (err) {
    console.error(`[AI] Parse failed: ${err.message} — raw: ${text?.slice(0,100)}`);
    // Return random blocks as last resort
    const blocks = Array.from({length:25},(_,i)=>i)
      .sort(()=>Math.random()-0.5)
      .slice(0, numBlocks);
    return { blocks, confidence: 'low', reasoning: 'Parse error fallback', source: 'fallback' };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { AIAnalyzer };
