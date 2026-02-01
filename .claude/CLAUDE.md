# Project: DeepMirror

Telegram-based automated liquidity provision bot for Sui's DeepBook CLOB, enabling users to mirror top liquidity providers' positions with simple chat commands. Built for ETHGlobal HackMoney 2026 Sui track.

## Project Context

- **Tech Stack**: Sui blockchain (Move smart contracts), Node.js backend, TypeScript SDK (@mysten/sui), Telegram bot (Telegraf.js), PostgreSQL database
- **Core Functionality**: Real-time monitoring of DeepBook order books, automated limit order mirroring, custodian account management

## Code Style

### TypeScript/JavaScript

- Use TypeScript strict mode, avoid `any` types
- Prefer `const` over `let`, never use `var`
- Use async/await over promises chains for clarity
- Named exports only, no default exports
- ES modules syntax (`import/export`), not CommonJS
- Arrow functions for callbacks and utilities
- Functional patterns preferred over classes where appropriate
- Use template literals for string interpolation
- Destructuring for object/array access where it improves readability

### Sui Move Contracts

- Refer `.claude/skills/move_contracts_development/sui-move-defi.md`
- Follow Sui Move style guide: snake_case for variables/functions, PascalCase for structs
- Always use `public` or `public(package)` visibility explicitly
- Document all public functions with comments explaining parameters and return values
- Use resource safety: objects consumed in functions must be transferred or destroyed
- Prefer owned objects over shared objects for parallelism
- Include error constants at module level: `const E_INVALID_AMOUNT: u64 = 1;`
- Test all public entry functions with unit tests in `*_tests.move` files

### General

- File naming: kebab-case for all files (`order-monitor.ts`, not `OrderMonitor.ts`)
- Max line length: 100 characters (TypeScript), 120 characters (Move)
- Use 2 spaces for indentation (TypeScript), 4 spaces (Move)
- Always include error handling with descriptive messages
- Log at appropriate levels: `debug` for verbose, `info` for key events, `error` for failures

## Commands

### Development

- `npm install`: Install dependencies
- `npm run dev`: Start development server with hot reload
- `npm run bot:dev`: Run Telegram bot in development mode with nodemon
- `npm run test`: Run Jest unit tests
- `npm run test:watch`: Run tests in watch mode
- `npm run lint`: ESLint check with auto-fix
- `npm run format`: Prettier code formatting

### Sui Blockchain

- `sui move build`: Compile Move contracts in `sources/` directory
- `sui move test`: Run Move unit tests
- `sui client publish --gas-budget 100000000`: Publish contracts to active network (testnet/mainnet)
- `sui client call --package <PACKAGE_ID> --module <MODULE> --function <FUNCTION> --args <ARGS>`: Call deployed contracts
- `sui client switch --env testnet`: Switch to Sui testnet
- `sui client switch --env mainnet`: Switch to Sui mainnet
- `sui client gas`: Check gas coins for active address
- `sui client objects`: List owned objects for debugging

### Database

- `npm run db:migrate`: Run Prisma migrations (when implemented)
- `npm run db:seed`: Seed database with test data
- `npm run db:reset`: Reset database (development only)

### Production

- `npm run build`: Build TypeScript for production
- `npm start`: Start production server

## Project Architecture

```
hackmoney_2026/
├── .claude/                  # Claude memory files
│   ├── CLAUDE.md            # This file
│   └── rules/               # Modular rules (if needed)
├── sources/                 # Sui Move smart contracts
│   ├── deepmirror.move      # Core mirroring logic
│   ├── aggregator.move      # Batch order placement
│   └── *_tests.move         # Move unit tests
├── src/                     # Node.js backend
│   ├── bot/                 # Telegram bot logic
│   │   ├── index.ts         # Bot initialization
│   │   ├── commands/        # Bot command handlers
│   │   └── middleware/      # Authentication, logging
│   ├── services/            # Business logic
│   │   ├── sui-client.ts    # Sui RPC client wrapper
│   │   ├── deepbook.ts      # DeepBook SDK integration
│   │   ├── monitor.ts       # Order book monitoring
│   │   └── mirror.ts        # Mirroring logic
│   ├── workers/             # Background jobs
│   │   ├── position-monitor.ts  # Track maker positions
│   │   └── rebalance.ts     # Auto-rebalance orders
│   ├── db/                  # Database layer
│   │   ├── schema.ts        # Prisma schema
│   │   └── queries.ts       # Database queries
│   └── utils/               # Shared utilities
├── tests/                   # Jest tests
├── docs/                    # Additional documentation
│   ├── api-integration.md   # DeepBook API patterns
│   └── deployment.md        # Deployment guide
├── Move.toml                # Sui Move package manifest
├── package.json             # Node.js dependencies
└── DEEPMIRROR_RESEARCH_REPORT.md  # Comprehensive research
```

