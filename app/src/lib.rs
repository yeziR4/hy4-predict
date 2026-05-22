#![no_std]

use sails_rs::{
    cell::RefCell,
    collections::BTreeMap,
    gstd::{exec, msg},
    prelude::*,
};

// ── Shared Types ─────────────────────────────────────────────────────────────

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

// ── PredictionMarket Types ────────────────────────────────────────────────────

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

// ── FastMarket Types ──────────────────────────────────────────────────────────
//
// FastMarkets auto-resolve by price comparison:
//   open_price_micro_usd  = price at creation (micro-USD, from varabridge)
//   close_price_micro_usd = price at resolution (micro-USD, from varabridge)
//   close > open  → Outcome::A wins ("Higher")
//   close <= open → Outcome::B wins ("Lower or Same")
//
// Anyone may call ResolveFastMarket once block_height >= resolve_after_block.
// Callers should fetch close_price from varabridge before calling.

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct FastMarket {
    pub id: MarketId,
    /// Human-readable question, e.g. "Will BTC be higher in 50 blocks?"
    pub question: String,
    /// Price symbol as used by varabridge, e.g. "BTC", "ETH", "SOL"
    pub symbol: String,
    /// Opening price in micro-USD (price_usd_micro from VaraBridge/GetPrice)
    pub open_price_micro_usd: u128,
    /// Closing price set at resolution
    pub close_price_micro_usd: Option<u128>,
    /// Block at or after which anyone can call ResolveFastMarket
    pub resolve_after_block: u32,
    pub status: MarketStatus,
    /// A = Higher (close > open), B = Lower or Same (close <= open)
    pub winning_outcome: Option<Outcome>,
    pub pool_a: u128,
    pub pool_b: u128,
}

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum FastMarketEvent {
    FastMarketCreated {
        market_id: MarketId,
        question: String,
        symbol: String,
        open_price_micro_usd: u128,
        resolve_after_block: u32,
    },
    FastBetPlaced {
        market_id: MarketId,
        bettor: ActorId,
        outcome: Outcome,
        amount: u128,
    },
    FastMarketResolved {
        market_id: MarketId,
        symbol: String,
        open_price_micro_usd: u128,
        close_price_micro_usd: u128,
        winning_outcome: Outcome,
    },
    FastWinningsClaimed {
        market_id: MarketId,
        bettor: ActorId,
        amount: u128,
    },
}

// ── Storage ───────────────────────────────────────────────────────────────────

pub struct PredictionMarketStorage {
    // Classic markets
    markets: BTreeMap<MarketId, Market>,
    bets: BTreeMap<(MarketId, ActorId), (Outcome, u128)>,
    next_market_id: u64,
    // Fast markets
    fast_markets: BTreeMap<MarketId, FastMarket>,
    fast_bets: BTreeMap<(MarketId, ActorId), (Outcome, u128)>,
    next_fast_market_id: u64,
}

impl PredictionMarketStorage {
    pub fn new() -> Self {
        Self {
            markets: BTreeMap::new(),
            bets: BTreeMap::new(),
            next_market_id: 0,
            fast_markets: BTreeMap::new(),
            fast_bets: BTreeMap::new(),
            next_fast_market_id: 0,
        }
    }
}

// ── PredictionMarket Service ──────────────────────────────────────────────────

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
    #[export]
    pub fn place_bet(&mut self, market_id: MarketId, outcome: Outcome) {
        let amount = msg::value();
        let bettor = msg::source();
        assert!(amount > 0, "Bet amount must be > 0");

        let mut storage = self.storage.borrow_mut();

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

            bet_amount.saturating_mul(total_pool) / winning_pool
        };

        drop(storage);

        msg::send_bytes(bettor, b"", payout).expect("Failed to send winnings");

        self.emit_event(PredictionMarketEvent::WinningsClaimed {
            market_id,
            bettor,
            amount: payout,
        })
        .expect("Failed to emit WinningsClaimed");
    }

    #[export]
    pub fn market(&self, market_id: MarketId) -> Option<Market> {
        self.storage.borrow().markets.get(&market_id).cloned()
    }

    #[export]
    pub fn bet(&self, market_id: MarketId, bettor: ActorId) -> Option<(Outcome, u128)> {
        self.storage
            .borrow()
            .bets
            .get(&(market_id, bettor))
            .cloned()
    }
}

