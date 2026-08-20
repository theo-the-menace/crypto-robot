const DECIMAL = /^\d+(?:\.\d+)?$/;
const UNSUPPORTED_RISK = /杠杆|全仓|逐仓|合约|永续|期货|融资|借贷|margin|futures|perpetual|leverage|\b\d+x\b/i;

export function hasUnsupportedRiskInstruction(message) { return UNSUPPORTED_RISK.test(String(message || '')); }

export function inferProduct(message) {
  const text = String(message || '');
  if (/合约|永续|期货|futures|perpetual|\b\d+x\b/i.test(text)) return 'futures';
  if (/杠杆现货|借币|还款|margin/i.test(text)) return 'margin';
  return 'spot';
}

function decimal(value, name) {
  const text = String(value ?? '');
  if (!DECIMAL.test(text) || Number(text) <= 0) throw new Error(`${name} must be a positive decimal.`);
  return text;
}

export function normalizeOrderIntent(raw, { allowedSymbols = ['BTCUSDT', 'ETHUSDT'] } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('The model did not return a trade intent.');
  const symbol = String(raw.symbol || '').toUpperCase();
  const side = String(raw.side || '').toUpperCase();
  const type = String(raw.type || 'MARKET').toUpperCase();
  if (Array.isArray(allowedSymbols) && !allowedSymbols.includes(symbol)) throw new Error(`${symbol || 'This symbol'} is not in the trading allowlist.`);
  if (!['BUY', 'SELL'].includes(side)) throw new Error('Order side must be BUY or SELL.');
  if (!['MARKET', 'LIMIT'].includes(type)) throw new Error('Only MARKET and LIMIT spot orders are supported.');
  const intent = { symbol, side, type };
  if (type === 'LIMIT') {
    intent.quantity = decimal(raw.quantity, 'quantity');
    intent.price = decimal(raw.price, 'price');
    intent.timeInForce = 'GTC';
  } else if (side === 'BUY') {
    intent.quoteOrderQty = decimal(raw.quoteOrderQty, 'quoteOrderQty');
  } else {
    intent.quantity = decimal(raw.quantity, 'quantity');
  }
  return intent;
}

function filter(symbolInfo, type) {
  return symbolInfo.filters?.find((item) => item.filterType === type);
}

function isStepAligned(value, step) {
  if (Number(step) === 0) return true;
  const scale = Math.max((value.split('.')[1] || '').length, (step.split('.')[1] || '').length);
  const factor = 10 ** scale;
  return Math.round(Number(value) * factor) % Math.round(Number(step) * factor) === 0;
}

export function validateOrder(intent, { symbolInfo, ticker, balances = [], maxOrderUsdt = 100 }) {
  if (!symbolInfo || symbolInfo.status !== 'TRADING' || !symbolInfo.isSpotTradingAllowed) throw new Error(`${intent.symbol} is not available for spot trading.`);
  if (symbolInfo.quoteAsset !== 'USDT') throw new Error('This version only supports USDT-quoted spot pairs.');
  const price = intent.type === 'LIMIT' ? Number(intent.price) : Number(intent.side === 'BUY' ? ticker.askPrice : ticker.bidPrice);
  const baseQuantity = intent.quantity ? Number(intent.quantity) : Number(intent.quoteOrderQty) / price;
  const notional = intent.quoteOrderQty ? Number(intent.quoteOrderQty) : baseQuantity * price;
  if (!Number.isFinite(price) || price <= 0) throw new Error('A current executable price is unavailable.');
  if (maxOrderUsdt > 0 && notional > maxOrderUsdt) throw new Error(`Order value ${notional.toFixed(2)} USDT exceeds the ${maxOrderUsdt} USDT limit.`);
  const lot = filter(symbolInfo, intent.type === 'MARKET' ? 'MARKET_LOT_SIZE' : 'LOT_SIZE') || filter(symbolInfo, 'LOT_SIZE');
  if (intent.quantity && lot) {
    if (Number(intent.quantity) < Number(lot.minQty) || Number(intent.quantity) > Number(lot.maxQty) || !isStepAligned(intent.quantity, lot.stepSize)) throw new Error(`Quantity must match Binance lot size (${lot.minQty} to ${lot.maxQty}, step ${lot.stepSize}).`);
  }
  const minNotional = filter(symbolInfo, 'NOTIONAL')?.minNotional || filter(symbolInfo, 'MIN_NOTIONAL')?.minNotional;
  if (minNotional && notional < Number(minNotional)) throw new Error(`Order value must be at least ${minNotional} USDT.`);
  const available = Object.fromEntries(balances.map((item) => [item.asset, Number(item.free)]));
  if (intent.side === 'BUY' && available[symbolInfo.quoteAsset] !== undefined && notional > available[symbolInfo.quoteAsset]) throw new Error(`Insufficient ${symbolInfo.quoteAsset} balance.`);
  if (intent.side === 'SELL' && available[symbolInfo.baseAsset] !== undefined && baseQuantity > available[symbolInfo.baseAsset]) throw new Error(`Insufficient ${symbolInfo.baseAsset} balance.`);
  return { estimatedPrice: price, estimatedNotional: notional, baseQuantity, baseAsset: symbolInfo.baseAsset, quoteAsset: symbolInfo.quoteAsset };
}

