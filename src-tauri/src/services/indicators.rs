//! Technical-analysis indicators computed locally from OHLCV candlesticks.
//!
//! All functions are pure (no I/O, no network) and operate on a slice of
//! [`PriceCandle`]s assumed to be sorted **ascending by date** (oldest first).
//! They return the indicator series aligned to the input length — the first
//! `period - 1` slots are `None` where the window is not yet full.

use crate::models::PriceCandle;

/// Simple moving average over `period` closing prices.
///
/// Returns a vector the same length as the input; entries before the window is
/// full are `None`.
pub fn sma(candles: &[PriceCandle], period: usize) -> Vec<Option<f64>> {
    if period == 0 || candles.len() < period {
        return vec![None; candles.len()];
    }
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let mut out = vec![None; candles.len()];
    let mut sum: f64 = closes[..period].iter().sum();
    out[period - 1] = Some(sum / period as f64);
    for i in period..candles.len() {
        sum += closes[i] - closes[i - period];
        out[i] = Some(sum / period as f64);
    }
    out
}

/// Exponential moving average over `period` samples.
///
/// Uses the standard smoothing factor `k = 2 / (period + 1)`, seeded with the
/// SMA of the first `period` values.
pub fn ema(values: &[f64], period: usize) -> Vec<Option<f64>> {
    if period == 0 || values.len() < period {
        return vec![None; values.len()];
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut out = vec![None; values.len()];
    let seed: f64 = values[..period].iter().sum::<f64>() / period as f64;
    out[period - 1] = Some(seed);
    let mut prev = seed;
    for i in period..values.len() {
        prev = values[i] * k + prev * (1.0 - k);
        out[i] = Some(prev);
    }
    out
}

/// A MACD result row: DIF (fast−slow EMA), DEA (signal line), and the
/// histogram (DIF − DEA).
#[derive(Debug, Clone, Copy)]
pub struct MacdPoint {
    pub dif: Option<f64>,
    pub dea: Option<f64>,
    pub histogram: Option<f64>,
}

/// MACD(fast=12, slow=26, signal=9) over the closing prices.
///
/// Returns one [`MacdPoint`] per candle. DIF and DEA are `None` until their
/// respective EMAs are available.
pub fn macd(candles: &[PriceCandle], fast: usize, slow: usize, signal: usize) -> Vec<MacdPoint> {
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let ema_fast = ema(&closes, fast);
    let ema_slow = ema(&closes, slow);

    // DIF = EMA(fast) - EMA(slow), defined once both EMAs exist.
    let mut dif: Vec<Option<f64>> = vec![None; candles.len()];
    for i in 0..candles.len() {
        if let (Some(f), Some(s)) = (ema_fast[i], ema_slow[i]) {
            dif[i] = Some(f - s);
        }
    }

    // DEA = EMA(DIF, signal). EMA needs raw f64s, so feed it the defined DIF
    // values starting from the first Some. Build a contiguous slice.
    let first_dif = dif.iter().position(Option::is_some);
    let mut dea: Vec<Option<f64>> = vec![None; candles.len()];
    if let Some(start) = first_dif {
        let dif_values: Vec<f64> = dif[start..]
            .iter()
            .map(|d| d.expect("DIF is Some from `start` onward"))
            .collect();
        let dea_computed = ema(&dif_values, signal);
        for (idx, v) in dea_computed.iter().enumerate() {
            dea[start + idx] = *v;
        }
    }

    dif.iter()
        .zip(dea.iter())
        .map(|(d, e)| MacdPoint {
            dif: *d,
            dea: *e,
            histogram: match (d, e) {
                (Some(dv), Some(ev)) => Some(dv - ev),
                _ => None,
            },
        })
        .collect()
}

/// Relative Strength Index using Wilder's smoothing over `period` (typically 14).
///
/// Returns a vector aligned to the candles; the first `period` entries are
/// `None` (the RSI needs `period + 1` prices to produce its first value, which
/// lands at index `period`).
pub fn rsi(candles: &[PriceCandle], period: usize) -> Vec<Option<f64>> {
    let n = candles.len();
    if period == 0 || n <= period {
        return vec![None; n];
    }
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let mut out = vec![None; n];

    // Average gains/losses over the first `period` intervals.
    let mut gain = 0.0;
    let mut loss = 0.0;
    for i in 1..=period {
        let diff = closes[i] - closes[i - 1];
        if diff >= 0.0 {
            gain += diff;
        } else {
            loss -= diff;
        }
    }
    let mut avg_gain = gain / period as f64;
    let mut avg_loss = loss / period as f64;
    out[period] = Some(rsi_value(avg_gain, avg_loss));

    // Wilder smoothing for the rest.
    for i in (period + 1)..n {
        let diff = closes[i] - closes[i - 1];
        let chg_gain = if diff >= 0.0 { diff } else { 0.0 };
        let chg_loss = if diff < 0.0 { -diff } else { 0.0 };
        avg_gain = (avg_gain * (period as f64 - 1.0) + chg_gain) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + chg_loss) / period as f64;
        out[i] = Some(rsi_value(avg_gain, avg_loss));
    }
    out
}