// ── FastMarket Service ────────────────────────────────────────────────────────

pub struct FastMarketService<'a> {
    storage: &'a RefCell<PredictionMarketStorage>,
}

impl<'a> FastMarketService<'a> {
    pub fn new(storage: &'a RefCell<PredictionMarketStorage>) -> Self {
        Self { storage }
    }
}

#[service(events = FastMarketEvent)]
impl FastMarketService<'_> {
    /// Create a fast market with automatic price-based resolution.
    ///
    /// `open_price_micro_usd` — fetch from `VaraBridge/GetPrice(symbol).price_usd_micro`
    ///   before calling this method.
    /// `duration_blocks` — blocks until anyone may resolve (50 ≈ 5 minutes on Vara).
    ///
    /// Returns the new market_id.
    #[export]
    pub fn create_fast_market(
        &mut self,
        question: String,
        symbol: String,
        open_price_micro_usd: u128,
        duration_blocks: u32,
    ) -> MarketId {
        assert!(duration_blocks >= 1, "duration_blocks must be >= 1");
        assert!(open_price_micro_usd > 0, "open_price must be > 0");

        let resolve_after_block = exec::block_height()
            .checked_add(duration_blocks)
            .expect("Block overflow");
        let mut storage = self.storage.borrow_mut();

        let market_id = storage.next_fast_market_id;
        storage.next_fast_market_id += 1;

        storage.fast_markets.insert(
            market_id,
            FastMarket {
                id: market_id,
                question: question.clone(),
                symbol: symbol.clone(),
                open_price_micro_usd,
                close_price_micro_usd: None,
                resolve_after_block,
                status: MarketStatus::Open,
                winning_outcome: None,
                pool_a: 0,
                pool_b: 0,
            },
        );

        drop(storage);

        self.emit_event(FastMarketEvent::FastMarketCreated {
            market_id,
            question,
            symbol,
            open_price_micro_usd,
            resolve_after_block,
        })
        .expect("Failed to emit FastMarketCreated");

        market_id
    }

    /// Place a bet. Outcome::A = "Higher", Outcome::B = "Lower or Same".
    /// Betting closes once exec::block_height() >= resolve_after_block.
    #[export]
    pub fn place_fast_bet(&mut self, market_id: MarketId, outcome: Outcome) {
        let amount = msg::value();
        let bettor = msg::source();
        assert!(amount > 0, "Bet amount must be > 0");

        let mut storage = self.storage.borrow_mut();

        {
            let market = storage
                .fast_markets
                .get_mut(&market_id)
                .expect("FastMarket not found");
            assert!(
                matches!(market.status, MarketStatus::Open),
                "FastMarket is not open"
            );
            assert!(
                exec::block_height() < market.resolve_after_block,
                "Betting period has ended — market is in resolution window"
            );
            match &outcome {
                Outcome::A => market.pool_a += amount,
                Outcome::B => market.pool_b += amount,
            }
        }

        if let Some(existing) = storage.fast_bets.get_mut(&(market_id, bettor)) {
            assert!(
                existing.0 == outcome,
                "Cannot switch outcome after first bet"
            );
            existing.1 += amount;
        } else {
            storage
                .fast_bets
                .insert((market_id, bettor), (outcome.clone(), amount));
        }

        drop(storage);

        self.emit_event(FastMarketEvent::FastBetPlaced {
            market_id,
            bettor,
            outcome,
            amount,
        })
        .expect("Failed to emit FastBetPlaced");
    }

    /// Resolve a fast market. Callable by ANYONE after resolve_after_block.
    ///
    /// `close_price_micro_usd` — fetch from `VaraBridge/GetPrice(symbol).price_usd_micro`
    ///   immediately before calling this method.
    ///
    /// Resolution is automatic:
    ///   close > open  → Outcome::A ("Higher") wins
    ///   close <= open → Outcome::B ("Lower or Same") wins
    #[export]
    pub fn resolve_fast_market(&mut self, market_id: MarketId, close_price_micro_usd: u128) {
        assert!(close_price_micro_usd > 0, "close_price must be > 0");

        let mut storage = self.storage.borrow_mut();

        let market = storage
            .fast_markets
            .get_mut(&market_id)
            .expect("FastMarket not found");

        assert!(
            matches!(market.status, MarketStatus::Open),
            "FastMarket already resolved"
        );
        assert!(
            exec::block_height() >= market.resolve_after_block,
            "Resolution window not reached yet"
        );

        let winning_outcome = if close_price_micro_usd > market.open_price_micro_usd {
            Outcome::A // "Higher"
        } else {
            Outcome::B // "Lower or Same"
        };

        let open_price = market.open_price_micro_usd;
        let symbol = market.symbol.clone();

        market.status = MarketStatus::Resolved;
        market.close_price_micro_usd = Some(close_price_micro_usd);
        market.winning_outcome = Some(winning_outcome.clone());

        drop(storage);

        self.emit_event(FastMarketEvent::FastMarketResolved {
            market_id,
            symbol,
            open_price_micro_usd: open_price,
            close_price_micro_usd,
            winning_outcome,
        })
        .expect("Failed to emit FastMarketResolved");
    }

    /// Claim proportional winnings from the losing pool.
    #[export]
    pub fn claim_fast_winnings(&mut self, market_id: MarketId) {
        let bettor = msg::source();
        let mut storage = self.storage.borrow_mut();

        let (bet_outcome, bet_amount) = storage
            .fast_bets
            .remove(&(market_id, bettor))
            .expect("No fast bet found or already claimed");

        let payout = {
            let market = storage
                .fast_markets
                .get(&market_id)
                .expect("FastMarket not found");

            let winning_outcome = market
                .winning_outcome
                .clone()
                .expect("FastMarket not resolved yet");

            assert!(
                bet_outcome == winning_outcome,
                "You bet on the losing outcome"
            );

            let total_pool = market.pool_a + market.pool_b;
            let winning_pool = match &winning_outcome {
                Outcome::A => market.pool_a,
                Outcome::B => market.pool_b,
            };

            bet_amount.saturating_mul(total_pool) / winning_pool
        };

        drop(storage);

        msg::send_bytes(bettor, b"", payout).expect("Failed to send fast winnings");

        self.emit_event(FastMarketEvent::FastWinningsClaimed {
            market_id,
            bettor,
            amount: payout,
        })
        .expect("Failed to emit FastWinningsClaimed");
    }

    /// Query a fast market by id.
    #[export]
    pub fn fast_market(&self, market_id: MarketId) -> Option<FastMarket> {
        self.storage
            .borrow()
            .fast_markets
            .get(&market_id)
            .cloned()
    }

    /// Query a bettor's position on a fast market.
    #[export]
    pub fn fast_bet(&self, market_id: MarketId, bettor: ActorId) -> Option<(Outcome, u128)> {
        self.storage
            .borrow()
            .fast_bets
            .get(&(market_id, bettor))
            .cloned()
    }

    /// Returns the current on-chain block height. Useful for callers to check
    /// how many blocks remain before a market can be resolved.
    #[export]
    pub fn current_block(&self) -> u32 {
        exec::block_height()
    }
}

// ── Program ───────────────────────────────────────────────────────────────────

pub struct Program(RefCell<PredictionMarketStorage>);

#[program]
impl Program {
    pub fn new() -> Self {
        Self(RefCell::new(PredictionMarketStorage::new()))
    }

    pub fn prediction_market(&self) -> PredictionMarketService<'_> {
        PredictionMarketService::new(&self.0)
    }

    pub fn fast_market(&self) -> FastMarketService<'_> {
        FastMarketService::new(&self.0)
    }
}
