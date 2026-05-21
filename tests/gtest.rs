use app::{Outcome, PredictionMarketStorage};
use sails_rs::prelude::*;

// gtest re-exports
use sails_rs::gtest::{Program, System};

// Load the program wasm built by build.rs
const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/wasm32-unknown-unknown/release/hy4_predict.opt.wasm"
));

const RESOLVER: u64 = 10;
const BETTOR_A: u64 = 11;
const BETTOR_B: u64 = 12;

fn init_system() -> System {
    let system = System::new();
    system.init_logger();
    system.mint_to(RESOLVER, 100_000_000_000_000);
    system.mint_to(BETTOR_A, 100_000_000_000_000);
    system.mint_to(BETTOR_B, 100_000_000_000_000);
    system
}

#[test]
fn create_market_works() {
    let system = init_system();
    let program = Program::from_binary_with_id(&system, 1, WASM);

    // init
    let res = program.send(RESOLVER, ());
    assert!(!res.main_failed());

    // create market
    let res = program.send(
        RESOLVER,
        ("PredictionMarket", "CreateMarket", "Will BTC hit 100k?", "Yes", "No"),
    );
    assert!(!res.main_failed());
}

#[test]
fn full_market_lifecycle() {
    let system = init_system();
    let program = Program::from_binary_with_id(&system, 1, WASM);
    program.send(RESOLVER, ());

    // create
    program.send(
        RESOLVER,
        ("PredictionMarket", "CreateMarket", "Will agent-arena hit 50 integrations?", "Yes", "No"),
    );

    // place bets
    let one_vara = 1_000_000_000_000u128;
    program.send_with_value(BETTOR_A, ("PredictionMarket", "PlaceBet", 0u64, Outcome::A), one_vara);
    program.send_with_value(BETTOR_B, ("PredictionMarket", "PlaceBet", 0u64, Outcome::B), one_vara * 3);

    // resolve — outcome A wins
    program.send(RESOLVER, ("PredictionMarket", "ResolveMarket", 0u64, Outcome::A));

    // bettor A claims: staked 1, total pool 4, winning pool 1 → payout = 4
    program.send(BETTOR_A, ("PredictionMarket", "ClaimWinnings", 0u64));
}
