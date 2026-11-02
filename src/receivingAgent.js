// The worker side of the A2A pair: finishes a unit of work and presents
// payment conditions (what it expects to be paid, in which coin, to which
// address) to the paying agent. Chain/token details are the paying agent's
// merchant configuration, not the worker's say-so.

export class ReceivingAgent {
  constructor({ agentId, recipient, coin = 'USDC' }) {
    this.agentId = agentId;
    this.recipient = recipient;
    this.coin = coin;
  }

  presentPaymentConditions({ amountUsd, memo }) {
    if (!(Number(amountUsd) > 0)) throw new Error('amountUsd must be positive');
    return {
      from_agent: this.agentId,
      recipient: this.recipient,
      coin: this.coin,
      amountUsd: String(amountUsd),
      memo,
    };
  }
}
