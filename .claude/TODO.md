# DeepMirror Development TODO

## Phase 0: Pre-Hackathon Setup (1 day)

- [ ] Create GitHub repository with README
- [ ] Set up local Sui node or configure testnet RPC endpoint
- [ ] Install Sui CLI, TypeScript SDK, Telegraf.js
- [ ] Generate test wallets (2-3 addresses for testing)
- [ ] Request testnet SUI from faucet (faucet.sui.io)
- [ ] Create Telegram bot via BotFather, get API token

## Phase 1: Sui Testnet Integration (Day 1-2)

- [ ] **Task 1.1**: Initialize Sui TypeScript client
  - Code: `const client = new SuiClient({ url: getFullnodeUrl('testnet') })`
  - Test: Query testnet block height, verify connection
- [ ] **Task 1.2**: Deploy basic Move contract (optional)
  - File: `sources/deepmirror.move`
  - Function: `public fun create_mirror_position(...)`
  - Command: `sui move build && sui client publish`
  - Verify: Check contract on Sui Explorer

- [ ] **Task 1.3**: Integrate DeepBook SDK
  - Install: Check if DeepBook SDK separate or part of `@mysten/sui`
  - Test: Call `deepbook::create_account(ctx)` from TypeScript
  - Create custodian account for test wallet, log `AccountCap` object ID

- [ ] **Task 1.4**: Test limit order placement
  - Function: `deepbook::place_limit_order(pool, price, qty, is_bid, ...)`
  - Pool: Use existing testnet SUI/USDC pool (find via DeepBook docs)
  - Test: Place bid at $0.50 for 10 SUI, verify on-chain

## Phase 2: Telegram Bot Setup (Day 2-3)

- [ ] **Task 2.1**: Initialize Telegraf bot
  - File: `src/bot/index.ts`
  - Commands: `/start`, `/help`, `/test`
  - Test: Send `/test` → Bot replies "Hello from DeepMirror"

- [ ] **Task 2.2**: Implement wallet linking flow
  - Command: `/link`
  - Logic: Generate random message, prompt user to sign in Suiet
  - Store: `{ telegram_id: 12345, sui_address: '0xABC', linked_at: timestamp }`
  - Database: Set up PostgreSQL table `users`

- [ ] **Task 2.3**: Implement `/copy` command (basic)
  - Input: `/copy 0xMAKER_ADDRESS SUI/USDC 50%`
  - Logic: Parse arguments, validate address, store in `copy_targets` table
  - Response: "Now copying 0xMAKER... on SUI/USDC at 50% ratio"

## Phase 3: DeepBook Monitoring (Day 3-4)

- [ ] **Task 3.1**: Set up WebSocket subscription
  - Endpoint: Sui RPC WebSocket (check Sui docs for URL)
  - Subscribe to: `OrderPlaced`, `OrderFilled` events on target pool
  - Test: Log events to console, verify data structure

- [ ] **Task 3.2**: Implement maker order tracking
  - Logic: On `OrderPlaced` event, check if sender is tracked maker
  - Store: Parse price, quantity, is_bid; save to `maker_orders` table
  - Test: Manually place order from test maker wallet, verify detection

- [ ] **Task 3.3**: Build mirroring logic
  - Trigger: When maker places order, calculate user's proportional qty
  - Example: Maker bids 1000 SUI @ $0.90, user (50% ratio) → bid 500 SUI @ $0.90
  - Construct PTB: `TransactionBlock.moveCall({ target: 'deepbook::place_limit_order', ... })`
  - Execute: Sign with user's account (backend holds key or user pre-approves)

- [ ] **Task 3.4**: Send Telegram notifications
  - On order placed: "Copied Maker X: Bid 500 SUI @ $0.90 (Order #123)"
  - On order filled: "Your bid filled! +500 SUI, earned 0.2 USDC rebate"

## Phase 4: User Management (Day 4-5)

- [ ] **Task 4.1**: Implement `/positions` command
  - Query: Fetch user's open orders from DeepBook (via `getOwnedObjects` or DeepBook SDK)
  - Display: Pool, price, quantity, status (open/filled), PnL estimate
- [ ] **Task 4.2**: Implement `/withdraw` command
  - Input: `/withdraw SUI 100`
  - Logic: Call `deepbook::withdraw_base(pool, 100, account_cap, ctx)`
  - Transfer: 100 SUI from DeepBook account to user's wallet
  - Confirm: "Withdrawn 100 SUI to 0xABC..."

- [ ] **Task 4.3**: Impermanent loss calculation
  - Formula: Compare current position value vs. if held assets outside LP
  - Trigger: Alert if IL > 5% (configurable threshold)
  - Notification: "Warning: IL at 6.2% on SUI/USDC position"

- [ ] **Task 4.4**: Database schema finalization
  - Tables: `users`, `copy_targets`, `positions`, `maker_orders`, `transactions`
  - Indexes: On `user_id`, `maker_address`, `pool_id` for fast queries
  - Migrations: Use Prisma or raw SQL

## Phase 5: Testing and Refinement (Day 5-6)

- [ ] **Task 5.1**: End-to-end test (happy path)
  - Scenario: New user links wallet → copies maker → order fills → withdraws
  - Validation: Check database consistency, on-chain state, Telegram messages

- [ ] **Task 5.2**: Error handling
  - Cases: Invalid wallet address, insufficient balance, maker not found, network errors
  - Responses: Clear error messages to user (e.g., "Insufficient USDC to place bid")

- [ ] **Task 5.3**: Gas optimization
  - Batch: Combine multiple users' orders in one PTB if copying same maker
  - Estimate: Log gas costs per operation, target <0.01 SUI per order

- [ ] **Task 5.4**: Security audit (basic)
  - Review: Check for SQL injection risks, validate all user inputs
  - Keys: Ensure private keys never logged or exposed in API responses
  - Permissions: Bot can only act on linked users' behalf (verify AccountCap ownership)
