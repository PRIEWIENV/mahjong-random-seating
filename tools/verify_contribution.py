#!/usr/bin/env python3
"""Independently re-derive R and the seed from a published results.json.

Deliberately a second implementation in a second language, written from the encoding
as PROTOCOL.md §7 describes it rather than from generate.js. That is the point: if the
byte encoding were ambiguous, this file and generate.js would disagree, which is
exactly the failure RUNBOOK step A5 exists to catch. Nothing here imports the
JavaScript, so agreement means the specification is precise enough to reimplement.

It also lets a participant check the arithmetic of a finished draw without running any
of the organiser's code.

Usage:
    python3 tools/verify_contribution.py results.json
    python3 tools/verify_contribution.py --self-test
"""
import hashlib
import json
import sys

SEP = b"\x1f"


def contribution(domain, local_id, user_input, nonce_hex, timestamp):
    """SHA256(DOMAIN 1f "contrib" 1f u8(local_id) 1f u8(user_input) 1f nonce16 1f ascii(ts))"""
    h = hashlib.sha256()
    h.update(domain.encode("utf-8"))
    h.update(SEP); h.update(b"contrib")
    h.update(SEP); h.update(bytes([local_id]))
    h.update(SEP); h.update(bytes([user_input]))
    h.update(SEP); h.update(bytes.fromhex(nonce_hex))
    h.update(SEP); h.update(timestamp.encode("ascii"))
    return h.digest()


def derive_seed(domain, R, signature_hex, local_ids):
    """SHA256(DOMAIN 1f "seed" 1f R 1f hexdecode(signature) 1f u8(local_id)...)"""
    h = hashlib.sha256()
    h.update(domain.encode("utf-8"))
    h.update(SEP); h.update(b"seed")
    h.update(SEP); h.update(R)
    h.update(SEP); h.update(bytes.fromhex(signature_hex))
    h.update(SEP)
    for i in sorted(local_ids):
        h.update(bytes([i]))
    return h.digest()


def check(results):
    domain = results["seed_domain_separation"]
    ok = True

    R = bytearray(32)
    for local_id_s, payload in sorted(results["revealed"].items(), key=lambda kv: int(kv[0])):
        local_id = int(local_id_s)
        c = contribution(
            domain, local_id, payload["user_input"],
            payload["client_nonce"], payload["client_timestamp"],
        )
        published = results["contributions"].get(local_id_s)
        if c.hex() != published:
            print(f"  FAIL  local_id {local_id}: contribution {c.hex()} != published {published}")
            ok = False
        for j in range(32):
            R[j] ^= c[j]

    if R.hex() != results["R"]:
        print(f"  FAIL  R {R.hex()} != published {results['R']}")
        ok = False

    seed = derive_seed(domain, bytes(R), results["drand_signature"], results["participating_local_ids"])
    if seed.hex() != results["seed"]:
        print(f"  FAIL  seed {seed.hex()} != published {results['seed']}")
        ok = False

    if ok:
        print(f"  OK    {len(results['revealed'])} contributions, R and seed all re-derived independently")
        print(f"        R    = {R.hex()}")
        print(f"        seed = {seed.hex()}")
    return ok


SELF_TEST = {
    "domain": "mahjong-seating-v1",
    "local_id": 3,
    "user_input": 7,
    "nonce": "000102030405060708090a0b0c0d0e0f",
    "timestamp": "2026-09-10T19:59:00.000Z",
    "expect": "927b1af776ab013b664c85e739eea4cecd6d2afc43d0a23f57fecf3b874c550f",
}


def self_test():
    got = contribution(
        SELF_TEST["domain"], SELF_TEST["local_id"], SELF_TEST["user_input"],
        SELF_TEST["nonce"], SELF_TEST["timestamp"],
    ).hex()
    if got == SELF_TEST["expect"]:
        print(f"  OK    fixed vector reproduces: {got}")
        return True
    print(f"  FAIL  fixed vector\n        expected {SELF_TEST['expect']}\n        got      {got}")
    return False


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        sys.exit(0 if self_test() else 1)
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as fh:
        sys.exit(0 if check(json.load(fh)) else 1)
