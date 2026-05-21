#![no_std]

use sails_rs::{cell::RefCell, collections::BTreeMap, gstd::msg, prelude::*};

// ── Types ────────────────────────────────────────────────────────────────────

pub type MarketId = u64;

#[derive(Clone, Debug, PartialEq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Outcome {
    A,
    B,
}

#[derive(Clone, Debug, PartialEq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum MarketStatus {
    Open,
    Resolved,
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Market {
    pub question: String,
    pub outcome_a: String,
    pub outcome_b: String,
    pub resolver: ActorId,
    pub status: MarketStatus,
    pub winning_outcome: Option<Outcome>,
    pub pool_a: u128,
    pub pool_b: u128,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum PredictionMarketEvent {
    MarketCreated {
        market_id: MarketId,
        question: String,
        outcome_a: String,
        outcome_b: String,
        resolver: ActorId,
    },
    BetPlaced {
        market_id: MarketId,
        bettor: ActorId,
        outcome: Outcome,
        amount: u128,
    },
    MarketResolved {
        market_id: MarketId,
        winning_outcome: Outcome,
    },
    WinningsClaimed {
        market_id: MarketId,
        bettor: ActorId,
        amount: u128,
    },
}

// ── Storage ──────────────────────────────────────────────────────────────────

pub struct PredictionMarketStorage {
    markets: BTreeMap<MarketId, Market>,
    // key: (market_id, bettor) → (outcome chosen, total staked)
    bets: BTreeMap<(MarketId, ActorId), (Outcome, u128)>,
    next_market_id: u64,
}

impl PredictionMarketStorage {
    pub fn new() -> Self {
        Self {
            markets: BTreeMap::new(),
            bets: BTreeMap::new(),
            next_market_id: 0,
        }
    }
}

// ── Service ──────────────────────────────────────────────────────────────────

pub struct PredictionMarketService<'a> {
    storage: &'a RefCell<PredictionMarketStorage>,
}

impl<'a> PredictionMarketService<'a> {
    pub fn new(storage: &'a RefCell<PredictionMarketStorage>) -> Self {
        Self { storage }
    }
}

