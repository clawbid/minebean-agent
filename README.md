# 🫘 MineBean Auto Mining Agent

Agent Node.js yang otomatis bermain [minebean.com](https://minebean.com) setiap round (60 detik) di Base Mainnet.

---

## Cara Kerja

```
Setiap round (60 detik):
  ┌────────────────────────────────────────────────────┐
  │ 1. SSE stream → pantau grid real-time              │
  │    deployed events → update posisi tiap miner      │
  ├────────────────────────────────────────────────────┤
  │ 2. roundTransition event → round baru mulai        │
  ├────────────────────────────────────────────────────┤
  │ 3. Hitung EV                                       │
  │    netEV = BEAN_value + beanpotEV − fees           │
  │    Jika EV < threshold → skip round                │
  ├────────────────────────────────────────────────────┤
  │ 4. Pilih blocks (strategy reactive/random/all)     │
  │    reactive = least crowded blocks (best share)    │
  ├────────────────────────────────────────────────────┤
  │ 5. deploy(blockIds) with ETH on-chain              │
  ├────────────────────────────────────────────────────┤
  │ 6. Setiap 5 round: claim ETH + BEAN rewards        │
  │    Auto-stake BEAN jika AUTO_STAKE=true            │
  └────────────────────────────────────────────────────┘
```

---

## Setup

### 1. Install
```bash
npm install
```

### 2. Konfigurasi
```bash
cp .env.example .env
# Edit .env
```

### 3. Variabel wajib di `.env`

| Variable | Keterangan |
|---|---|
| `PRIVATE_KEY` | Private key wallet kamu |
| `AGENT_ADDRESS` | Address wallet (harus match dengan private key) |
| `ETH_PER_ROUND` | ETH yang di-deploy tiap round (default `0.0001`) |
| `STRATEGY` | `reactive` / `random` / `all` |

### 4. Jalankan
```bash
# Local
npm start

# Production (PM2)
npm install -g pm2
npm run pm2
npm run logs
```

---

## Deploy ke Railway

```bash
git init && git add . && git commit -m "init"
# Push ke GitHub → railway.app → New Project → Deploy from GitHub

# Set di Railway Variables:
PRIVATE_KEY=0x...
AGENT_ADDRESS=0x...
ETH_PER_ROUND=0.0001
STRATEGY=reactive
NUM_BLOCKS=3
```

Buka URL Railway → Live dashboard dengan 5×5 grid + PNL stats.

---

## Strategi

### Reactive (Recommended)
Deploy ke block yang paling sedikit ETH-nya. Jika block itu menang, kamu dapat share lebih besar dari prize pool.

### All Blocks
Deploy ke semua 25 blocks setiap round. Win rate tinggi tapi reward per win kecil. Cocok untuk accumulate BEAN.

### Random
Deploy random. Cocok untuk diversifikasi.

---

## EV Calculation

```
netEV = (1 BEAN × beanPrice) + (1/777 × beanpotPool × beanPrice) − (ethDeployed × 0.11)
```

Agent hanya deploy jika `netEV / ethDeployed ≥ MIN_EV_RATIO` (default 0.8).

Set `MIN_EV_RATIO=0` untuk selalu deploy tanpa cek EV.

---

## Fee Structure (dari minebean.com)

```
Total ETH per round
├── 1% admin fee (dari semua)
├── ~10% vault fee (dari losers saja)  → buyback BEAN
└── Sisa → winners (proporsional)

BEAN: 1.0 ke winners + 0.3 ke beanpot
Beanpot: 1/777 chance jackpot
BEAN claim: 10% fee (roasting) ke holder lain
```

---

## Dashboard

Setelah jalan, buka browser:

- `/`       → Live dashboard HTML (auto-refresh 15s) + 5×5 grid visual
- `/health` → Health check Railway
- `/status` → JSON stats lengkap

---

## Contract Addresses (Base Mainnet)

| Contract | Address |
|---|---|
| GridMining | `0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0` |
| Bean Token | `0x5c72992b83E74c4D5200A8E8920fB946214a5A5D` |
| AutoMiner  | `0x31358496900D600B2f523d6EdC4933E78F72De89` |
| Staking    | `0xfe177128Df8d336cAf99F787b72183D1E68Ff9c2` |