fn rsi_value(avg_gain: f64, avg_loss: f64) -> f64 {
    if avg_loss == 0.0 {
        100.0
    } else {
        let rs = avg_gain / avg_loss;
        100.0 - 100.0 / (1.0 + rs)
    }
}

/// A Bollinger-band reading at a single point in time.
#[derive(Debug, Clone, Copy)]
pub struct BollingerPoint {
    /// Middle band = SMA(period).
    pub middle: Option<f64>,
    pub upper: Option<f64>,
    pub lower: Option<f64>,
}

/// Bollinger bands: SMA(period) ± `multiplier` × population stdev.
///
/// Uses the population standard deviation (÷ N) which matches the common
/// charting convention for the default `(20, 2)` parameters.
pub fn bollinger(candles: &[PriceCandle], period: usize, multiplier: f64) -> Vec<BollingerPoint> {
    let mid = sma(candles, period);
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let n = candles.len();
    let mut out = vec![
        BollingerPoint {
            middle: None,
            upper: None,
            lower: None
        };
        n
    ];
    if period == 0 || n < period {
        return out;
    }
    for i in (period - 1)..n {
        let window = &closes[i + 1 - period..=i];
        let mean = mid[i].unwrap_or(0.0);
        let variance: f64 = window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / period as f64;
        let sd = variance.sqrt();
        out[i] = BollingerPoint {
            middle: Some(mean),
            upper: Some(mean + multiplier * sd),
            lower: Some(mean - multiplier * sd),
        };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candle(date: &str, close: f64) -> PriceCandle {
        PriceCandle {
            date: date.to_string(),
            open: close,
            close,
            high: close,
            low: close,
            volume: 100.0,
        }
    }

    #[test]
    fn sma_basic() {
        let c = (1..=5)
            .map(|i| candle(&format!("d{i}"), i as f64))
            .collect::<Vec<_>>();
        let m = sma(&c, 3);
        assert_eq!(m[..2], [None, None]);
        assert!((m[2].unwrap() - 2.0).abs() < 1e-9); // (1+2+3)/3
        assert!((m[3].unwrap() - 3.0).abs() < 1e-9); // (2+3+4)/3
        assert!((m[4].unwrap() - 4.0).abs() < 1e-9); // (3+4+5)/3
    }

    #[test]
    fn sma_too_short() {
        let c = vec![candle("a", 1.0)];
        assert!(sma(&c, 3).iter().all(Option::is_none));
    }

    #[test]
    fn ema_seeds_with_sma() {
        let c = (1..=6)
            .map(|i| candle(&format!("d{i}"), i as f64))
            .collect::<Vec<_>>();
        let e = ema(&[1.0, 2.0, 3.0], 3);
        // First EMA equals SMA of first 3 = 2.0
        assert!((e[2].unwrap() - 2.0).abs() < 1e-9);
        let _ = c; // silence unused
    }

    #[test]
    fn rsi_all_up_is_100() {
        let c = (1..=16)
            .map(|i| candle(&format!("d{i}"), i as f64))
            .collect::<Vec<_>>();
        let r = rsi(&c, 14);
        assert!(r[..14].iter().all(Option::is_none));
        assert!((r[14].unwrap() - 100.0).abs() < 1e-9);
    }

    #[test]
    fn rsi_all_down_is_0() {
        let c = (1..=16)
            .map(|i| candle(&format!("d{i}"), 16.0 - i as f64))
            .collect::<Vec<_>>();
        let r = rsi(&c, 14);
        assert!((r[14].unwrap() - 0.0).abs() < 1e-9);
    }

    #[test]
    fn bollinger_middle_equals_sma() {
        let c = (1..=20)
            .map(|i| candle(&format!("d{i}"), i as f64))
            .collect::<Vec<_>>();
        let b = bollinger(&c, 20, 2.0);
        let mid = b[19].middle.unwrap();
        let expected: f64 = (1..=20).map(|i| i as f64).sum::<f64>() / 20.0;
        assert!((mid - expected).abs() < 1e-9);
        // upper > middle > lower
        assert!(b[19].upper.unwrap() > mid);
        assert!(b[19].lower.unwrap() < mid);
    }

    #[test]
    fn macd_produces_histogram() {
        let c = (1..=40)
            .map(|i| candle(&format!("d{i}"), 100.0 + (i as f64).sin() * 5.0))
            .collect::<Vec<_>>();
        let m = macd(&c, 12, 26, 9);
        // DIF appears at index 25 (slow-1), DEA at 25 + 9 - 1 = 33.
        assert!(m[25].dif.is_some());
        assert!(m[33].dea.is_some());
        assert!(m[39].histogram.is_some());
        // histogram == dif - dea where both exist
        if let (Some(d), Some(e)) = (m[39].dif, m[39].dea) {
            assert!((m[39].histogram.unwrap() - (d - e)).abs() < 1e-9);
        }
    }
}
