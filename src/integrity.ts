import { KEYS_DIR } from "./keys.ts";
import { activePromises } from "./promises.ts";
import { shortDate } from "./render.ts";
import { checkSignature } from "./sign.ts";
import type { Keyring, KnownKey } from "./sign.ts";
import type { LedgerRecord, SignedRecord } from "./types.ts";
import { STATE_DIR } from "./types.ts";

export interface IntegrityInput {
  records: LedgerRecord[];
  mirror: SignedRecord[];
  keyring: Keyring;
  hashOf: (check: string) => string;
}

function isSigned(r: LedgerRecord): r is SignedRecord {
  return r.kind === "lock" || r.kind === "retire";
}

/** How a person recognises a key: its committed file, or its id. */
export function keyLabel(k: KnownKey | undefined, keyId: string): string {
  if (!k) return `key ${keyId}`;
  return k.file ? k.file.slice(k.file.lastIndexOf("/") + 1) : `${k.name} (${k.id})`;
}

/**
 * Everything that makes the ledger disagree with what the human confirmed.
 *
 * A record signed by a key this machine knows (its own, the legacy HMAC
 * key, or a teammate's committed public key) must verify. A record whose
 * key isn't here is trusted when it *adds* a promise, as a teammate's lock
 * pulled from git would be. Nothing but this machine's own keys can weaken a
 * promise this machine locked: the agent can write a key file just as it
 * can write a record, so a committed key vouches for locks, not for
 * retiring someone else's.
 */
export function integrityProblems(i: IntegrityInput): string[] {
  const problems: string[] = [];
  const localOwned = new Set<number>();
  for (const r of i.records) {
    if (!isSigned(r)) continue;
    const what = r.kind === "lock" ? "lock" : "retirement";
    const key = i.keyring.get(r.keyId);
    const check = checkSignature(r, i.keyring);
    if (check === "invalid") {
      problems.push(key?.local
        ? `#${r.number}: the ${what} record's signature doesn't match, so it was edited after you confirmed it`
        : `#${r.number}: the ${what} record's signature doesn't match ${keyLabel(key, r.keyId)}, so it was edited or forged`);
      continue;
    }
    if (check === "valid" && key?.local) {
      if (r.kind === "lock") localOwned.add(r.number);
    } else if (localOwned.has(r.number)) {
      problems.push(`#${r.number} was ${r.kind === "retire" ? "retired" : "replaced"} by a record this machine didn't sign (${keyLabel(key, r.keyId)})`);
    }
  }

  for (const k of i.keyring.values()) {
    if (!k.local || k.alg !== "ed25519" || k.file !== null) continue;
    const signed = i.records.filter(isSigned).filter((r) => r.keyId === k.id).map((r) => `#${r.number}`);
    if (signed.length) {
      problems.push(`this machine's public key (${k.id}) is missing from ${KEYS_DIR}/, so nobody else can verify ${[...new Set(signed)].join(", ")}`);
    }
  }

  for (const p of activePromises(i.records)) {
    const h = i.hashOf(p.check);
    if (h === "missing") problems.push(`#${p.number}'s check was deleted (${p.check})`);
    else if (h !== p.checkHash) problems.push(`#${p.number}'s check was changed after you confirmed it (${p.check})`);
  }

  const present = new Set(i.records.filter(isSigned).map((r) => r.sig));
  for (const m of i.mirror) {
    if (present.has(m.sig)) continue;
    const when = m.kind === "lock" ? m.confirmedAt : m.retiredAt;
    problems.push(`#${m.number}'s ${m.kind === "lock" ? "lock" : "retirement"} (you said "${m.words.trim()}" on ${shortDate(when)}) is missing from ${STATE_DIR}/promises.jsonl`);
  }
  return problems;
}
