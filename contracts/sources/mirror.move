/// DeepMirror Core Module
/// 
/// Production-ready module for managing liquidity mirroring positions on DeepBook V3.
/// This module manages user position state while the TypeScript backend handles
/// actual DeepBook order placement via the @mysten/deepbook-v3 SDK.
module deepmirror::mirror {
    use sui::event;
    use sui::clock::Clock;

    // ======== Error Codes ========
    
    const E_INVALID_RATIO: u64 = 1;
    const E_NOT_OWNER: u64 = 2;
    const E_POSITION_HAS_ORDERS: u64 = 3;
    const E_ORDER_NOT_FOUND: u64 = 4;
    #[allow(unused_const)]
    const E_INVALID_POOL: u64 = 5;
    const E_PAUSED: u64 = 6;
    #[allow(unused_const)]
    const E_NOT_ADMIN: u64 = 7;
    
    // ======== Constants ========
    
    /// Maximum mirror ratio (100%)
    const MAX_RATIO: u64 = 100;
    
    /// Minimum mirror ratio (1%)
    const MIN_RATIO: u64 = 1;

    // ======== Structs ========

    /// Admin capability for protocol management
    public struct AdminCap has key, store {
        id: UID,
    }

    /// Global protocol configuration
    public struct ProtocolConfig has key {
        id: UID,
        /// Protocol paused state
        paused: bool,
        /// Total positions created
        total_positions: u64,
        /// Total orders tracked
        total_orders: u64,
        /// Protocol version
        version: u64,
    }

    /// MirrorPosition - represents a user's liquidity mirroring configuration
    /// Owned by user for parallel execution
    public struct MirrorPosition has key, store {
        id: UID,
        /// Position owner
        owner: address,
        /// Target maker address being mirrored
        target_maker: address,
        /// Mirror ratio (1-100 representing percentage)
        ratio: u64,
        /// DeepBook pool ID being mirrored
        pool_id: ID,
        /// Active order IDs (managed by backend via SDK)
        active_orders: vector<u128>,
        /// Total orders placed for this position
        total_orders_placed: u64,
        /// Position creation timestamp
        created_at: u64,
        /// Last update timestamp
        updated_at: u64,
        /// Position active state
        active: bool,
    }

    // ======== Events ========

    /// Emitted when a new position is created
    public struct PositionCreated has copy, drop {
        position_id: ID,
        owner: address,
        target_maker: address,
        ratio: u64,
        pool_id: ID,
        timestamp: u64,
    }

    /// Emitted when position ratio is updated
    public struct PositionUpdated has copy, drop {
        position_id: ID,
        old_ratio: u64,
        new_ratio: u64,
        timestamp: u64,
    }

    /// Emitted when an order is recorded (placed via backend/SDK)
    public struct OrderRecorded has copy, drop {
        position_id: ID,
        order_id: u128,
        timestamp: u64,
    }

    /// Emitted when an order is removed
    public struct OrderRemoved has copy, drop {
        position_id: ID,
        order_id: u128,
        timestamp: u64,
    }

    /// Emitted when a position is activated/deactivated
    public struct PositionStatusChanged has copy, drop {
        position_id: ID,
        active: bool,
        timestamp: u64,
    }

    /// Emitted when a position is closed
    public struct PositionClosed has copy, drop {
        position_id: ID,
        owner: address,
        timestamp: u64,
    }

    /// Emitted when protocol is paused/unpaused
    public struct ProtocolPaused has copy, drop {
        paused: bool,
        timestamp: u64,
    }

    // ======== Initialization ========

    /// Initialize the module - creates admin cap and protocol config
    fun init(ctx: &mut tx_context::TxContext) {
        // Create admin capability
        let admin_cap = AdminCap {
            id: object::new(ctx),
        };
        
        // Create protocol config
        let config = ProtocolConfig {
            id: object::new(ctx),
            paused: false,
            total_positions: 0,
            total_orders: 0,
            version: 1,
        };
        
        transfer::share_object(config);
        transfer::transfer(admin_cap, ctx.sender());
    }

    // ======== Core Position Management ========

