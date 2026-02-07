# Miru - Automated Copy Trading for DeepBook V3

> **Non-custodial liquidity mirroring bot for Sui's DeepBook CLOB**

Built for **HackMoney 2026**

---

## 🎯 What is Miru?

Miru (formerly DeepMirror) is a **Telegram bot** that lets you automatically copy successful market makers on Sui's DeepBook V3 CLOB. You maintain full control of your funds via **zkLogin** (Google authentication) while the bot mirrors your chosen maker's orders at your preferred ratio.

**Key Features:**

- 🔐 **Non-custodial** - Your keys, your coins (via zkLogin)
- 📱 **Telegram-native** - Complete trading from your phone
- ⚡ **Real-time** - Automatically mirrors orders as they happen
- 📊 **Customizable** - Choose your copy ratio (1-100%)
- 🛡️ **Secure** - Capability-based permissions with expiration

---

## 🚀 Quick Start

### Prerequisites

- Telegram account
- Google account (for zkLogin)
- Testnet SUI tokens ([get from faucet](https://faucet.testnet.sui.io/))

### User Flow

1. **Connect your wallet**

   ```
   /connect
   ```

   - Click the Google OAuth link
   - Complete authentication
   - Copy your JWT token
   - Submit with `/auth <jwt>`

2. **Fund your wallet**

   ```
   /deposit
   ```

   - Get your zkLogin wallet address
   - Fund it with testnet SUI

3. **Discover top makers**

   ```
   /discover DEEP_SUI
   ```

   - Browse successful market makers
   - See their performance metrics

4. **Start copying**

   ```
   /copy <maker_address> DEEP_SUI 25
   ```

   - Creates a mirror position at 25% ratio
   - Auto-places proportional orders when maker trades

5. **Manage your positions**
   ```
   /positions        # List active positions
   /status <id>      # View position details
   /stop <id>        # Deactivate position
   ```

---

## 🏗️ Architecture

```
Telegram Bot → Backend Services → Sui Blockchain
                    ↓                    ↓
              SQLite Database    Mirror Contract + DeepBook V3
```

### Components

**Backend** (`/backend`)

- TypeScript Node.js server
- zkLogin authentication service
- Mirror engine (order detection & placement)
- Event monitor (DeepBook pool subscriptions)
- Telegram bot interface (17 commands)

**Smart Contracts** (`/contracts`)

- Move module for position management
- Capability-based backend authorization
- Order tracking and lifecycle management

**OAuth Callback** (`/callback`)

- Static HTML page for Google OAuth redirect
- Extracts JWT for zkLogin flow

---

## 📦 Installation & Setup

### Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your credentials
npm run build
npm start
```

**Required Environment Variables:**

```bash
SUI_NETWORK=testnet
WALLET_PRIVATE_KEY=<backend_operator_key>
ZKLOGIN_GOOGLE_CLIENT_ID=<your_client_id>
ZKLOGIN_REDIRECT_URL=<your_callback_url>
ZKLOGIN_MASTER_SEED=<random_seed>
TELEGRAM_BOT_TOKEN=<your_bot_token>
MIRROR_PACKAGE_ID=<deployed_contract_address>
```

### Smart Contracts

```bash
cd contracts
sui move build
sui client publish --gas-budget 100000000
# Update MIRROR_PACKAGE_ID in backend/.env
```

### OAuth Callback

```bash
cd callback
# Deploy to Vercel or any static host
vercel deploy
# Update ZKLOGIN_REDIRECT_URL in backend/.env
```

---

## 🎮 Bot Commands

| Command                        | Description                   |
| ------------------------------ | ----------------------------- |
| `/start`                       | Welcome message               |
| `/connect`                     | Start zkLogin authentication  |
| `/auth <jwt>`                  | Complete zkLogin with JWT     |
| `/wallet`                      | View wallet address & balance |
| `/deposit`                     | Get deposit instructions      |
| `/withdraw <addr> <amt>`       | Withdraw SUI                  |
| `/pools`                       | Browse available pools        |
| `/discover <pool>`             | Find top makers               |
| `/copy <maker> <pool> <ratio>` | Create mirror position        |
| `/positions`                   | List your positions           |
| `/status <id>`                 | View position details         |
| `/stop <id>`                   | Deactivate position           |
| `/grant <id>`                  | Allow backend to place orders |
| `/revoke <id>`                 | Remove backend permissions    |
| `/balance`                     | Check balances                |
| `/help`                        | Command reference             |

---

## 🛠️ Tech Stack

**Blockchain:**

- Sui blockchain (testnet)
- DeepBook V3 CLOB
- Sui Move smart contracts

**Backend:**

- Node.js + TypeScript
- Telegraf (Telegram bot framework)
- @mysten/sui SDK (v2.3.0)
- @mysten/deepbook-v3 SDK (v1.0.3)
- better-sqlite3 (local database)

**Authentication:**

- zkLogin (Google OAuth → Sui address)
- Ephemeral keypairs
- ZK proofs from Mysten Labs prover

---

## 📊 Project Status

**✅ Completed:**

- zkLogin authentication flow
- Mirror position smart contracts
- Telegram bot with 17 commands
- Event monitoring infrastructure
- Comprehensive error handling
- OAuth callback page

**🚧 In Progress:**

- End-to-end testing with live users
- Real-time order mirroring validation
- Performance optimization

**📋 Next Steps:**

- Order synchronization (filled/cancelled)
- Advanced position analytics
- Multi-maker portfolio management
- Telegram mini-app UI

See [PROJECT_STATUS.md](./PROJECT_STATUS.md) for detailed status report.

---

## 🔗 Key Links

- **Deployed Contract (Testnet):** `0x3a5ee3378bb45a032eeb185a93ebcc1c2ee1b06848d4323a27c9539a653cdf31`
- **DeepBook V3 Docs:** https://docs.sui.io/standards/deepbookv3-sdk
- **zkLogin Docs:** https://docs.sui.io/concepts/cryptography/zklogin
- **Sui Testnet Faucet:** https://faucet.testnet.sui.io/

---

## 🐛 Known Issues & Fixes

### Recent Critical Fix: Groth16 Proof Verification ✅

**Issue:** Transaction signing failed with "Groth16 proof verify failed"

**Root Cause:** Prover service received raw public key instead of extended format

**Fix:** Now using `getExtendedEphemeralPublicKey()` for prover calls

**To Test:** Users must re-authenticate (`/connect`) to get a new proof

---

## 📝 Example Flow

```
User: /connect
Bot:  🔐 Click here to authenticate: [Google OAuth Link]

[User clicks link, completes Google OAuth, gets JWT]

User: /auth eyJhbGciOiJSUzI1NiIs...
Bot:  ✅ Wallet connected!
      Your Sui address: 0x4eb8183c889...

User: /deposit
Bot:  💰 Send SUI to: 0x4eb8183c889...

[User funds wallet via faucet]

User: /discover DEEP_SUI
Bot:  📊 Top Makers in DEEP_SUI:
      1. 0x25a3c5... - 10,523 DEEP volume
      2. 0x8f21ab... - 8,891 DEEP volume
      [Copy] buttons

User: /copy 0x25a3c5...95bb1b DEEP_SUI 25
Bot:  🔄 Setting up mirror position...
      ✅ Position created! ID: 0xabc123...

User: /grant 0xabc123...
Bot:  ✅ Backend authorized to place orders
      Your position is now active!

[Backend automatically mirrors maker's orders at 25% ratio]
```

---

**Built with ❤️ for HackMoney 2026**
