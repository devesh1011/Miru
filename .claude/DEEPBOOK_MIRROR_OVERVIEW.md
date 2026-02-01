# DeepMirror: Adapting MetEngine to Sui for ETHGlobal HackMoney 2026

### DeepMirror

DeepMirror adapts MetEngine's proven "automated copy LP" model to Sui's DeepBook CLOB:

**Core Functionality:**

- **Telegram Bot Interface**: Users interact via familiar chat commands (e.g., `/copy [wallet_address]`, `/positions`, `/withdraw`)
- **Real-Time Position Mirroring**: Automatically replicates top LPs' limit orders on DeepBook pools in near real-time
- **DeepBook CLOB Integration**: Leverages DeepBook's transparent order book for price discovery and liquidity matching [Source 3, 7]
- **One-Click LP Management**: Handles swaps (via aggregators for best routes), position opening, monitoring, and exits
- **Smart Notifications**: Alerts users to impermanent loss thresholds, yield changes, or position fills

**Adaptation from Solana AMM to Sui CLOB:**

- **From:** Mirroring AMM pool positions (e.g., Raydium DLMM ranges on Solana)
- **To:** Mirroring CLOB limit orders and maker positions on DeepBook
- **Advantage:** DeepBook's order book transparency allows precise tracking of top makers' price levels and volumes, unlike opaque AMM positions

**Key Differentiation:**

- **First CLOB-focused copy LP bot**: Existing bots (Suiba, Cenbot on Sui [Source 10]) primarily handle trading, not liquidity provision mirroring
- **Institutional-grade infrastructure**: Sui's 300-400ms settlement [Source 3, 7] enables high-frequency LP adjustments rivaling centralized exchanges
- **Composable design**: Move modules allow integration with other Sui DeFi protocols (e.g., Suilend for leveraged LP, Cetus Vaults for auto-rebalancing)

---

## 2. Feasibility on Sui: Technical Advantages

### 2.1 Sui Blockchain Capabilities

Sui's architecture provides several advantages over Solana for DeepMirror's use case:

**Parallel Execution and Object Model:**

- **Sui's Object-Centric Model**: Each liquidity position or order is a unique object with ownership, enabling parallel processing of independent transactions [Source 6, 12]
- **Transaction Finality**: Sub-second finality (~390ms for DeepBook trades [Source 3, 7]) vs. Solana's ~400ms block times with occasional congestion
- **Gas Efficiency**: Move VM 2.0 reduced gas fees by 40% [Source 15], crucial for frequent bot operations

**Comparison to Solana:**
| Feature | Sui (DeepBook) | Solana (Raydium/Orca) |
|---------|----------------|------------------------|
| Execution Model | Parallel (object-based) | Sequential (account-based) |
| Settlement Speed | ~390ms [Source 3] | ~400ms (blocks), variable under load |
| Liquidity Model | CLOB (limit orders) | AMM (constant product/DLMM) |
| Order Transparency | Full order book visibility | Opaque pool positions |
| Gas Costs (2025-26) | Low, 40% reduction via VM 2.0 [Source 15] | Variable, congestion spikes |

**Why This Matters for DeepMirror:**

- **Scalability**: Sui can handle high-frequency LP position updates without network congestion, critical for mirroring volatile memecoin markets
- **Predictable Costs**: Stable gas fees enable profitable bot operation even on small positions
- **Object Ownership**: Secure management of user LP positions as distinct objects, reducing smart contract complexity

### 2.2 DeepBook CLOB Architecture

DeepBook is Sui's native decentralized central limit order book, serving as the ecosystem's foundational liquidity layer [Source 3, 7]:

**Key Features for DeepMirror:**

1. **Unified Liquidity**: Shared order book across all Sui dApps, wallets, and aggregators—no fragmented liquidity [Source 3, 7]
2. **Price-Time Priority Matching**: Traditional CLOB matching logic enables predictable execution and tighter spreads [Source 8]
3. **Composability**: DeepBook modules integrate directly into Move contracts, allowing DeepMirror to programmatically place/cancel orders [Source 8]
4. **Transparency**: Public order book data (bid/ask levels, volumes) allows tracking top makers in real-time [Source 3]
5. **DEEP Token Incentives**: Staking DEEP reduces maker/taker fees (taker fees as low as 0.25 bps on stable pairs, 2.5 bps on volatile pairs [Source 3]), improving LP profitability

**DeepBookV3 Enhancements (Launched 2024):**