See @DEEPMIRROR_RESEARCH_REPORT.md for complete project background, technical analysis, and development roadmap.

## Key Technical Decisions

### Sui-Specific Patterns

- **Object Model**: Store user positions as owned objects (not shared) for parallel transaction processing
- **Custodian Accounts**: Each user has a DeepBook `AccountCap` (capability object) for order authorization
- **Programmable Transaction Blocks (PTBs)**: Chain operations (swap → deposit → place_order) in single transactions for atomicity
- **Event Subscriptions**: Use WebSocket subscriptions to Sui RPC for real-time `OrderPlaced`, `OrderFilled` events
- **Gas Optimization**: Batch multiple users' orders in one PTB when copying same maker (reduces per-user gas cost)

### DeepBook Integration

- Always use latest DeepBook SDK (`@mysten/deepbook` or embedded in `@mysten/sui`)
- Place limit orders via `deepbook::place_limit_order()` with explicit price-time priority
- Track maker positions by subscribing to pool-level events, not polling (more efficient)
- Stake DEEP tokens for users to reduce maker/taker fees (rebates up to 50%)
- Handle order cancellations gracefully: if maker cancels, cancel mirrored orders immediately

### Security Requirements

- NEVER hardcode private keys in source code (use environment variables with KMS/Vault in production)
- Store user wallet addresses and `AccountCap` IDs encrypted in database
- Validate all Telegram user inputs: wallet addresses (0x prefix, 32 bytes), amounts (positive numbers), pool IDs
- Rate limit bot commands: max 10 API calls per user per minute to prevent abuse
- Implement signature verification for wallet linking: user must sign message with Sui wallet to prove ownership
- Use parameterized queries for all database operations (prevent SQL injection)

## Important Gotchas

### Sui/DeepBook Specific

- **Clock Object**: DeepBook functions requiring timestamps need the singleton `Clock` object at `0x6`. Always pass it as argument.
- **AccountCap Ownership**: `AccountCap` must be owned by the signer of the transaction. Store object IDs in DB, fetch and use in PTBs.
- **Testnet Faucet Limits**: Sui testnet faucet is rate-limited. For heavy testing, use multiple test wallets or local node.
- **Object Versioning**: Objects have version numbers that increment on mutation. Stale object versions cause transaction failures—always fetch latest.
- **Gas Estimation**: DeepBook operations can be gas-heavy. Always set `--gas-budget` to at least 10,000,000 (0.01 SUI) for complex PTBs.

### Backend/Bot Specific

- **Telegram Message Length**: Telegram messages limited to 4096 characters. Split long position lists or use inline buttons for pagination.
- **WebSocket Reconnection**: Sui RPC WebSockets can disconnect. Implement exponential backoff retry logic (max 5 retries, then alert).
- **Database Transactions**: Wrap multi-step operations (e.g., create user + create AccountCap) in DB transactions for consistency.
- **Environment Variables**: Use `.env` for development, never commit. Production uses environment-specific configs (Railway/Heroku).
- **Time Zones**: All timestamps in database should be UTC. Convert to user's timezone only in UI/notifications.

### Known Issues

- Sui TypeScript SDK breaking changes between v1 and v2: ensure `@mysten/sui` version ≥2.0 for compatibility with DeepBook
- DEEP token staking contracts not yet integrated; feature planned for Phase 2 (see research report Section 9.2)
- Use context7 mcp tools to always refer to this doc: https://docs.sui.io/standards/deepbook for any information on deepbook v3

## Testing Strategy

### Unit Tests (Jest)

- Test all utility functions (validation, formatting, calculations) in isolation
- Mock Sui RPC responses using `jest.mock()` for predictable tests
- Test database queries against in-memory SQLite (fast, no external dependencies)
- Target 80% code coverage for services and utilities

