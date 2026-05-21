# Arcana — Adaptive Portfolio Manager

**Arcana** is an autonomous DeFi portfolio manager built on Circle's Arc Testnet. It continuously monitors BTC market conditions using a 3-agent AI council, then autonomously rebalances user funds between Arc Testnet (safe parking) and Base Sepolia yield vaults — without requiring any user action after initial deposit.

Built for [Agora RFB04](https://www.agora.finance/) — Risk-Based Portfolio Management on Arc.

---

## How It Works

```
BTC Market Data → 3-Agent Regime Detection → Risk Decision → Arc ↔ Base Rebalance → LI.FI Vault
```

### 1. Regime Detection (every 15 min)

Three AI agents analyze BTC market signals in sequence:

| Agent | Role |
|-------|------|
| **Architect** | Builds the bull/bear case from funding rate, OI delta, price trend, and signal score |
| **Auditor** | Critiques the Architect's analysis, challenging unsupported assumptions |
| **Arbiter** | Weighs both arguments and outputs a structured JSON regime decision |

Output: `regime` (risk_on / risk_off), `confidence` (0–1), `phase`, `rebalance` flag.

### 2. Risk-Off — Park on Arc Testnet

When the regime flips to `risk_off`:

1. Collect USDC from the agent wallet (Base Sepolia)
2. Deposit to Circle Unified Balance
3. Spend (bridge) → Arc Testnet via Arc App Kit
4. Funds sit on Arc Testnet, protected from market volatility

### 3. Risk-On — Deploy to Yield

When the regime flips to `risk_on`:

1. Retrieve USDC from Arc Testnet → Base Sepolia via Unified Balance spend
2. Query LI.FI Earn API for the highest-APY USDC vault on Base
3. Notify selected vault (dry-run on testnet; real deposit on mainnet)

### Multi-User Support

Each user registers with their EOA wallet. Arcana derives a dedicated **Developer-Controlled Wallet (DCW)** per user via Circle's API, then runs the full rebalance loop across all users in parallel on each regime cycle.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    ui-server.js                     │
│   Express API + SSE broadcast + manual triggers     │
└────────────────────┬────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │      agent.js       │
          │  executeRiskOn/Off  │
          │  multi-user loop    │
          └──────┬──────┬───────┘
                 │      │
        ┌────────▼─┐  ┌─▼────────┐
        │ regime.js│  │  arc.js  │
        │ 3-agent  │  │ App Kit  │
        │ council  │  │ bridge   │
        └────────┬─┘  └─▼────────┘
                 │    Circle Unified Balance
        ┌────────▼──────────────┐
        │      earn.js          │
        │  LI.FI Earn API       │
        │  vault selection      │
        └───────────────────────┘
```

### Key Files

| File | Description |
|------|-------------|
| `ui-server.js` | Express server, SSE live log, REST endpoints, 15-min scheduler |
| `agent.js` | Core rebalance logic: `executeRiskOn`, `executeRiskOff`, multi-user DCW loop |
| `regime.js` | 3-agent market analysis (Architect → Auditor → Arbiter) |
| `arc.js` | Circle Arc App Kit integration: `unifiedDeposit`, `unifiedSpend`, bidirectional bridge |
| `earn.js` | LI.FI Earn API client: vault discovery, APY ranking, pagination |
| `scorer.js` | Signal scoring from funding rate, OI delta, price trend |
| `rebalance.js` | Rebalance decision logic and threshold evaluation |
| `tools.js` | Shared utilities: Hyperliquid data fetch, snapshot management |
| `public/index.html` | Single-file frontend: 2-column dashboard, live SSE log, SVG BTC chart |

### Database Schema

```sql
-- users.db
users          (eoa, wallet_address, wallet_id, created_at)
regime_history (id, regime, confidence, phase, signal_score, btc_price, created_at)
user_positions (id, eoa, type, amount, vault_address, chain, created_at)
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Custody | Circle Developer-Controlled Wallets (DCW) |
| Cross-chain | Circle Arc App Kit — Unified Balance |
| Yield | LI.FI Earn API |
| AI Agents | Google Gemini 2.5 Flash Lite (via OpenRouter) |
| Market Data | Hyperliquid public API |
| Backend | Node.js, Express, better-sqlite3 |
| Frontend | Vanilla JS, SSE, SVG |

---

## Setup

### Prerequisites

- Node.js 18+
- Circle developer account (DCW + App Kit access)
- OpenRouter API key
- LI.FI API key (optional, increases rate limits)

### Environment Variables

```env
# Circle
CIRCLE_API_KEY=
CIRCLE_WALLET_SET_ID=
CIRCLE_APP_ID=
ARC_CLIENT_ID=

# AI
OPENROUTER_API_KEY=

# LI.FI (optional)
LIFI_API_KEY=

# Notifications
DISCORD_WEBHOOK_URL=

# Server
PORT=5003
```

### Install & Run

```bash
git clone https://github.com/cryptohakka/arcana
cd arcana
npm install
cp .env.example .env
# fill in .env

node ui-server.js
# → http://localhost:5003
```

### systemd (production)

```bash
sudo systemctl start arcana-ui
sudo systemctl enable arcana-ui
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/regime` | Latest regime JSON |
| `GET` | `/api/balances` | Unified Balance across all chains |
| `GET` | `/api/snapshots` | Last 8 BTC price snapshots (24h) |
| `GET` | `/api/tx-history` | Transaction history |
| `GET` | `/api/users` | Registered user count |
| `POST` | `/api/user/register` | Register EOA → derive DCW |
| `POST` | `/api/regime-check` | Manual regime trigger |
| `POST` | `/api/risk-on` | Manual risk-on rebalance |
| `POST` | `/api/risk-off` | Manual risk-off rebalance |
| `GET` | `/events` | SSE stream (live log + regime updates) |

---

## Live Demo

> Deployed on Arc Testnet. Connect MetaMask to try the full flow.

**URL:** https://arcana.a2aflow.space

1. Connect wallet → agent DCW is auto-created
2. Send USDC to your deposit address on Arc Testnet
3. Watch the 15-min regime cycle rebalance your position automatically
4. Use **▶ Regime Check / Risk-On / Risk-Off** buttons in Live Log for instant demo

---

## License

MIT
