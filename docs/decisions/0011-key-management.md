# ADR-0011 — Build the signing _policy_, not fake custody

**Status:** Accepted

## Context

A payment rail that can mint and move tokens holds the most valuable thing in the system: a private
key. A portfolio project cannot have real custody — there is no HSM, no key ceremony, no dual
control, and the demo runs on Anvil with keys published in the Foundry documentation.

The failure mode to avoid is **theatre**: an "encrypted" key committed to the repo, a `cold_wallet`
that is a second environment variable, a README claiming HSM-grade anything. Theatre actively
destroys credibility, because anyone who knows the domain can see through it in ten seconds.

## Decision

The custody story is 20% "where are the bytes" and 80% "what is this key allowed to sign."
**Build the 80%.**

```ts
interface SignerPort {
  getAddress(): Promise<Address>;
  signTransaction(request: TransactionRequest): Promise<Hex>;
  signTypedData(payload: TypedDataDefinition): Promise<Hex>;
}
```

| Adapter          | Status                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalDevSigner` | Used by the demo. **Boot-crashes unless `NODE_ENV !== 'production' && chainId === 31337`.** That guard is the entire point of the adapter |
| `KmsSigner`      | Written, unit-tested against fixtures, **never run in the demo**. AWS KMS asymmetric `ECC_SECG_P256K1` / `ECDSA_SHA_256`                  |

`KmsSigner` is worth writing because the real content is the plumbing everyone gets wrong: parse the
DER signature to `(r, s)`, **normalize `s` to the low half-order per EIP-2**, derive `v` by recovering
both candidates and comparing against the address from the public key, cache the public key. All of
that is testable against fixtures with no AWS account — which is exactly how you prove the code is
right without theatre.

**`SigningPolicyService`** runs _before every signature_ and writes a `signing_requests` audit row
(allow or deny, with a reason):

- max value per transaction; max cumulative value per rolling hour, per key
- `to` address allowlist (contracts we deployed, plus our own accounts)
- **function-selector allowlist per key** — `hot_payout` may call `settle` and `refund`, but not
  `blacklist` or `configureMinter`
- chain-id pinning: a signer bound to 31337 refuses to sign for any other chain. Cheap, real
  replay protection
- `chain_accounts.is_frozen` kill switch, set automatically by invariant I8

**Three segregated accounts**, each a different key and a different signer instance:

| Account           | Holds                 | Policy                                                                             |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `treasury_minter` | Minter role           | Highest caps; would be a distinct KMS key with 2-of-N approval (stated, not built) |
| `hot_payout`      | Small operating float | Auto-refilled from treasury; per-tx and per-hour value caps                        |
| `gas_funder`      | ETH only              | May only send value to a fixed allowlist of our own addresses                      |

## Alternatives considered

| Alternative                                                   | Why it lost                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One key for everything                                        | Every compromise is total. Segregation costs one config block and makes the blast radius argument real.                                                                                                                                                              |
| Encrypt the key at rest in the repo                           | Theatre. The decryption key has to live somewhere, and that somewhere is the actual secret. It reads as not understanding the threat model.                                                                                                                          |
| A "cold wallet" as a second env var                           | Theatre with extra steps. If cold storage is worth representing, represent it honestly: an account with **no configured signer at all**, whose transactions require an operator-supplied signed payload. That is roughly what cold storage feels like operationally. |
| Skip `KmsSigner` entirely, document the interface             | Tempting, and it is the documented fallback if time runs out. But the low-`s` normalization and `v` recovery are the parts that are genuinely non-obvious, and writing them with fixture tests costs little and demonstrates a lot.                                  |
| Policy checks in the submitter rather than a separate service | The submitter is the thing being constrained. A policy enforced by the component it constrains is not a control.                                                                                                                                                     |
| MPC / threshold signing                                       | The right production answer for a treasury of any size, and far beyond both the scope and the demonstrable-in-a-demo threshold. Named as a non-goal rather than half-built.                                                                                          |

## Consequences

**Good.** The code reads correctly even though the demo uses well-known test keys. A reviewer sees
policy, segregation and audit — the parts that transfer to a real system — rather than a fake vault.

**Good.** `signing_requests` gives a complete audit trail of every signature attempt, including the
denials. Denials are usually the interesting ones.

**Good.** The `is_frozen` kill switch gives invariant I8 (unknown treasury outflow) somewhere to act
rather than merely alerting.

**Bad.** The demo's actual key storage is an environment variable, and no amount of policy changes
that. The `.env.example` labels it explicitly: `# WELL-KNOWN PUBLIC ANVIL TEST KEY — worthless,
never reuse`. Being loud about the limitation is the mitigation.

**Bad.** `KmsSigner` is code that ships untested against the real service. It is unit-tested against
recorded fixtures, which catches the encoding bugs but not an IAM or availability problem. The README
says so.