- Flash loans for capital-efficient arbitrage [Source 3]
- Improved account abstraction via custodian accounts [Source 9]
- Governance for pool-level parameters (fees, staking requirements) [Source 11]
- Enhanced matching engine with lower latency [Source 3]

**Technical Workflow for DeepMirror:**

1. **Monitor**: Subscribe to DeepBook order book events via Sui websockets/GraphQL [Source 13]
2. **Identify Top Makers**: Analyze volume, fill rates, and profitability of makers on target pools
3. **Mirror Orders**: Use DeepBook SDK to place proportional limit orders matching top makers' positions
4. **Manage Lifecycle**: Auto-cancel/replace orders based on market movements or fill status
5. **Settle**: Withdraw earned fees and principal to user wallets

---

## 3. Architecture Outline

### 3.1 High-Level System Design

```
┌─────────────────────────────────────────────────────────────┐
│                      DeepMirror System                      │
└─────────────────────────────────────────────────────────────┘

┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   Telegram   │──────▶│   Bot API    │──────▶│   Backend    │
│     User     │◀──────│   (Webhook)  │◀──────│    Server    │
└──────────────┘       └──────────────┘       └──────────────┘
                                                      │
                                    ┌─────────────────┼─────────────────┐
                                    │                 │                 │
                              ┌─────▼─────┐   ┌──────▼──────┐  ┌──────▼──────┐
                              │  Position  │   │  DeepBook   │  │  Sui RPC/   │
                              │  Monitor   │   │  SDK Client │  │  WebSocket  │
                              │  (Workers) │   └─────────────┘  └──────┬──────┘
                              └────────────┘                            │
                                    │                                   │
                              ┌─────▼─────┐                    ┌────────▼────────┐
                              │ PostgreSQL│                    │   Sui Network   │
                              │  Database │                    │  (Testnet/Main) │
                              └───────────┘                    └─────────────────┘
                                                                        │
                                                        ┌───────────────┼───────────────┐
                                                        │               │               │
                                                  ┌─────▼─────┐  ┌──────▼──────┐ ┌─────▼─────┐
                                                  │ DeepBook  │  │   Move      │ │   Sui     │
                                                  │   CLOB    │  │  Contracts  │ │  Wallet   │
                                                  └───────────┘  └─────────────┘ └───────────┘
```

### 3.2 Component Breakdown

**1. Telegram Bot Frontend (Telegraf.js)**

- **User Commands**: `/start`, `/copy [address]`, `/stopCopy`, `/positions`, `/withdraw [amount]`, `/stats`
- **Inline Keyboards**: Select pools, set copy ratios (10%, 50%, 100% of target position), configure alerts
- **Webhook/Polling**: Receive messages from Telegram API
- **Authentication**: Link Telegram user to Sui wallet via one-time signature verification

**2. Backend Server (Node.js(TS) + Express)**

- **REST API**: Handle Telegram webhook, provide frontend data for future web dashboard
- **Job Queue (Bull/BullMQ)**: Process async tasks (order placement, monitoring, rebalancing)
- **Session Management**: Store user state (active copies, balances, preferences)
- **Rate Limiting**: Prevent abuse, manage Sui RPC call quotas

**3. Position Monitor (Worker Service)**

- **Order Book Subscriber**: WebSocket connection to Sui RPC, subscribe to DeepBook pool events (`OrderPlaced`, `OrderFilled`, `OrderCancelled`)
- **Maker Identification**: Analyze order book snapshots to rank makers by volume, profitability
  - Query: `sui_getEvents` with filter on DeepBook pool object
  - Metrics: Total volume, fill rate, time-weighted spread, net fees earned
- **Mirror Logic**: When target maker places/cancels order, trigger proportional action for copying users
- **Impermanent Loss Tracking**: Calculate IL based on filled orders vs. holding assets; alert if exceeds threshold

**4. DeepBook SDK Client (TypeScript)**

- **Initialization**: Connect to Sui network via `SuiClient` from `@mysten/sui` [Source 13]
  ```typescript
  import { SuiClient, getFullnodeUrl } from "@mysten/sui";
  const client = new SuiClient({ url: getFullnodeUrl("testnet") });
  ```
- **PTB Construction**: Build Programmable Transaction Blocks for multi-step operations
  - Example: Swap USDC → SUI via Cetus, then place DeepBook limit order
