/**
 * Crypto Price & News Collector
 * Fetches real-time BTC/ETH/SOL/XRP/DOGE prices from Kalshi + crypto news
 * Stores in JSONL for historical tracking
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const kalshi = require("./kalshi-api");

const DATA_DIR = path.resolve(__dirname, "data", "crypto");
const PRICE_LOG = path.join(DATA_DIR, "prices.jsonl");
const NEWS_LOG = path.join(DATA_DIR, "news.jsonl");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CRYPTO_SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];

class CryptoCollector {
  constructor() {
    this.running = false;
    this.lastPrices = {};
    this.lastNews = [];
    this.pollInterval = null;
  }

  /**
   * Fetch crypto prices from Kalshi prediction markets
   */
  async fetchCryptoPrices() {
    try {
      // Fetch all crypto-related markets from Kalshi
      const res = await kalshi.getMarkets({ status: "open", limit: 500 });
      const markets = (res.data && res.data.markets) || [];

      const prices = {};
      const now = new Date().toISOString();

      // Single pass over markets, bucketing by symbol, instead of re-scanning the
      // whole (up to 500-market) list once per symbol (#1890).
      const bySymbol = {};
      for (const s of CRYPTO_SYMBOLS) bySymbol[s] = [];
      for (const m of markets) {
        const title = (m.title || "").toUpperCase();
        for (const symbol of CRYPTO_SYMBOLS) {
          if (title.includes(symbol)) bySymbol[symbol].push(m);
        }
      }

      for (const symbol of CRYPTO_SYMBOLS) {
        const cryptoMarkets = bySymbol[symbol];

        if (cryptoMarkets.length > 0) {
          // Get soonest market for this crypto (highest conviction)
          const soonest = cryptoMarkets.reduce((prev, current) => {
            const prevClose = new Date(prev.close_time).getTime();
            const currClose = new Date(current.close_time).getTime();
            return currClose < prevClose ? current : prev;
          });

          const yesAsk = soonest.yes_ask || 0;
          const noAsk = soonest.no_ask || 0;
          const spread = Math.abs(yesAsk - noAsk);

          prices[symbol] = {
            symbol,
            timestamp: now,
            yes_ask: yesAsk,
            no_ask: noAsk,
            spread,
            title: soonest.title,
            close_time: soonest.close_time,
            volume: soonest.volume_fp || soonest.volume || 0,
            open_interest: soonest.open_interest_fp || soonest.open_interest || 0,
          };
        }
      }

      // Log to JSONL
      if (Object.keys(prices).length > 0) {
        const logEntry = JSON.stringify({ timestamp: now, prices });
        fs.appendFileSync(PRICE_LOG, logEntry + "\n");
        this.lastPrices = prices;
      }

      return prices;
    } catch (e) {
      console.error("[CryptoCollector] Price fetch error:", e.message);
      return {};
    }
  }

  /**
   * Fetch crypto news from CoinGecko API (free, no auth)
   */
  async fetchCryptoNews() {
    try {
      const news = [];
      const now = new Date().toISOString();

      // Simple news aggregation from CoinGecko trending endpoint
      // (Alternative: NewsAPI, Cryptopanic, or custom RSS feeds)
      const coingeckoUrl =
        "https://api.coingecko.com/api/v3/search/trending";

      const data = await new Promise((resolve, reject) => {
        https
          .get(coingeckoUrl, { timeout: 5000 }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(e);
              }
            });
          })
          .on("error", reject);
      });

      // Extract trending coins as news
      if (data.coins && Array.isArray(data.coins)) {
        data.coins.slice(0, 10).forEach((coin, idx) => {
          news.push({
            timestamp: now,
            type: "trending",
            source: "coingecko",
            symbol: coin.item.symbol?.toUpperCase(),
            name: coin.item.name,
            rank: idx + 1,
            market_cap_rank: coin.item.market_cap_rank,
            data_type: coin.item.data?.market_cap ? "high_volume" : "trending",
          });
        });
      }

      // Log to JSONL
      if (news.length > 0) {
        news.forEach((item) => {
          fs.appendFileSync(NEWS_LOG, JSON.stringify(item) + "\n");
        });
        this.lastNews = news;
      }

      return news;
    } catch (e) {
      console.error("[CryptoCollector] News fetch error:", e.message);
      return [];
    }
  }

  /**
   * Start collecting crypto data at regular intervals
   */
  start(intervalMs = 30000) {
    if (this.running) return;
    this.running = true;

    console.log("[CryptoCollector] Starting (interval: " + intervalMs + "ms)");

    // Fetch immediately
    this.fetchCryptoPrices();
    this.fetchCryptoNews();

    // Then poll at interval
    this.pollInterval = setInterval(() => {
      this.fetchCryptoPrices();
      this.fetchCryptoNews();
    }, intervalMs);
  }

  /**
   * Stop collecting
   */
  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.running = false;
    console.log("[CryptoCollector] Stopped");
  }

  /**
   * Get latest prices
   */
  getLatestPrices() {
    return this.lastPrices;
  }

  /**
   * Get latest news
   */
  getLatestNews() {
    return this.lastNews;
  }

  /**
   * Get historical prices (last N entries)
   */
  getHistoricalPrices(limit = 100) {
    try {
      if (!fs.existsSync(PRICE_LOG)) return [];
      const lines = fs
        .readFileSync(PRICE_LOG, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      return lines
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }
}

module.exports = CryptoCollector;
