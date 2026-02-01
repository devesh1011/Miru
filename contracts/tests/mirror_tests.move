#[test_only]
module deepmirror::mirror_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::clock::{Self, Clock};
    
    use deepmirror::mirror::{Self, MirrorPosition, AdminCap, ProtocolConfig};

    // Test addresses
    const ADMIN: address = @0xAD;
    const USER1: address = @0xB1;
    const USER2: address = @0xB2;
    const MAKER1: address = @0xC1;
    const MAKER2: address = @0xC2;

    fun setup_test(scenario: &mut Scenario): Clock {
        ts::next_tx(scenario, ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(scenario));
        clock::increment_for_testing(&mut clock, 1000);
        clock
    }

    #[test]
    fun test_init_creates_config_and_admin_cap() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        
        ts::next_tx(scenario, ADMIN);
        {
            assert!(ts::has_most_recent_for_sender<AdminCap>(scenario), 0);
        };
        
        ts::next_tx(scenario, ADMIN);
        {
            let config = ts::take_shared<ProtocolConfig>(scenario);
            assert!(!mirror::protocol_paused(&config), 1);
            assert!(mirror::protocol_version(&config) == 1, 2);
            assert!(mirror::total_positions(&config) == 0, 3);
            assert!(mirror::total_orders(&config) == 0, 4);
            ts::return_shared(config);
        };
        
        ts::end(scenario_val);
    }

    #[test]
    fun test_create_position_success() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            
            let position = mirror::create_position(
                &mut config,
                MAKER1,
                50,
                pool_id,
                &clock,
                ts::ctx(scenario)
            );
            
            assert!(mirror::owner(&position) == USER1, 0);
            assert!(mirror::target_maker(&position) == MAKER1, 1);
            assert!(mirror::ratio(&position) == 50, 2);
            assert!(mirror::pool_id(&position) == pool_id, 3);
            assert!(mirror::active_order_count(&position) == 0, 4);
            assert!(mirror::is_active(&position), 5);
            assert!(mirror::total_positions(&config) == 1, 6);
            
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    #[expected_failure(abort_code = mirror::E_INVALID_RATIO)]
    fun test_create_position_invalid_ratio_zero() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            
            let position = mirror::create_position(
                &mut config,
                MAKER1,
                0, // Invalid
                pool_id,
                &clock,
                ts::ctx(scenario)
            );
            
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    #[expected_failure(abort_code = mirror::E_INVALID_RATIO)]
    fun test_create_position_invalid_ratio_over_100() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            
            let position = mirror::create_position(
                &mut config,
                MAKER1,
                101, // Invalid
                pool_id,
                &clock,
                ts::ctx(scenario)
            );
            
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    fun test_update_ratio() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            let position = mirror::create_position(&mut config, MAKER1, 50, pool_id, &clock, ts::ctx(scenario));
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        ts::next_tx(scenario, USER1);
        {
            let mut position = ts::take_from_sender<MirrorPosition>(scenario);
            mirror::update_ratio(&mut position, 75, &clock, ts::ctx(scenario));
            assert!(mirror::ratio(&position) == 75, 0);
            ts::return_to_sender(scenario, position);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    fun test_toggle_active() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            let position = mirror::create_position(&mut config, MAKER1, 50, pool_id, &clock, ts::ctx(scenario));
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        ts::next_tx(scenario, USER1);
        {
            let mut position = ts::take_from_sender<MirrorPosition>(scenario);
            assert!(mirror::is_active(&position), 0);
            
            mirror::toggle_active(&mut position, &clock, ts::ctx(scenario));
            assert!(!mirror::is_active(&position), 1);
            
            mirror::toggle_active(&mut position, &clock, ts::ctx(scenario));
            assert!(mirror::is_active(&position), 2);
            
            ts::return_to_sender(scenario, position);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    fun test_record_and_remove_order() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            let position = mirror::create_position(&mut config, MAKER1, 50, pool_id, &clock, ts::ctx(scenario));
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let mut position = ts::take_from_sender<MirrorPosition>(scenario);
            
            mirror::record_order(&mut config, &mut position, 12345u128, &clock, ts::ctx(scenario));
            assert!(mirror::active_order_count(&position) == 1, 0);
            assert!(mirror::total_orders_placed(&position) == 1, 1);
            assert!(mirror::total_orders(&config) == 1, 2);
            
            mirror::record_order(&mut config, &mut position, 67890u128, &clock, ts::ctx(scenario));
            assert!(mirror::active_order_count(&position) == 2, 3);
            
            mirror::remove_order(&mut position, 12345u128, &clock, ts::ctx(scenario));
            assert!(mirror::active_order_count(&position) == 1, 4);
            
            ts::return_to_sender(scenario, position);
            ts::return_shared(config);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    fun test_clear_orders() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            let position = mirror::create_position(&mut config, MAKER1, 50, pool_id, &clock, ts::ctx(scenario));
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let mut position = ts::take_from_sender<MirrorPosition>(scenario);
            
            mirror::record_order(&mut config, &mut position, 1u128, &clock, ts::ctx(scenario));
            mirror::record_order(&mut config, &mut position, 2u128, &clock, ts::ctx(scenario));
            mirror::record_order(&mut config, &mut position, 3u128, &clock, ts::ctx(scenario));
            assert!(mirror::active_order_count(&position) == 3, 0);
            
            mirror::clear_orders(&mut position, &clock, ts::ctx(scenario));
            assert!(mirror::active_order_count(&position) == 0, 1);
            
            ts::return_to_sender(scenario, position);
            ts::return_shared(config);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    fun test_close_position() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            let position = mirror::create_position(&mut config, MAKER1, 50, pool_id, &clock, ts::ctx(scenario));
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        ts::next_tx(scenario, USER1);
        {
            let position = ts::take_from_sender<MirrorPosition>(scenario);
            mirror::close_position(position, &clock, ts::ctx(scenario));
        };
        
        ts::next_tx(scenario, USER1);
        {
            assert!(!ts::has_most_recent_for_sender<MirrorPosition>(scenario), 0);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    #[expected_failure(abort_code = mirror::E_POSITION_HAS_ORDERS)]
    fun test_close_position_with_active_orders_fails() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            let position = mirror::create_position(&mut config, MAKER1, 50, pool_id, &clock, ts::ctx(scenario));
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let mut position = ts::take_from_sender<MirrorPosition>(scenario);
            mirror::record_order(&mut config, &mut position, 12345u128, &clock, ts::ctx(scenario));
            
            // This should fail
            mirror::close_position(position, &clock, ts::ctx(scenario));
            ts::return_shared(config);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    fun test_admin_pause_unpause() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, ADMIN);
        {
            let admin_cap = ts::take_from_sender<AdminCap>(scenario);
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            
            assert!(!mirror::protocol_paused(&config), 0);
            
            mirror::set_paused(&admin_cap, &mut config, true, &clock);
            assert!(mirror::protocol_paused(&config), 1);
            
            mirror::set_paused(&admin_cap, &mut config, false, &clock);
            assert!(!mirror::protocol_paused(&config), 2);
            
            ts::return_to_sender(scenario, admin_cap);
            ts::return_shared(config);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }

    #[test]
    #[expected_failure(abort_code = mirror::E_PAUSED)]
    fun test_create_position_when_paused_fails() {
        let mut scenario_val = ts::begin(ADMIN);
        let scenario = &mut scenario_val;
        
        mirror::init_for_testing(ts::ctx(scenario));
        let clock = setup_test(scenario);
        
        ts::next_tx(scenario, ADMIN);
        {
            let admin_cap = ts::take_from_sender<AdminCap>(scenario);
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            mirror::set_paused(&admin_cap, &mut config, true, &clock);
            ts::return_to_sender(scenario, admin_cap);
            ts::return_shared(config);
        };
        
        ts::next_tx(scenario, USER1);
        {
            let mut config = ts::take_shared<ProtocolConfig>(scenario);
            let pool_id = object::id_from_address(@0x123);
            
            // This should fail
            let position = mirror::create_position(&mut config, MAKER1, 50, pool_id, &clock, ts::ctx(scenario));
            
            transfer::public_transfer(position, USER1);
            ts::return_shared(config);
        };
        
        clock::destroy_for_testing(clock);
        ts::end(scenario_val);
    }
}
