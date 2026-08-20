import { randomUUID } from 'node:crypto';

export class EmergencyPolicy {
  constructor({ budgetFraction = 0.2, grantMs = 30 * 60_000, cooldownMs = 15 * 60_000, now = () => Date.now() } = {}) {
    if (!(budgetFraction > 0 && budgetFraction <= 1)) throw new Error('Emergency budget fraction must be between 0 and 1.');
    this.budgetFraction = budgetFraction;
    this.grantMs = grantMs;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.pending = null;
    this.grant = null;
    this.audit = [];
  }

  trigger({ item, equity }) {
    if (!item?.id || item.urgency !== 'breaking') throw new Error('Only breaking news can trigger emergency mode.');
    if (!(Number.isFinite(equity) && equity > 0)) throw new Error('A positive account equity is required.');
    const now = this.now();
    if (this.grant && now < this.grant.expiresAt) return { state: 'granted', grant: this.publicGrant() };
    if (this.pending && now - this.pending.createdAt < this.cooldownMs) return { state: 'pending', pending: this.pending };
    this.pending = { id: randomUUID(), newsId: item.id, title: item.title, createdAt: now, equity, budget: equity * this.budgetFraction };
    this.audit.push({ type: 'triggered', at: now, pendingId: this.pending.id, newsId: item.id });
    return { state: 'pending', pending: this.pending };
  }

  confirm({ confirmation, allowLeverage = false, maxLeverage = 1 }) {
    if (confirmation !== 'CONFIRM') throw new Error('Explicit emergency confirmation is required.');
    if (!this.pending) throw new Error('No emergency authorization is pending.');
    if (!(Number.isFinite(maxLeverage) && maxLeverage >= 1 && maxLeverage <= 3)) throw new Error('Max leverage must be between 1x and 3x.');
    const now = this.now();
    this.grant = { id: randomUUID(), newsId: this.pending.newsId, issuedAt: now, expiresAt: now + this.grantMs, budget: this.pending.budget, remaining: this.pending.budget, actions: ['BUY', 'SELL'], assets: '*', allowLeverage: Boolean(allowLeverage), maxLeverage };
    this.audit.push({ type: 'confirmed', at: now, grantId: this.grant.id, newsId: this.pending.newsId });
    this.pending = null;
    return this.publicGrant();
  }

  consume({ grantId, notional }) {
    const grant = this.grant;
    if (!grant || grant.id !== grantId || this.now() >= grant.expiresAt) throw new Error('Emergency authorization is missing or expired.');
    if (!(Number.isFinite(notional) && notional > 0) || notional > grant.remaining) throw new Error('Emergency budget exceeded.');
    grant.remaining -= notional;
    this.audit.push({ type: 'consumed', at: this.now(), grantId, notional, remaining: grant.remaining });
    return this.publicGrant();
  }

  revoke(reason = 'manual') {
    if (!this.grant) return false;
    this.audit.push({ type: 'revoked', at: this.now(), grantId: this.grant.id, reason });
    this.grant = null;
    return true;
  }

  status() {
    if (this.grant && this.now() >= this.grant.expiresAt) this.grant = null;
    return { pending: this.pending, grant: this.publicGrant(), audit: this.audit.slice(-50) };
  }

  publicGrant() {
    if (!this.grant) return null;
    const { id, newsId, issuedAt, expiresAt, budget, remaining, actions, assets, allowLeverage, maxLeverage } = this.grant;
    return { id, newsId, issuedAt, expiresAt, budget, remaining, actions, assets, allowLeverage, maxLeverage };
  }
}
