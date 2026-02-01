---
name: sui-move-defi
description: Develops secure Move smart contracts for Sui blockchain DeFi applications, with focus on object-oriented design, parallel transaction execution, and integrations like DeepBook for liquidity provision. Use when writing Move modules, handling Sui objects (owned or shared), implementing CLOB-based liquidity strategies, adapting AMM patterns to limit orders, or building hackathon prototypes involving impermanent loss monitoring and automated position copying.
---

## Overview

This Skill provides structured guidance for Move contract development on Sui. Assume familiarity with basic programming; focus on Sui-specific patterns to avoid common pitfalls like object contention or unsafe resource handling. For detailed Sui docs, reference external resources on-demand (e.g., "See Sui Move Book for advanced types").

Key principles:

- Use resource-oriented design: Treat assets as owned objects to enable parallelism and prevent double-spending.
- Prioritize security: Employ capabilities for authorization; avoid shared objects in high-contention scenarios.
- Optimize for DeFi: Leverage DeepBook's CLOB for limit order liquidity over traditional AMM pools.
- Degrees of freedom: Follow templates for core structures; adapt for project-specific logic (e.g., copy-LP mirroring in volatile memecoin markets).

If content exceeds needs, use progressive disclosure: Reference separate files like examples/deepbook-integration.md or templates/liquidity-module.md in a full repo setup.

## Instructions

### Quick Start: Setting Up a Move Module

1. Create a new package: Use `sui move new my_package` in CLI.
2. Define module basics: Start with a skeleton including dependencies (e.g., sui::object, deepbook::clob_v2).
3. Build and test: Run `sui move build` and `sui move test`.
4. Deploy: Use `sui client publish` on testnet for hackathon demos.

For DeFi focus:

- Import DeepBook: `use deepbook::clob_v2::{Self, Pool, Order};`
- Handle objects: Use `sui::object::new(ctx)` for owned objects; minimize shared for performance.

Common pitfalls to avoid:

- No global state: Prefer object storage to prevent bottlenecks.
- Error handling: Use `abort` with codes; validate inputs early.
- No unexplained constants: Justify values (e.g., MIN_ORDER_SIZE = 100_000; // Based on DeepBook min tick size for fee efficiency).

## Workflows

### DeFi Contract Development Workflow

Copy this checklist and track progress in your agent session:

Task Progress:

- [ ] Step 1: Define requirements (e.g., mirror LP positions: input top provider orders, output scaled user orders).
- [ ] Step 2: Plan module structure (structs for positions, functions for create/mirror/close).
- [ ] Step 3: Write core logic (use templates below; integrate DeepBook for order placement).
- [ ] Step 4: Add security (capabilities for auth; validate against IL thresholds).
- [ ] Step 5: Test locally (sui move test; simulate CLOB interactions).
- [ ] Step 6: Validate and iterate (run on testnet; check parallelism with multiple txns).
- [ ] Step 7: Document and demo (add comments; prepare for hackathon submission).

**Step 1: Define Requirements**  
Outline user stories: e.g., "As a liquidity provider, I want to copy top orders to earn fees without manual monitoring."

**Step 2: Plan Structure**  
Sketch: One module per feature (e.g., liquidity_mirror.move). Decide owned vs. shared: Use owned for user positions to enable fast, parallel updates.

**Feedback Loop:** After Step 3, validate code with `sui move build`. If errors, fix and repeat.

For complex integrations (e.g., real-time copying), reference advanced patterns in a separate file like workflows/real-time-monitoring.md.

## Templates

### Basic Move Module Template

Use this strict skeleton for new modules; adapt imports and logic as needed.

```move
module my_package::liquidity_mirror {
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;
    use deepbook::clob_v2::{Self, Pool};

    // Structs
    struct MirrorPosition has key, store {
        id: UID,
        base_asset: u64,  // Amount for bids/asks
        quote_asset: u64,
        // Add IL threshold: e.g., max_il: u64 = 5_000; // 5% max loss, justified by volatile market tolerance
    }

    // Capabilities for auth
    struct AdminCap has key { id: UID }

    // Functions
    public fun create_position(pool: &mut Pool, base: u64, quote: u64, ctx: &mut TxContext): MirrorPosition {
        let id = object::new(ctx);
        MirrorPosition { id, base_asset: base, quote_asset: quote }
    }

    public fun mirror_order(pool: &mut Pool, top_order: &Order, scale: u64, cap: &AdminCap, ctx: &mut TxContext) {
        // Logic: Scale top_order amounts by user capital; place limit order via clob_v2::place_order
        // Validate: abort if scale > 100 (full copy limit for risk control)
    }

    // Entry for user calls
    entry fun entry_mirror(pool: &mut Pool, top_id: u64, scale: u64, ctx: &mut TxContext) {
        // Fetch top_order by ID; call mirror_order with checks
    }
}
```

### Function Template: Liquidity Operation

Flexible template for operations like closing positions; customize parameters.

```move
public fun close_position(position: &mut MirrorPosition, pool: &mut Pool, ctx: &mut TxContext) {
    // Withdraw assets via clob_v2::withdraw
    // Calculate IL: (current_value - initial_value) / initial_value * 100
    // If IL > threshold, emit event for monitoring
}
```

## Examples

### Example 1: Simple Position Creation

Input: Create a mirrored LP position for a memecoin pool with 1000 base and 500 quote.

Output:

```move
let position = create_position(pool, 1000, 500, ctx);
// Expected: Owned object stored in sender's address for parallel access
```

### Example 2: Mirroring a Top Order

Input: Mirror a top bid order (price: 1.0, amount: 100) scaled by 50% for user.

Output:

```move
let top_order = clob_v2::get_order(pool, order_id);
mirror_order(pool, &top_order, 50, &admin_cap, ctx);
// Places new order: price 1.0, amount 50; aborts if slippage > 0.5% (justified by fast market volatility)
```

For more examples, in a full setup, see examples/deepbook-copy-lp.md.

## Additional Tips

- Dependencies: Always import from official Sui/DeepBook modules; verify versions (e.g., DeepBook v3 for CLOB v2).
- Testing: Use Move's unit tests with `#[test]`; simulate failures (e.g., insufficient balance).
- Hackathon Focus: Emphasize minimal on-chain logic; offload monitoring to backend for demo speed.
- Iteration: If code fails, diagnose (e.g., "Object not found? Check UID creation"); refine based on Sui CLI output.
