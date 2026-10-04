import type { LedgerRecord, SignedRecord } from "./types.ts";

function isSigned(r: LedgerRecord): r is SignedRecord {
  return r.kind === "lock" || r.kind === "retire";
}

/**
 * The ledger as it should be, given the mirror. Local records whose
 * signature no longer verifies are dropped (the mirror has the real one),
 * and each mirror record that is missing goes back right after the mirror
 * record that preceded it. Order matters, because the last lock of a number
 * wins: re-appending a replaced lock at the end would resurrect it. In the
 * common case (a `git checkout` that cut off the tail) this is an append.
 */
export function restoredLedger(records: LedgerRecord[], mirror: SignedRecord[], isTampered: (r: SignedRecord) => boolean): { records: LedgerRecord[]; restored: SignedRecord[] } {
  const out = records.filter((r) => !(isSigned(r) && isTampered(r)));
  const restored: SignedRecord[] = [];
  const indexOfSig = (sig: string) => out.findIndex((r) => isSigned(r) && r.sig === sig);

  let prevSig: string | null = null;
  for (const m of mirror) {
    if (indexOfSig(m.sig) === -1) {
      let at: number;
      if (prevSig !== null) {
        at = indexOfSig(prevSig) + 1;
      } else {
        const firstSigned = out.findIndex(isSigned);
        at = firstSigned === -1 ? out.length : firstSigned;
      }
      out.splice(at, 0, m);
      restored.push(m);
    }
    prevSig = m.sig;
  }
  return { records: out, restored };
}