    /// Create a new mirror position
    /// 
    /// # Arguments
    /// * `config` - Protocol configuration
    /// * `target_maker` - Address of the maker to mirror
    /// * `ratio` - Mirror percentage (1-100)
    /// * `pool_id` - DeepBook pool ID
    /// * `clock` - Clock for timestamps
    /// * `ctx` - Transaction context
    /// 
    /// # Returns
    /// * MirrorPosition object owned by caller
    public fun create_position(
        config: &mut ProtocolConfig,
        target_maker: address,
        ratio: u64,
        pool_id: ID,
        clock: &Clock,
        ctx: &mut tx_context::TxContext,
    ): MirrorPosition {
        // Check protocol not paused
        assert!(!config.paused, E_PAUSED);
        
        // Validate ratio
        assert!(ratio >= MIN_RATIO && ratio <= MAX_RATIO, E_INVALID_RATIO);
        
        let owner = ctx.sender();
        let timestamp = clock.timestamp_ms();
        let position_id = object::new(ctx);
        let id_copy = position_id.to_inner();
        
        // Update protocol stats
        config.total_positions = config.total_positions + 1;
        
        let position = MirrorPosition {
            id: position_id,
            owner,
            target_maker,
            ratio,
            pool_id,
            active_orders: vector[],
            total_orders_placed: 0,
            created_at: timestamp,
            updated_at: timestamp,
            active: true,
        };

        event::emit(PositionCreated {
            position_id: id_copy,
            owner,
            target_maker,
            ratio,
            pool_id,
            timestamp,
        });

        position
    }

    /// Update position mirror ratio
    /// 
    /// # Arguments
    /// * `position` - Position to update
    /// * `new_ratio` - New mirror ratio (1-100)
    /// * `clock` - Clock for timestamps
    /// * `ctx` - Transaction context
    public fun update_ratio(
        position: &mut MirrorPosition,
        new_ratio: u64,
        clock: &Clock,
        ctx: &mut tx_context::TxContext,
    ) {
        assert!(ctx.sender() == position.owner, E_NOT_OWNER);
        assert!(new_ratio >= MIN_RATIO && new_ratio <= MAX_RATIO, E_INVALID_RATIO);
        
        let old_ratio = position.ratio;
        let timestamp = clock.timestamp_ms();
        
        position.ratio = new_ratio;
        position.updated_at = timestamp;
        
        event::emit(PositionUpdated {
            position_id: position.id.to_inner(),
            old_ratio,
            new_ratio,
            timestamp,
        });
    }

    /// Toggle position active status
    /// 
    /// # Arguments
    /// * `position` - Position to toggle
    /// * `clock` - Clock for timestamps
    /// * `ctx` - Transaction context
    public fun toggle_active(
        position: &mut MirrorPosition,
        clock: &Clock,
        ctx: &mut tx_context::TxContext,
    ) {
        assert!(ctx.sender() == position.owner, E_NOT_OWNER);
        
        let timestamp = clock.timestamp_ms();
        position.active = !position.active;
        position.updated_at = timestamp;
        
        event::emit(PositionStatusChanged {
            position_id: position.id.to_inner(),
            active: position.active,
            timestamp,
        });
    }

    // ======== Order Tracking (Called by Backend) ========

    /// Record a new order placement
    /// Called by backend after successfully placing order via DeepBook SDK
    /// 
    /// # Arguments
    /// * `config` - Protocol configuration
    /// * `position` - Position to update
    /// * `order_id` - DeepBook order ID
    /// * `clock` - Clock for timestamps
    /// * `ctx` - Transaction context
    public fun record_order(
        config: &mut ProtocolConfig,
        position: &mut MirrorPosition,
        order_id: u128,
        clock: &Clock,
        ctx: &mut tx_context::TxContext,
    ) {
        assert!(ctx.sender() == position.owner, E_NOT_OWNER);
        assert!(!config.paused, E_PAUSED);
        
        let timestamp = clock.timestamp_ms();
        
        vector::push_back(&mut position.active_orders, order_id);
        position.total_orders_placed = position.total_orders_placed + 1;
        position.updated_at = timestamp;
        
        config.total_orders = config.total_orders + 1;
        
        event::emit(OrderRecorded {
            position_id: position.id.to_inner(),
            order_id,
            timestamp,
        });
    }