### Integration Tests

- Use Sui testnet for end-to-end order placement tests
- Create dedicated test wallets with known private keys (only for testnet)
- Test Telegram bot commands via Bot API test mode (fake user interactions)
- Validate full user flow: link wallet → copy maker → order mirrors → withdrawal

### Move Tests

- Write unit tests for all public entry functions in `sources/*_tests.move`
- Test error cases: invalid amounts, unauthorized callers, insufficient balance
- Use `sui move test --coverage` to ensure >90% coverage of Move code
- Run tests in CI on every commit (GitHub Actions)

## Workflow & Git Conventions

<!-- ### Branch Naming

- `main`: Production-ready code (protected, requires PR)
- `develop`: Integration branch for features
- Feature branches: `feature/telegram-bot-commands`, `feature/deepbook-monitoring`
- Bug fixes: `fix/websocket-reconnection`, `fix/gas-estimation-error`
- Hotfixes: `hotfix/critical-security-patch`

### Commit Messages

Follow Conventional Commits:

- `feat: add /copy command handler for Telegram bot`
- `fix: resolve WebSocket disconnection issue in monitor`
- `docs: update README with setup instructions`
- `refactor: extract DeepBook SDK calls to service layer`
- `test: add unit tests for mirror logic`
- `chore: upgrade @mysten/sui to v2.1.0`

### Pull Requests

- Title format: `[Type] Brief description` (e.g., `[Feature] Implement order mirroring logic`)
- Include: Problem description, solution approach, testing done, screenshots (if UI)
- Required reviewers: At least 1 team member before merge
- CI checks must pass: lint, tests, Move contract compilation
- Squash merge to keep history clean -->

## Documentation Standards

### Code Comments

- Use JSDoc for all exported functions in TypeScript:
  ```typescript
  /**
   * Places a mirrored limit order on DeepBook based on maker's position.
   * @param userId - Telegram user ID
   * @param makerAddress - Sui address of the maker to mirror
   * @param pool - DeepBook pool ID
   * @param ratio - Percentage of maker position to mirror (0-100)
   * @returns Transaction digest on success
   */
  export async function mirrorOrder(...)
  ```
- Move functions: Document with inline comments above function signature
- Explain "why" in comments, not "what" (code should be self-explanatory)

### README Updates

- Keep root README.md updated with: setup instructions, architecture diagram, key features
- Add new sections when architecture changes (e.g., new modules, external integrations)
- Update command reference when new npm scripts added

### API Documentation

- Document all Telegram bot commands in `docs/bot-commands.md` with examples
- Document all DeepBook integration patterns in `docs/api-integration.md`
- Keep research report synced: update metrics, roadmap as project evolves

## Deployment & Operations

### Testnet Deployment

- Environment: Sui testnet (https://testnet.sui.io)
- Contracts: Deploy via `sui client publish --gas-budget 100000000 --network testnet`
- Backend: Host on Railway or Heroku free tier (for hackathon)
- Database: PostgreSQL on Railway (hobby tier)
- Secrets: Store in Railway environment variables, not `.env`

### Mainnet Readiness Checklist

- [ ] Smart contracts audited by MoveBit or OtterSec
- [ ] All environment secrets rotated (new RPC keys, bot token, DB password)
- [ ] Rate limiting implemented (10 req/min per user)
- [ ] Error handling covers all edge cases (tested in testnet)
- [ ] Backup strategy for database (automated daily snapshots)
- [ ] Legal terms of service published (disclaimers for automated trading)
- [ ] User onboarding guide and FAQs published

## External Resources

- **Sui Documentation**: https://docs.sui.io (Move, SDKs, RPC APIs)
- **DeepBook Docs**: https://docs.sui.io/standards/deepbook
- **DeepBook Tutorial**: https://hackmd.io/@moritzfelipe/sui-dacade-deepbook-tutorial-01 (working examples)
- **Sui TypeScript SDK**: https://sdk.mystenlabs.com/typescript
- **Telegraf.js Docs**: https://telegraf.js.org
- **Research Report**: See @DEEPMIRROR_RESEARCH_REPORT.md for comprehensive technical analysis, competitor research, and roadmap
