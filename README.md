# 🪞 Miru

> **Non-custodial copy trading for Sui DeepBook V3**  
> Mirror top liquidity providers. Keep your keys. Built for HackMoney 2026.

[![Sui](https://img.shields.io/badge/Sui-Blockchain-4DA2FF?logo=sui)](https://sui.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Move](https://img.shields.io/badge/Move-Smart_Contracts-brightgreen)](https://move-language.github.io/)

---

## The Problem

Retail traders struggle to compete with professional market makers on DEXs. Copy trading exists on centralized exchanges but **requires giving up custody**. On-chain alternatives are fragmented, complex, or non-existent.

## The Solution

**Miru** automatically mirrors successful DeepBook V3 market makers via Telegram. Users keep full custody through **zkLogin** (sign transactions with Google), while the bot discovers top traders and replicates their strategies in real-time.

### Why Sui?

- **zkLogin**: Non-custodial onboarding without seed phrases
- **DeepBook V3**: Professional-grade CLOB with granular order data
- **Object Model**: Capability-based permissions for secure delegation
- **Parallel Execution**: Handle high-frequency order mirroring efficiently

---

## ✨ Key Features

| Feature                    | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| 🔐 **zkLogin Integration** | Sign in with Google, no seed phrases required          |
| 🔍 **Real-time Discovery** | Find top traders by volume, win rate, and performance  |
| 🪞 **Automated Mirroring** | Auto-copy orders at customizable ratios (1-100%)       |
| 📊 **Portfolio Analytics** | Track P&L, win rates, and performance across positions |
| 🛡️ **Risk Management**     | Stop-loss, take-profit, daily limits, auto-pause       |
| 🔔 **Smart Notifications** | Context-aware alerts with P&L updates                  |

---

## 🚀 Try It Now

### Trading Flow

```bash
# 1. Connect wallet (zkLogin)
/start → Wallet → Connect Wallet
# Opens Google OAuth, returns zkLogin address

# 2. Fund your wallet
# Send testnet SUI to your zkLogin address

# 3. Discover top traders
/pools → Browse Pools → Select Pool → Discover Makers
# Shows real mainnet DeepBook data

# 4. Create mirror position
Select maker → Choose ratio (10-100%) → Confirm
# Creates on-chain MirrorPosition object

# 5. Grant permissions
Positions → Grant Capability
# Allows backend to record orders via MirrorCapability

# Position now auto-mirrors maker's orders!
```

---

## 🏗️ Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌────────────────┐
│  Telegram   │─────▶│  Backend Server  │─────▶│  Sui Blockchain│
│   (User)    │      │                  │      │                │
└─────────────┘      │ • Mirror Engine  │      │ • DeepBook V3  │
                     │ • Event Monitor  │      │ • Mirror Module│
                     │ • zkLogin Svc    │      │ • zkLogin      │
                     │ • Risk Manager   │      └────────────────┘
                     │ • Analytics      │
                     └──────────────────┘
                             │
                             ▼
                     ┌──────────────────┐
                     │  Supabase (DB)   │
                     │ • Positions      │
                     │ • Analytics      │
                     │ • Risk Settings  │
                     └──────────────────┘
```

### Core Components

**Backend Services** (`/backend/src/services`):

- `mirror-engine.ts` - Detects maker orders, executes mirrors
- `event-monitor.ts` - Subscribes to DeepBook pool events
- `zklogin.ts` - Manages user authentication & signing
- `analytics.ts` - Tracks P&L, win rates, portfolio stats
- `risk-manager.ts` - Pre/post-trade risk enforcement
- `smart-notifier.ts` - Context-aware Telegram notifications

**Smart Contracts** (`/contracts/miru`):

- `MirrorPosition` - Stores position config (maker, pool, ratio)
- `MirrorCapability` - Delegates backend permission to record orders
- `create_position()` - User-owned position creation
- `record_order()` - Backend tracks executed orders

**Bot Interface** (`/backend/src/bot`):

- Menu-driven UI with inline keyboards
- 17 slash commands + button callbacks
- Conversation state management
- Error handling with user-friendly messages

---

## �️ Tech Stack

| Layer          | Technologies                                          |
| -------------- | ----------------------------------------------------- |
| **Blockchain** | Sui, DeepBook V3 SDK, Move smart contracts, zkLogin   |
| **Backend**    | Node.js, TypeScript, Telegraf (bot framework)         |
| **SDKs**       | @mysten/sui v2.3.0, @mysten/deepbook-v3 v1.0.3        |
| **Database**   | Supabase PostgreSQL (RLS enabled)                     |
| **Auth**       | zkLogin (Google OAuth), ephemeral keypairs, ZK proofs |

---

## 📦 Setup & Installation

### 1. Clone Repository

```bash
git clone https://github.com/yourusername/miru.git
cd miru
```

### 2. Backend Setup

```bash
cd backend
npm install
cp .env.example .env
```

**Edit `.env`:**

```bash
# Network
SUI_NETWORK=testnet  # or mainnet
SUI_RPC_URL=https://fullnode.testnet.sui.io:443

# Wallet (backend operator)
WALLET_PRIVATE_KEY=suiprivkey1q...

# zkLogin
GOOGLE_CLIENT_ID=your-google-oauth-client-id
ZKLOGIN_REDIRECT_URL=https://your-callback-url.vercel.app/callback
ZKLOGIN_MASTER_SEED=random-seed-for-address-derivation

# Telegram
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather

# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key

# Contracts (testnet)
MIRROR_PACKAGE_ID=0x3a5ee3378bb45a032eeb185a93ebcc1c2ee1b06848d4323a27c9539a653cdf31
DEEPBOOK_PACKAGE_ID=0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809
```

**Run:**

```bash
npm run build
npm start
```

### 3. Smart Contracts (Optional)

Contracts already deployed to testnet. To redeploy:

```bash
cd contracts
sui move build
sui client publish --gas-budget 100000000
# Update MIRROR_PACKAGE_ID in .env
```

### 4. OAuth Callback (Optional)

```bash
cd callback
vercel deploy
# Update ZKLOGIN_REDIRECT_URL in .env
```

### 5. Database Migrations

```bash
cd backend/supabase/migrations
# Apply migrations via Supabase dashboard or CLI
supabase db push
```

---

## � Sui-Specific Innovation

### zkLogin Integration

- **No seed phrases**: Users sign in with Google
- **Non-custodial**: Ephemeral keypairs + ZK proofs = user-owned addresses
- **UX breakthrough**: Onboard anyone, not just crypto natives

### DeepBook V3 CLOB

- **Professional-grade**: Order book data (price, quantity, maker address)
- **Real-time events**: Subscribe to pool updates for instant mirroring
- **Mainnet data**: Discover actual high-volume traders ($5M+ daily)

### Capability-Based Permissions

- `MirrorCapability` object grants backend limited delegation
- User retains ownership of `MirrorPosition`
- Capability can be revoked anytime
- Expiration-based for time-limited access

### Hybrid Architecture

- **User wallet** (zkLogin): Owns positions, can pause/close
- **Backend wallet**: Places DeepBook orders (automated trading)
- **Best of both worlds**: Non-custodial control + automation

---

**Built with ❤️ for HackMoney 2026**

_Making professional trading accessible to everyone._