#[service(events = PredictionMarketEvent)]
impl PredictionMarketService<'_> {
    /// Create a new binary market. The caller becomes the resolver.
    /// Returns the new market's id.
    #[export]
    pub fn create_market(
        &mut self,
        question: String,
        outcome_a: String,
        outcome_b: String,
    ) -> MarketId {
        let resolver = msg::source();
        let mut storage = self.storage.borrow_mut();

        let market_id = storage.next_market_id;
        storage.next_market_id += 1;

        storage.markets.insert(
            market_id,
            Market {
                question: question.clone(),
                outcome_a: outcome_a.clone(),
                outcome_b: outcome_b.clone(),
                resolver,
                status: MarketStatus::Open,
                winning_outcome: None,
                pool_a: 0,
                pool_b: 0,
            },
        );

        drop(storage);

        self.emit_event(PredictionMarketEvent::MarketCreated {
            market_id,
            question,
            outcome_a,
            outcome_b,
            resolver,
        })
        .expect("Failed to emit MarketCreated");

        market_id
    }

    /// Place a bet on an outcome. Stake = msg::value() in planck.
    /// A bettor may accumulate stake on the same outcome; switching outcome panics.
    #[export]
    pub fn place_bet(&mut self, market_id: MarketId, outcome: Outcome) {
        let amount = msg::value();
        let bettor = msg::source();
        assert!(amount > 0, "Bet amount must be > 0");

        let mut storage = self.storage.borrow_mut();

        // validate + update pool (scoped borrow so bets can be accessed next)
        {
            let market = storage
                .markets
                .get_mut(&market_id)
                .expect("Market not found");
            assert!(
                matches!(market.status, MarketStatus::Open),
                "Market is not open"
            );
            match &outcome {
                Outcome::A => market.pool_a += amount,
                Outcome::B => market.pool_b += amount,
            }
        }

        // record or accumulate bet
        if let Some(existing) = storage.bets.get_mut(&(market_id, bettor)) {
            assert!(
                existing.0 == outcome,
                "Cannot switch outcome after first bet"
            );
            existing.1 += amount;
        } else {
            storage
                .bets
                .insert((market_id, bettor), (outcome.clone(), amount));
        }

        drop(storage);

        self.emit_event(PredictionMarketEvent::BetPlaced {
            market_id,
            bettor,
            outcome,
            amount,
        })
        .expect("Failed to emit BetPlaced");
    }

    /// Resolve a market. Only callable by the resolver set at creation.
    #[export]
    pub fn resolve_market(&mut self, market_id: MarketId, winning_outcome: Outcome) {
        let caller = msg::source();
        let mut storage = self.storage.borrow_mut();

        let market = storage
            .markets
            .get_mut(&market_id)
            .expect("Market not found");

        assert_eq!(market.resolver, caller, "Only the resolver can resolve");
        assert!(
            matches!(market.status, MarketStatus::Open),
            "Market already resolved"
        );

        market.status = MarketStatus::Resolved;
        market.winning_outcome = Some(winning_outcome.clone());

        drop(storage);

        self.emit_event(PredictionMarketEvent::MarketResolved {
            market_id,
            winning_outcome,
        })
        .expect("Failed to emit MarketResolved");
    }

    /// Claim proportional winnings from the losing pool.
    /// Payout = stake * total_pool / winning_pool. Burns the bet record.
    #[export]
    pub fn claim_winnings(&mut self, market_id: MarketId) {
        let bettor = msg::source();
        let mut storage = self.storage.borrow_mut();

        let (bet_outcome, bet_amount) = storage
            .bets
            .remove(&(market_id, bettor))
            .expect("No bet found or already claimed");

        let payout = {
            let market = storage
                .markets
                .get(&market_id)
                .expect("Market not found");

            let winning_outcome = market
                .winning_outcome
                .clone()
                .expect("Market not resolved yet");

            assert!(
                bet_outcome == winning_outcome,
                "You bet on the losing outcome"
            );

            let total_pool = market.pool_a + market.pool_b;
            let winning_pool = match &winning_outcome {
                Outcome::A => market.pool_a,
                Outcome::B => market.pool_b,
            };

            // proportional share: stake * total / winning_pool
            bet_amount.saturating_mul(total_pool) / winning_pool
        };

        drop(storage);

        // Transfer payout from program balance to bettor
        msg::send_bytes(bettor, b"", payout).expect("Failed to send winnings");

        self.emit_event(PredictionMarketEvent::WinningsClaimed {
            market_id,
            bettor,
            amount: payout,
        })
        .expect("Failed to emit WinningsClaimed");
    }

    // ── Queries ──────────────────────────────────────────────────────────────

    /// Read market state (query, no gas for off-chain calls).
    #[export]
    pub fn market(&self, market_id: MarketId) -> Option<Market> {
        self.storage.borrow().markets.get(&market_id).cloned()
    }

    /// Read a bettor's position on a market.
    #[export]
    pub fn bet(&self, market_id: MarketId, bettor: ActorId) -> Option<(Outcome, u128)> {
        self.storage
            .borrow()
            .bets
            .get(&(market_id, bettor))
            .cloned()
    }
}

// ── Program ──────────────────────────────────────────────────────────────────

pub struct Program(RefCell<PredictionMarketStorage>);

#[program]
impl Program {
    pub fn new() -> Self {
        Self(RefCell::new(PredictionMarketStorage::new()))
    }

    pub fn prediction_market(&self) -> PredictionMarketService<'_> {
        PredictionMarketService::new(&self.0)
    }
}

// Wasm entry-point module is auto-generated by the #[program] macro above.
