import type { Kysely } from 'kysely';
import { addBusinessDays, civilOf, isBusinessDay, minutesOfDay } from '../../domain/calendar.js';
import type { DistributionPayload } from '../../domain/types.js';
import { US_FEDERAL_HOLIDAYS } from '../../jurisdictions/calendars.js';
import { isValidCcc, isValidCik } from '../../jurisdictions/identifiers.js';
import { GatewayError, type Clock, type PublishAck, type PublishGateway } from '../../ports/index.js';
import type { DB } from '../db/schema.js';

/**
 * How a mock newswire misbehaves, stored in the shared settings table so the UI (api process)
 * can steer the gateway the worker process calls.
 *  - transient: fail the next N submits with a 503
 *  - permanent: reject every submit (EDGAR "suspense" / RNS rejection)
 *  - ack_lost: accept the release, then time out before the ack comes back, N times
 */
export interface Chaos {
  mode: 'ok' | 'transient' | 'permanent' | 'ack_lost';
  failuresRemaining?: number;
  latencyMs?: number;
}

export const chaosKey = (channel: string) => `gateway:${channel}`;
const SEQUENCE_RETRIES = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

abstract class MockGateway implements PublishGateway {
  constructor(
    protected readonly db: Kysely<DB>,
    protected readonly clock: Clock,
    readonly channel: string,
  ) {}

  /** Receipt rules of the external system; throws a permanent GatewayError on rejection. */
  protected abstract check(payload: DistributionPayload): void;
  protected abstract receipt(payload: DistributionPayload, seq: number, now: Date): Omit<PublishAck, 'acceptedAt'>;

  async find(idempotencyKey: string): Promise<PublishAck | null> {
    const r = await this.db
      .selectFrom('ext_receipts')
      .selectAll()
      .where('channel', '=', this.channel)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (!r) return null;
    return {
      externalRef: r.external_ref,
      acceptedAt: r.accepted_at,
      ...(r.filing_date && { filingDate: r.filing_date }),
      detail: JSON.parse(r.detail),
    };
  }

  async submit({ idempotencyKey, payload }: { idempotencyKey: string; payload: DistributionPayload }): Promise<PublishAck> {
    const chaos = await this.chaos();
    if (chaos.latencyMs) await sleep(chaos.latencyMs);

    // Real wires dedupe on their own: a replay returns the original receipt, never a second release.
    const existing = await this.find(idempotencyKey);
    if (existing) return existing;

    if (chaos.mode === 'permanent') {
      throw new GatewayError('permanent', 'GATEWAY_REJECTED', `${this.channel.toUpperCase()} rejected the submission (simulated)`);
    }
    if (chaos.mode === 'transient' && (await this.consumeFailure(chaos))) {
      throw new GatewayError('transient', 'GATEWAY_UNAVAILABLE', `${this.channel.toUpperCase()} returned 503 (simulated)`);
    }
    this.check(payload);

    const ack = await this.record(idempotencyKey, payload);
    if (chaos.mode === 'ack_lost' && (await this.consumeFailure(chaos))) {
      throw new GatewayError('transient', 'ACK_TIMEOUT', `${this.channel.toUpperCase()} accepted the release but the acknowledgement timed out (simulated)`);
    }
    return ack;
  }

  /** A real wire numbers releases itself; here that is a unique sequence, retried on collision. */
  private async record(idempotencyKey: string, payload: DistributionPayload): Promise<PublishAck> {
    for (let attempt = 0; attempt < SEQUENCE_RETRIES; attempt++) {
      const now = this.clock.now();
      const last = await this.db
        .selectFrom('ext_receipts')
        .select('seq')
        .where('channel', '=', this.channel)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      const r = this.receipt(payload, (last?.seq ?? 0) + 1, now);
      try {
        await this.db
          .insertInto('ext_receipts')
          .values({
            channel: this.channel,
            seq: (last?.seq ?? 0) + 1,
            idempotency_key: idempotencyKey,
            external_ref: r.externalRef,
            accepted_at: now.toISOString(),
            filing_date: r.filingDate ?? null,
            detail: JSON.stringify(r.detail),
          })
          .execute();
        return { ...r, acceptedAt: now.toISOString() };
      } catch {
        // Lost the sequence number to a concurrent release, or this key was accepted meanwhile.
        const accepted = await this.find(idempotencyKey);
        if (accepted) return accepted;
      }
    }
    throw new GatewayError('transient', 'GATEWAY_BUSY', 'Concurrent submission, retry');
  }