    /// Remove an order from tracking
    /// Called by backend after order is filled/cancelled via DeepBook SDK
    /// 
    /// # Arguments
    /// * `position` - Position to update
    /// * `order_id` - DeepBook order ID to remove
    /// * `clock` - Clock for timestamps
    /// * `ctx` - Transaction context
    public fun remove_order(
        position: &mut MirrorPosition,
        order_id: u128,
        clock: &Clock,
        ctx: &mut tx_context::TxContext,
    ) {
        assert!(ctx.sender() == position.owner, E_NOT_OWNER);
        
        let (found, index) = position.active_orders.index_of(&order_id);
        assert!(found, E_ORDER_NOT_FOUND);
        
        let timestamp = clock.timestamp_ms();
        position.active_orders.remove(index);
        position.updated_at = timestamp;
        
        event::emit(OrderRemoved {
            position_id: position.id.to_inner(),
            order_id,
            timestamp,
        });
    }

    /// Clear all active orders
    /// Called by backend when cancelling all orders via DeepBook SDK
    /// 
    /// # Arguments
    /// * `position` - Position to clear
    /// * `clock` - Clock for timestamps
    /// * `ctx` - Transaction context
    public fun clear_orders(
        position: &mut MirrorPosition,
        clock: &Clock,
        ctx: &mut tx_context::TxContext,
    ) {
        assert!(ctx.sender() == position.owner, E_NOT_OWNER);
        
        let timestamp = clock.timestamp_ms();
        position.active_orders = vector[];
        position.updated_at = timestamp;
    }

    /// Close and delete a position
    /// Position must have no active orders
    /// 
    /// # Arguments
    /// * `position` - Position to close
    /// * `clock` - Clock for timestamps
    /// * `ctx` - Transaction context
    public fun close_position(
        position: MirrorPosition,
        clock: &Clock,
        ctx: &mut tx_context::TxContext,
    ) {
        assert!(ctx.sender() == position.owner, E_NOT_OWNER);
        assert!(position.active_orders.is_empty(), E_POSITION_HAS_ORDERS);
        
        let timestamp = clock.timestamp_ms();
        let position_id = position.id.to_inner();
        let owner = position.owner;
        
        event::emit(PositionClosed {
            position_id,
            owner,
            timestamp,
        });
        
        let MirrorPosition { id, .. } = position;
        
        id.delete();
    }

    // ======== Admin Functions ========

    /// Pause/unpause the protocol
    /// 
    /// # Arguments
    /// * `_admin_cap` - Admin capability
    /// * `config` - Protocol configuration
    /// * `paused` - New paused state
    /// * `clock` - Clock for timestamps
    public fun set_paused(
        _admin_cap: &AdminCap,
        config: &mut ProtocolConfig,
        paused: bool,
        clock: &Clock,
    ) {
        config.paused = paused;
        
        event::emit(ProtocolPaused {
            paused,
            timestamp: clock.timestamp_ms(),
        });
    }

    /// Upgrade protocol version
    /// 
    /// # Arguments
    /// * `_admin_cap` - Admin capability
    /// * `config` - Protocol configuration
    /// * `new_version` - New version number
    public fun set_version(
        _admin_cap: &AdminCap,
        config: &mut ProtocolConfig,
        new_version: u64,
    ) {
        config.version = new_version;
    }

    // ======== Getter Functions ========

    public fun owner(position: &MirrorPosition): address {
        position.owner
    }

    public fun target_maker(position: &MirrorPosition): address {
        position.target_maker
    }

    public fun ratio(position: &MirrorPosition): u64 {
        position.ratio
    }

    public fun pool_id(position: &MirrorPosition): ID {
        position.pool_id
    }

    public fun active_orders(position: &MirrorPosition): &vector<u128> {
        &position.active_orders
    }

    public fun active_order_count(position: &MirrorPosition): u64 {
        position.active_orders.length()
    }

    public fun total_orders_placed(position: &MirrorPosition): u64 {
        position.total_orders_placed
    }

    public fun created_at(position: &MirrorPosition): u64 {
        position.created_at
    }

    public fun updated_at(position: &MirrorPosition): u64 {
        position.updated_at
    }

    public fun is_active(position: &MirrorPosition): bool {
        position.active
    }

    public fun protocol_paused(config: &ProtocolConfig): bool {
        config.paused
    }

    public fun protocol_version(config: &ProtocolConfig): u64 {
        config.version
    }

    public fun total_positions(config: &ProtocolConfig): u64 {
        config.total_positions
    }

    public fun total_orders(config: &ProtocolConfig): u64 {
        config.total_orders
    }

    // ======== Test-only Functions ========
    
    #[test_only]
    public fun init_for_testing(ctx: &mut tx_context::TxContext) {
        init(ctx);
    }
}