- **Order Placement**: Call `deepbook::place_limit_order` with user's `AccountCap`
- **Custodian Account Management**: Create accounts for new users, store `AccountCap` object IDs
- **Fee Optimization**: Stake DEEP tokens for reduced fees (integrate DEEP staking contracts)

**5. Database (PostgreSQL)**

- **Users Table**: `{ telegram_id, sui_address, account_cap_id, deep_balance, created_at }`
- **CopyTargets Table**: `{ user_id, target_maker_address, pool_id, copy_ratio, status }`
- **Positions Table**: `{ user_id, pool_id, order_ids[], entry_price, current_value, fees_earned }`
- **MakerRankings Table**: `{ maker_address, pool_id, volume_7d, profitability_score, rank }`

**6. On-Chain Move Contracts (Minimal)**

- **Purpose**: Sui's composability allows using existing DeepBook modules; custom contracts only needed for advanced features
- **Potential Modules**:
  - `deepmirror::aggregator`: Batch order placements for gas efficiency (place multiple users' orders in one PTB)
  - `deepmirror::vault`: Optional shared liquidity pool where users deposit, bot manages collectively (higher capital efficiency)
- **Deployment**: Use Sui CLI `sui move publish` to deploy to testnet/mainnet

### 3.3 User Flow Example

**Scenario:** Alice wants to copy the top SUI/USDC maker on DeepBook

1. **Onboarding**:
   - Alice sends `/start` to DeepMirror Telegram bot
   - Bot prompts wallet connection: "Send a signature from your Sui Wallet to link"
   - Alice signs with Suiet, bot stores her address and creates DeepBook `AccountCap`

2. **Copy Activation**:
   - Alice sends `/copy 0xTOP_MAKER_ADDRESS SUI/USDC 50%`
   - Bot queries DeepBook for SUI/USDC pool, identifies top maker (ranked #1 by 7-day volume)
   - Confirms: "Copying Maker X (0xTOP...) at 50% ratio. Deposit USDC/SUI to start."

3. **Deposit**:
   - Alice sends 1000 USDC to her DeepBook account via `/deposit USDC 1000`
   - Backend constructs PTB: transfer USDC → `deepbook::deposit_quote`

4. **Mirroring**:
   - Monitor detects top maker places bid: 500 SUI at $0.90
   - Backend calculates Alice's 50% mirror: 250 SUI bid at $0.90
   - Constructs PTB: `deepbook::place_limit_order(pool, 0.90, 250, true, ...)`
   - Executes with Alice's `AccountCap`, sends confirmation: "Order placed: Bid 250 SUI @ $0.90"

5. **Order Fill & Yield**:
   - Market price hits $0.90, Alice's bid fills
   - Bot detects `OrderFilled` event, sends notification: "Your bid filled! +250 SUI. Earned 0.5 USDC rebate."

6. **Withdrawal**:
   - Alice sends `/withdraw SUI 250`
   - Backend: `deepbook::withdraw_base(pool, 250, account_cap)` → transfers 250 SUI to Alice's wallet

---

## 4. Development Resources

### 4.1 Sui Developer Tools

**Official Documentation:**

- **Sui Docs** [Source 6]: Comprehensive guides for Move, SDKs, RPC APIs
  - DeFi Building: https://docs.sui.io/build/defi (not accessible, but referenced in sources)
  - Move Tutorials: https://docs.sui.io/references/move
  - SDK References: https://docs.sui.io/references/sui-sdks

**SDKs and Frameworks:**

1. **TypeScript SDK** (`@mysten/sui`) [Source 13]:
   - Installation: `npm install @mysten/sui`
   - Docs: https://sdk.mystenlabs.com/typescript
   - Key Modules: `SuiClient`, `TransactionBlock`, `Ed25519Keypair`

2. **Sui dApp Kit** (`@mysten/dapp-kit-react`) [Source 13]:
   - React hooks for wallet connection, transaction signing
   - Components: `ConnectButton`, `useSignAndExecuteTransaction`
   - Future Extension: Build web dashboard alongside Telegram bot

3. **Rust SDK** (`sui-sdk` crate):
   - For backend services requiring lower-level control (alternative to TypeScript)

4. **Python pysui** [Source 6]:
   - Community SDK for Python-based bots (could prototype here before TypeScript migration)

**Tooling:**

- **Sui CLI**: `sui move build`, `sui client publish`, `sui client call` for contract deployment/testing [Source 9]
- **Sui Explorer**: https://suiscan.xyz/ for transaction inspection
- **Sui RPC Providers**: Mysten Labs (free tier), QuickNode, Chainstack [Source 13]

### 4.2 DeepBook Resources

**Documentation:**

- **DeepBook Docs** [Source 3]: https://docs.sui.io/standards/deepbook
  - Architecture overview, tokenomics, API endpoints
- **DeepBook Tutorial** [Source 9]: https://hackmd.io/@moritzfelipe/sui-dacade-deepbook-tutorial-01
  - Step-by-step: Create pool, deposit assets, place limit/market orders, withdraw
  - Example Move contracts for interacting with DeepBook modules

**GitHub Repositories:**

- **DeepBookV3 Source**: https://github.com/MystenLabs/deepbookv3 [Source 3]
  - Reference implementation, on-chain matching logic
- **DeepBook SDK** (if exists separately from Sui SDK):
  - May be embedded in `@mysten/sui` or a separate `@deepbook/sdk` package (check NPM)

**Whitepapers:**

- **DeepBook Whitepaper** [Source 8]: https://assets-cms.kraken.com/files/51n36hrp/facade/5e2072afc89b939d8c6fc140ea7f396911e9bc6c.pdf
  - DEEP tokenomics, fee structure, governance model, audits

### 4.3 Telegram Bot Development

**Frameworks:**

- **Telegraf.js** (Node.js): Industry standard for Telegram bots
  - Installation: `npm install telegraf`
  - Docs: https://telegraf.js.org/
  - Features: Command handling, inline keyboards, webhooks

**Integration with Sui:**

```typescript
import { Telegraf } from "telegraf";
import { SuiClient } from "@mysten/sui";

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const suiClient = new SuiClient({ url: getFullnodeUrl("testnet") });

bot.command("positions", async (ctx) => {
  const userAddress = getUserAddress(ctx.from.id); // From DB
  const objects = await suiClient.getOwnedObjects({ owner: userAddress });
  // Filter for DeepBook position objects, format, send to Telegram
  ctx.reply(`Your positions: ${formatPositions(objects)}`);
});
```

**Resources:**

- **Telegram Bot API Docs**: https://core.telegram.org/bots/api
- **Webhook Setup**: For production, host on Vercel/Heroku with webhook endpoint

---

## 5. Potential Extensions and Cross-Track Integrations

### 5.1 Cross-Track Opportunities at ETHGlobal HackMoney 2026

**Arc Network (USDC Track):**

- **Integration**: Auto-convert user deposits to USDC for stablecoin LP strategies
- **Value Add**: Reduce volatility risk; target stable pairs on DeepBook (e.g., USDC/USDT) with predictable yields
- **Prize Potential**: Dual submission for Sui + Arc tracks

**Yellow Network (Gas-Free Transactions):**

- **Integration**: Use Yellow's state channel for off-chain order matching, settle on Sui only when filled
- **Value Add**: Reduce gas costs for high-frequency LP rebalancing
- **Technical Challenge**: Requires Yellow SDK integration (if available for Sui)

**LI.FI (Cross-Chain Liquidity):**

- **Integration**: Bridge assets from Ethereum/Solana to Sui for LPing
- **Value Add**: Enable users to copy Sui makers using ETH/SOL holdings (broadens user base)
- **UI Flow**: "I have ETH → DeepMirror bridges to Sui → Starts copying"

### 5.2 Feature Roadmap (Post-Hackathon)

**Phase 1 (Hackathon MVP):**

- ✅ Telegram bot with `/copy`, `/positions`, `/withdraw` commands
- ✅ Real-time mirroring of top maker's limit orders on 1-2 DeepBook pools (e.g., SUI/USDC, SUI/DEEP)
- ✅ Custodian account management for users
- ✅ Basic impermanent loss alerts

---

---

## 6. PRD

### 6.1 Product Requirements Document (prd.md) Outline

**Suggested Structure:**

```markdown
# DeepMirror Product Requirements Document (PRD)

## 1. Executive Summary

- Vision: Democratize profitable LP strategies on Sui via Telegram bot
- Target Users: Retail DeFi traders, 18-35 years old, crypto-native
- Success Metric: 500 users, $1M volume by Month 3 post-launch

## 2. User Personas

**Persona 1: "Memecoin Mike"**

- Age 25, trades Sui memecoins, seeks quick yields
- Pain Points: Can't monitor LP 24/7, loses to bots
- Jobs-to-be-Done: Copy top makers without learning CLOB mechanics

**Persona 2: "DeFi Dina"**

- Age 30, experienced DeFi user, portfolio diversifier
- Pain Points: Tired of managing multiple vault positions
- Jobs-to-be-Done: Auto-rebalance across top Sui pools with one tool

## 3. Features (MVP - Must Have)

- [ ] **F1**: Telegram bot onboarding (wallet linking via signature)
- [ ] **F2**: `/copy [address] [pool] [ratio]` command
- [ ] **F3**: Real-time maker order monitoring (WebSocket)
- [ ] **F4**: Proportional limit order mirroring
- [ ] **F5**: `/positions` showing current LP status
- [ ] **F6**: `/withdraw` to claim assets
- [ ] **F7**: Impermanent loss alerts (threshold: -5%)

## 4. Features (Post-MVP - Should Have)

- [ ] Web dashboard (React + dApp Kit)
- [ ] DEEP token staking integration
- [ ] Multi-pool support (5+ pairs)
- [ ] Maker leaderboard (rank by profitability)

## 5. User Flows

**Flow 1: First-Time User Onboarding**

1. User finds DeepMirror via Sui community Telegram
2. Sends `/start` → Bot prompts "Link your Sui Wallet"
3. Opens Suiet, signs message, sends signature
4. Bot confirms: "Wallet 0xABC linked. Deposit to start."

**Flow 2: Copy a Top Maker**

1. User sends `/copy 0xMAKER SUI/USDC 50%`
2. Bot queries DeepBook, identifies maker's current orders
3. Bot calculates 50% mirror: "Maker has bid 1000 SUI @ $0.90, you'll bid 500 SUI @ $0.90"
4. User confirms, bot executes, sends receipt: "Order #123 placed"

**Flow 3: Order Fill and Yield**

1. Market price hits user's bid level
2. Bot detects `OrderFilled` event
3. Sends notification: "Your bid filled! +500 SUI. Earned 0.25 USDC rebate."
4. User checks `/stats` to see cumulative yield

---

## 13. Citations and Sources

[Source 1] MetEngine Project Page - Colosseum Arena: https://arena.colosseum.org/projects/explore/metengine?ref=blog.colosseum.com  
[Source 2] MetEngine X Account: https://x.com/met_engine (mentioned but not extracted in detail)  
[Source 3] MetEngine Pitch Video Transcript (provided in user request)  
[Source 4] ETHGlobal HackMoney 2026 Sui Track: https://ethglobal.com/events/hackmoney2026/prizes/sui (extracted)  
[Source 5] QuickNode Telegram Bot Tutorial (Base): https://www.quicknode.com/guides/defi/bots/build-a-telegram-trading-bot-on-base  
[Source 6] Sui Documentation (SDKs): https://docs.sui.io/references/sui-sdks (extracted)  
[Source 7] DeepBookV3 Docs - Sui Documentation: https://docs.sui.io/standards/deepbook (extracted)  
[Source 8] DeepBook Whitepaper: https://assets-cms.kraken.com/files/51n36hrp/facade/5e2072afc89b939d8c6fc140ea7f396911e9bc6c.pdf (cited)  
[Source 9] DeepBook Tutorial - HackMD: https://hackmd.io/@moritzfelipe/sui-dacade-deepbook-tutorial-01 (extracted in detail)  
[Source 10] Medium - Complete Guide to DeFi on Sui: https://medium.com/@BlockRunner/the-complete-guide-to-defi-on-sui-ff4e279f308b (extracted)  
[Source 11] DeepBook Official Site: https://deepbook.tech/ (extracted)  
[Source 12] DAIC Capital - Sui Blockchain Explainer: https://daic.capital/blog/sui-explainer-beginning-blockchain-game-changer-scalable (extracted)  
[Source 13] Sui TypeScript SDK Docs - Hello Sui: https://sdk.mystenlabs.com/typescript/hello-sui (extracted)  
[Source 14] Cetus Vaults Announcement - Medium: https://medium.com/@CetusProtocol/cetus-vaults-automate-your-liquidity-to-earn-high-yield-with-ease-ed655e68122e (extracted)  
[Source 15] AInvest - Sui Network 2025-2026 Investment Case: https://www.ainvest.com/news/sui-network-2025-2026-investment-case-generation-layer-1-blockchain-2512/ (extracted)  
[Source 16] Gate.io - Sui On-Chain Data Analysis 2025: https://www.gate.com/crypto-wiki/article/how-does-sui-s-on-chain-data-analysis-reveal-its-growth-in-2025 (extracted)

---
```