  private async chaos(): Promise<Chaos> {
    const row = await this.db.selectFrom('settings').select('value').where('key', '=', chaosKey(this.channel)).executeTakeFirst();
    return row ? (JSON.parse(row.value) as Chaos) : { mode: 'ok' };
  }

  private async consumeFailure(chaos: Chaos): Promise<boolean> {
    const left = chaos.failuresRemaining ?? 1;
    if (left <= 0) return false;
    const next: Chaos = { ...chaos, failuresRemaining: left - 1 };
    await this.db
      .insertInto('settings')
      .values({ key: chaosKey(this.channel), value: JSON.stringify(next) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(next) }))
      .execute();
    return true;
  }
}

const RNS_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export class MockRnsGateway extends MockGateway {
  constructor(db: Kysely<DB>, clock: Clock) {
    super(db, clock, 'rns');
  }

  protected check(p: DistributionPayload): void {
    const a = p.attributes;
    if (!a.tidm || !a.lei || !p.content.trim()) {
      throw new GatewayError('permanent', 'RNS_REJECTED', 'RNS requires TIDM, LEI and content');
    }
  }

  protected receipt(p: DistributionPayload, seq: number): Omit<PublishAck, 'acceptedAt'> {
    const rnsNumber = `${String(seq).padStart(4, '0')}${RNS_LETTERS[seq % RNS_LETTERS.length]}`;
    return { externalRef: rnsNumber, detail: { service: 'RNS', rnsNumber, tidm: p.attributes.tidm, headline: p.headline } };
  }
}

export class MockEdgarGateway extends MockGateway {
  constructor(db: Kysely<DB>, clock: Clock) {
    super(db, clock, 'edgar');
  }

  protected check(p: DistributionPayload): void {
    const a = p.attributes;
    const items = Array.isArray(a.items) ? a.items : [];
    if (!isValidCik(String(a.cik)) || !isValidCcc(String(a.ccc))) {
      throw new GatewayError('permanent', 'EDGAR_SUSPENDED', 'Suspended: invalid CIK or CIK Confirmation Code');
    }
    if (a.formType !== '8-K' || items.length === 0) {
      throw new GatewayError('permanent', 'EDGAR_SUSPENDED', 'Suspended: Form 8-K needs at least one item');
    }
    if (items.includes('2.02') && !p.attachments.some((x) => x.type === 'EX-99.1')) {
      throw new GatewayError('permanent', 'EDGAR_SUSPENDED', 'Suspended: Item 2.02 requires Exhibit 99.1');
    }
  }

  protected receipt(p: DistributionPayload, seq: number, now: Date): Omit<PublishAck, 'acceptedAt'> {
    // Filings accepted after 17:30 ET, or on a non-business day, carry the next business day.
    const tz = 'America/New_York';
    const today = civilOf(now, tz);
    const late = minutesOfDay(now, tz) >= 17 * 60 + 30;
    const filingDate = late || !isBusinessDay(today, US_FEDERAL_HOLIDAYS) ? addBusinessDays(today, 1, US_FEDERAL_HOLIDAYS) : today;
    const accession = `${String(p.attributes.cik)}-${filingDate.slice(2, 4)}-${String(seq).padStart(6, '0')}`;
    return {
      externalRef: accession,
      filingDate,
      detail: { service: 'EDGAR', accessionNumber: accession, formType: '8-K', status: 'accepted', filingDate },
    };
  }
}