export function fallbackIntent(text) {
  const normalized = String(text || '').trim().toUpperCase().replace(/,/g, '');
  const symbol = normalized.match(/\b(BTC|ETH)(?:\/)?USDT\b/)?.[0]?.replace('/', '') || (normalized.includes('BTC') ? 'BTCUSDT' : normalized.includes('ETH') ? 'ETHUSDT' : null);
  const side = /(?:买|买入|BUY)/u.test(normalized) ? 'BUY' : /(?:卖|卖出|SELL)/u.test(normalized) ? 'SELL' : null;
  if (!symbol || !side) return null;
  const number = normalized.match(/(\d+(?:\.\d+)?)\s*(USDT|U|BTC|ETH)?/);
  if (!number) return null;
  const amount = number[1];
  const unit = number[2];
  if (side === 'BUY' && (!unit || unit === 'USDT' || unit === 'U')) return { symbol, side, type: 'MARKET', quoteOrderQty: amount };
  if (side === 'SELL' && unit === symbolInfoBase(symbol)) return { symbol, side, type: 'MARKET', quantity: amount };
  return null;
}

function symbolInfoBase(symbol) { return symbol.replace(/USDT$/, ''); }

export function tradePrompt(message, symbols) {
  return `You are a spot-order intent parser, not an investment adviser. Interpret the user's latest message. Never invent an amount, symbol, side, or price. Only support ${symbols.join(', ')} and MARKET/LIMIT spot orders. If any required field is missing, set intent to null and ask one concise clarification question in the user's language. Return JSON only: {"reply":"...","intent":null} or {"reply":"...","intent":{"symbol":"BTCUSDT","side":"BUY","type":"MARKET","quoteOrderQty":"100"}}. MARKET BUY requires quoteOrderQty in USDT; MARKET SELL requires base-asset quantity; LIMIT requires quantity and price. User message: ${JSON.stringify(String(message).slice(0, 2000))}`;
}

export function multiProductTradePrompt(message, symbols) {
  return `Parse one Binance trade request into JSON. Products: spot, margin, futures. Never invent missing values. Supported symbols: ${symbols.join(', ')}. Futures requires symbol, BUY/SELL, MARKET, quantity, integer leverage 1-125, and marginType ISOLATED or CROSSED. Margin requires symbol, BUY/SELL, MARKET, quantity or quoteOrderQty, and marginType. Spot uses the normal MARKET/LIMIT schema. Return {"reply":"...","product":"spot|margin|futures","intent":null} when incomplete, otherwise return the same object with intent. The user must confirm later; never claim an order was executed. User message: ${JSON.stringify(String(message).slice(0, 2000))}`;
}
