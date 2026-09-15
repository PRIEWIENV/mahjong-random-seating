#!/usr/bin/env python3
"""Independently re-derive the twelfth round from the published files (PROTOCOL.md §11).

A second implementation in a second language, written from the specification rather than
from generate-final.js. That is the whole point: if the encoding or the enumeration order
were ambiguous, this file and the JavaScript would disagree, and a disagreement is
exactly the failure that would otherwise be silent — a different seat plan with no error
anywhere.

Two places are worth naming, because they are where two honest implementations diverge:

  below()          rejection sampling, not modulo. Written out here from scratch. A
                   modulo implementation agrees with this one on most draws and differs
                   on a few, which is the worst kind of bug to go looking for.

  the 24 orders    the draw is an INDEX into the optimal assignments, in enumeration
                   order, so the enumeration order is part of the result. This file
                   builds them its own way and checks the list against the table printed
                   in docs/seating-design.md.

It also lets a player check the final round without running any of the organiser's code:
every input is a published file, and the beacon is drand's.

Usage:
    py tools/verify_final.py                       # everything in the current checkout
    py tools/verify_final.py --final final.json --lock events/final/lock.json \
                             --results results.json --roster data/roster.json \
                             --template data/schedule_template.json
    py tools/verify_final.py --self-test           # fixed vectors, no files needed
"""
import argparse
import hashlib
import json
import os
import sys
from itertools import permutations

SEP = b"\x1f"
SEATS = ["E", "S", "W", "N"]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------------------------------------------------------------------------
# the CSPRNG
# ---------------------------------------------------------------------------

class CounterStream:
    """SHA-256 in counter mode: block(i) = SHA256(seed || uint32be(i)), concatenated."""

    def __init__(self, seed):
        self.seed = seed
        self.counter = 0
        self.buf = b""

    def read(self, n):
        while len(self.buf) < n:
            ctr = self.counter.to_bytes(4, "big")
            self.buf += hashlib.sha256(self.seed + ctr).digest()
            self.counter += 1
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def below(self, bound):
        """Uniform in [0, bound), by rejection sampling.

        Not `value % bound`. Modulo skews towards the low end whenever bound does not
        divide 2^32, and the skew is small enough to look like nothing and large enough
        to be a bias in a fairness mechanism. Values at or above the largest multiple of
        bound below 2^32 are thrown away and another four bytes are read.
        """
        if bound < 1 or bound > 2 ** 32:
            raise ValueError(f"bad bound {bound}")
        limit = (2 ** 32 // bound) * bound
        while True:
            v = int.from_bytes(self.read(4), "big")
            if v < limit:
                return v % bound


# ---------------------------------------------------------------------------
# the seed
# ---------------------------------------------------------------------------

def derive_final_seed(domain, R, signature_hex, standings, local_ids):
    """SHA256(DOMAIN 1f "final" 1f R 1f hexdecode(sig) 1f u8(standings)... 1f u8(ids)...)

    standings are local_ids in FINISHING order, rank 1 first — the one field here whose
    order carries meaning. local_ids are ascending: who contributed to R.
    """
    if SEP in domain.encode("utf-8"):
        raise ValueError("seed_domain_separation may not contain byte 0x1f")
    h = hashlib.sha256()
    h.update(domain.encode("utf-8"))
    h.update(SEP); h.update(b"final")
    h.update(SEP); h.update(R)
    h.update(SEP); h.update(bytes.fromhex(signature_hex))
    h.update(SEP)
    for i in standings:
        h.update(bytes([i]))
    h.update(SEP)
    for i in sorted(local_ids):
        h.update(bytes([i]))
    return h.digest()


# ---------------------------------------------------------------------------
# who is short of which wind
# ---------------------------------------------------------------------------

def deficient_wind(counts, k):
    """The one wind at k-1 when the other three are at k, else an error.

    Over 4k-1 rounds the best possible split is k,k,k,k-1, and the eleven-round template
    gives every point exactly that. Anything else and there is no single wind to complete.
    """
    short = [w for w in SEATS if counts[w] == k - 1]
    full = [w for w in SEATS if counts[w] == k]
    if len(short) != 1 or len(full) != 3:
        got = " ".join(f"{w}{counts[w]}" for w in SEATS)
        raise ValueError(f"winds {got} are not the {k},{k},{k},{k-1} this design needs")
    return short[0]


def deficiency_by_point(template):
    """Per abstract point, off the frozen template. Never a literal."""
    n = template["n_players"]
    rounds = template["rounds"]
    if (len(rounds) + 1) % 4 != 0:
        raise ValueError(f"a {len(rounds)}-round template has no single deficient wind per point")
    k = (len(rounds) + 1) // 4

    counts = [{w: 0 for w in SEATS} for _ in range(n)]
    for rd in rounds:
        for tbl in rd["tables"]:
            for w in SEATS:
                counts[tbl["seats"][w]][w] += 1
    out = [deficient_wind(c, k) for c in counts]

    # Each wind must be short for the same number of points, or "three short of each" is
    # not a property of this template and the objective changes shape.
    per_wind = k * n - len(rounds) * template["n_tables"]
    for w in SEATS:
        got = out.count(w)
        if got != per_wind:
            raise ValueError(f"{got} points are short of {w}, expected {per_wind}")
    return out, k


def deficiency_by_player(seating, k):
    """The same thing counted off the published seat plan, per local_id."""
    winds = {}
    for rd in seating["rounds"]:
        for tbl in rd["tables"]:
            for w in SEATS:
                pid = tbl["seats"][w]["local_id"]
                winds.setdefault(pid, {x: 0 for x in SEATS})[w] += 1
    return {pid: deficient_wind(c, k) for pid, c in winds.items()}


# ---------------------------------------------------------------------------
# the 24 assignments, and the draw
# ---------------------------------------------------------------------------

# a[i] is the SEAT INDEX given to the i-th player of the table, players in rank order.
# Player -> seat, not seat -> player: reversed it produces a different, equally plausible
# draw. itertools.permutations emits lexicographic order for a sorted input, which is the
# order the specification fixes; the self-test checks the list against the printed table.
ASSIGNMENTS = [list(p) for p in permutations(range(4))]


def optima_for(deficiencies):
    """The assignments completing the most players at one table, in enumeration order.

    The maximum is always the number of DISTINCT deficient winds at the table, and the
    number of optima is (product of the multiplicities) x (4 - distinct)!. Found by
    enumeration rather than by that formula: 24 steps costs nothing, and a closed form
    would be a second claim to keep true.
    """
    best = -1
    optima = []
    for a in ASSIGNMENTS:
        fixed = sum(1 for i, s in enumerate(a) if SEATS[s] == deficiencies[i])
        if fixed > best:
            best, optima = fixed, []
        if fixed == best:
            optima.append(a)
    return best, optima


def draw_tables(standings, deficiency, rng, block_size, n_tables):
    """One below() call per table, in table order, off one stream. Nothing else reads it.

    Per-table optimisation is globally optimal and per-table uniformity globally uniform:
    the tables partition the twelve players with no constraint crossing a table, so the
    global optima are the Cartesian product of the per-table optima, and drawing
    independently and uniformly from each factor is uniform on the product.
    """
    out = []
    for t in range(1, n_tables + 1):
        players = standings[block_size * (t - 1): block_size * t]
        deficiencies = [deficiency[pid] for pid in players]
        best, optima = optima_for(deficiencies)
        index = rng.below(len(optima))
        out.append({
            "table": t,
            "players": players,
            "deficiencies": deficiencies,
            "completed": best,
            "optima_count": len(optima),
            "optimum_index": index,
            "assignment": optima[index],
        })
    return out


# ---------------------------------------------------------------------------
# checking a published final.json
# ---------------------------------------------------------------------------

def sha256_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def check(paths):
    problems = []
    notes = []

    def load(p):
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)

    final = load(paths.final)
    lock = load(paths.lock)
    results = load(paths.results)
    roster = load(paths.roster)
    template = load(paths.template)

    # ---- what this draw is bound to -----------------------------------------
    # The lock was published and timestamped before its beacon existed, so these three
    # digests are what tie a reproducible computation to a commitment made in advance.
    results_sha = sha256_file(paths.results)
    lock_sha = sha256_file(paths.lock)
    if lock.get("results_sha256") != results_sha:
        problems.append(f"the lock names results_sha256 {lock.get('results_sha256')}, "
                        f"but {paths.results} hashes to {results_sha}")
    if final.get("results_sha256") != lock.get("results_sha256"):
        problems.append("final.json and the lock disagree about which results.json this is")
    if final.get("lock_sha256") not in (None, lock_sha):
        problems.append(f"final.json names lock_sha256 {final['lock_sha256']}, "
                        f"but {paths.lock} hashes to {lock_sha}")
    if final.get("round_used") != lock.get("target_round"):
        problems.append(f"final.json used drand round {final.get('round_used')}, "
                        f"but the lock committed to {lock.get('target_round')}")
    if lock.get("standings") != final.get("standings"):
        problems.append("final.json was drawn from standings that are not the ones locked")

    standings = final["standings"]
    if sorted(standings) != sorted(p["local_id"] for p in roster["players"]):
        problems.append("the standings are not a permutation of the roster's local_ids")

    # ---- the seed ------------------------------------------------------------
    seed = derive_final_seed(
        final["seed_domain_separation"],
        bytes.fromhex(results["R"]),
        final["drand_signature"],
        standings,
        results["participating_local_ids"],
    )
    if seed.hex() != final["seed"]:
        problems.append(f"seed {seed.hex()} != published {final['seed']}")
        # Everything below is derived from the seed, so there is nothing left to check.
        return report(problems, notes, final)

    # ---- who was short of what, by two routes --------------------------------
    by_point, k = deficiency_by_point(template)
    by_player = deficiency_by_player(results["seating"], k)
    for point, pid in enumerate(results["permutation"]):
        if by_player[pid] != by_point[point]:
            problems.append(f"local_id {pid} is short of {by_player[pid]} in results.json "
                            f"but of {by_point[point]} at template point {point}")
    published_def = final.get("deficient_winds") or {}
    for pid, wind in by_player.items():
        if published_def.get(str(pid)) != wind:
            problems.append(f"final.json says local_id {pid} is short of "
                            f"{published_def.get(str(pid))}, the seat plan says {wind}")

    # ---- the draw ------------------------------------------------------------
    n_tables = template["n_tables"]
    block = template["n_players"] // n_tables
    rng = CounterStream(seed)
    tables = draw_tables(standings, by_player, rng, block, n_tables)

    for got, pub in zip(tables, final["tables"]):
        for key in ("table", "players", "deficiencies", "completed", "optima_count",
                    "optimum_index", "assignment"):
            if got[key] != pub.get(key):
                problems.append(f"table {got['table']}: {key} {got[key]} != published {pub.get(key)}")

    # ---- the seat plan itself ------------------------------------------------
    rank_of = {pid: i + 1 for i, pid in enumerate(standings)}
    title_of = {p["local_id"]: p["title"] for p in roster["players"]}
    rebuilt = []
    for t in tables:
        by_seat = [None] * 4
        for i, pid in enumerate(t["players"]):
            by_seat[t["assignment"][i]] = pid
        rebuilt.append({
            "table": t["table"],
            "seats": {w: {"rank": rank_of[by_seat[si]], "local_id": by_seat[si],
                          "title": title_of[by_seat[si]]}
                      for si, w in enumerate(SEATS)},
        })
    published_round = final["seating"]["rounds"][0]
    if rebuilt != published_round["tables"]:
        problems.append("the recomputed seat plan differs from the published one")
    if published_round["round"] != len(template["rounds"]) + 1:
        problems.append(f"the final round is numbered {published_round['round']}, "
                        f"expected {len(template['rounds']) + 1}")

    # ---- what it came to -----------------------------------------------------
    complete = sorted(pid for t in tables for i, pid in enumerate(t["players"])
                      if SEATS[t["assignment"][i]] == t["deficiencies"][i])
    if complete != final.get("completed_local_ids"):
        problems.append(f"completed {complete} != published {final.get('completed_local_ids')}")
    if len(complete) != final.get("completed_count"):
        problems.append("completed_count does not match completed_local_ids")

    # Twelve rounds can leave a player on 3-3-3-3 or 4-3-3-2, and nothing else. Counted
    # over both files, which is the only place the two seat plans are added together.
    totals = {}
    for rd in results["seating"]["rounds"] + final["seating"]["rounds"]:
        for tbl in rd["tables"]:
            for w in SEATS:
                totals.setdefault(tbl["seats"][w]["local_id"], {x: 0 for x in SEATS})[w] += 1
    for pid, counts in sorted(totals.items()):
        split = sorted((counts[w] for w in SEATS), reverse=True)
        if split not in ([3, 3, 3, 3], [4, 3, 3, 2]):
            problems.append(f"local_id {pid} finishes on {'-'.join(map(str, split))}")
    notes.append(f"{len(complete)} of {len(standings)} players finish on three of every wind")
    short = [pid for pid in standings if pid not in complete]
    if short:
        notes.append(f"still 4-3-3-2: {', '.join(map(str, short))} — each was at a table where "
                     "someone else was short of the same wind (1/m, docs/seating-design.md)")

    return report(problems, notes, final)


def report(problems, notes, final):
    for p in problems:
        print(f"  FAIL  {p}")
    if problems:
        return False
    print("  OK    the final round re-derives independently, in Python, from published files")
    print(f"        seed_final = {final['seed']}")
    print(f"        drand      = round {final['round_used']}")
    for n in notes:
        print(f"        {n}")
    return True


# ---------------------------------------------------------------------------
# fixed vectors
# ---------------------------------------------------------------------------

# The table printed in docs/seating-design.md. Checked against the enumeration above so
# that the order the draw indexes into is confirmed against the document, not against the
# other implementation.
PRINTED_ASSIGNMENTS = [
    "0123", "0132", "0213", "0231", "0312", "0321",
    "1023", "1032", "1203", "1230", "1302", "1320",
    "2013", "2031", "2103", "2130", "2301", "2310",
    "3012", "3021", "3102", "3120", "3201", "3210",
]

RNG_SEED = "748024c5864d0b5a3299639e0cb9e15107f01acb1889f9d2534d5375c9018db5"
RNG_BELOW = {
    1: [0] * 20,
    2: [1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1],
    3: [2, 1, 0, 1, 1, 0, 0, 2, 2, 1, 2, 2, 1, 0, 0, 2, 2, 2, 1, 2],
    4: [1, 1, 3, 2, 3, 0, 2, 0, 2, 2, 1, 2, 2, 0, 3, 1, 0, 2, 3, 3],
    6: [5, 1, 3, 4, 1, 0, 0, 2, 2, 4, 5, 2, 4, 0, 3, 5, 2, 2, 1, 5],
    12: [5, 1, 3, 10, 7, 0, 6, 8, 2, 10, 5, 2, 10, 0, 3, 5, 8, 2, 7, 11],
    24: [5, 1, 3, 22, 7, 0, 18, 8, 2, 10, 17, 14, 10, 0, 3, 5, 8, 14, 19, 11],
}

DRAW = {
    "domain": "mahjong-seating-v1",
    "R": "2dac7ab67c45ccc7ace1f37101950351aad2592e9db06da07114751227898311",
    "signature": "ab" * 48,
    "standings": [7, 2, 11, 4, 9, 1, 12, 5, 3, 10, 8, 6],
    "participating_local_ids": list(range(1, 13)),
    "seed_final": "f410af10982e3092d275503656682203c8b1597ede3f0cee3f3facacf8b5f7a0",
    "deficiencies": [["W", "N", "N", "W"], ["S", "S", "E", "W"], ["E", "N", "E", "S"]],
    "assignments": ["2130", "3102", "2301"],
    "optima_counts": [8, 2, 2],
    "completed": [1, 5, 6, 7, 8, 10, 11, 12],
}


def self_test():
    ok = True

    got = ["".join(map(str, a)) for a in ASSIGNMENTS]
    if got != PRINTED_ASSIGNMENTS:
        print("  FAIL  the 24 assignments are not in the order seating-design.md prints")
        print(f"        got      {' '.join(got)}")
        ok = False
    else:
        print(f"  OK    24 assignments, lexicographic, matching the printed table")

    # Rejection sampling, pinned. This is where two implementations silently diverge: a
    # modulo version reproduces most of these and not all of them.
    seed = bytes.fromhex(RNG_SEED)
    for bound, expect in sorted(RNG_BELOW.items()):
        rng = CounterStream(seed)
        out = [rng.below(bound) for _ in range(len(expect))]
        if out != expect:
            print(f"  FAIL  below({bound})\n        expected {expect}\n        got      {out}")
            ok = False
    if ok:
        print(f"  OK    below() reproduces {sum(len(v) for v in RNG_BELOW.values())} pinned draws "
              f"across {len(RNG_BELOW)} bounds")

    seed_final = derive_final_seed(DRAW["domain"], bytes.fromhex(DRAW["R"]), DRAW["signature"],
                                  DRAW["standings"], DRAW["participating_local_ids"])
    if seed_final.hex() != DRAW["seed_final"]:
        print(f"  FAIL  seed_final\n        expected {DRAW['seed_final']}\n        got      {seed_final.hex()}")
        ok = False
    else:
        print(f"  OK    seed_final reproduces: {seed_final.hex()}")

    # And the draw those inputs produce, end to end.
    deficiency = {}
    for t, group in enumerate(DRAW["deficiencies"]):
        for i, w in enumerate(group):
            deficiency[DRAW["standings"][t * 4 + i]] = w
    rng = CounterStream(seed_final)
    tables = draw_tables(DRAW["standings"], deficiency, rng, 4, 3)
    got_assign = ["".join(map(str, t["assignment"])) for t in tables]
    if got_assign != DRAW["assignments"]:
        print(f"  FAIL  assignments\n        expected {DRAW['assignments']}\n        got      {got_assign}")
        ok = False
    if [t["optima_count"] for t in tables] != DRAW["optima_counts"]:
        print(f"  FAIL  optima counts {[t['optima_count'] for t in tables]} != {DRAW['optima_counts']}")
        ok = False
    complete = sorted(pid for t in tables for i, pid in enumerate(t["players"])
                      if SEATS[t["assignment"][i]] == t["deficiencies"][i])
    if complete != DRAW["completed"]:
        print(f"  FAIL  completed {complete} != {DRAW['completed']}")
        ok = False
    if ok:
        print(f"  OK    the pinned draw reproduces: tables {', '.join(got_assign)}, "
              f"{len(complete)} completed")

    # The maximum completable at a table is the number of distinct deficient winds, and
    # the number of optima is (product of multiplicities) x (4 - distinct)!. Checked over
    # every one of the 256 possible tables rather than asserted.
    fact = [1, 1, 2, 6, 24]
    for a in SEATS:
        for b in SEATS:
            for c in SEATS:
                for d in SEATS:
                    group = [a, b, c, d]
                    best, optima = optima_for(group)
                    distinct = set(group)
                    if best != len(distinct):
                        print(f"  FAIL  {group}: best {best} != {len(distinct)} distinct winds")
                        ok = False
                    expect = fact[4 - len(distinct)]
                    for w in distinct:
                        expect *= group.count(w)
                    if len(optima) != expect:
                        print(f"  FAIL  {group}: {len(optima)} optima != {expect}")
                        ok = False
    if ok:
        print("  OK    all 256 tables: max completable = distinct winds, optima count as specified")

    return ok


def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--final", default=os.path.join(ROOT, "final.json"))
    ap.add_argument("--lock", default=os.path.join(ROOT, "events", "final", "lock.json"))
    ap.add_argument("--results", default=os.path.join(ROOT, "results.json"))
    ap.add_argument("--roster", default=os.path.join(ROOT, "data", "roster.json"))
    ap.add_argument("--template", default=os.path.join(ROOT, "data", "schedule_template.json"))
    ap.add_argument("-h", "--help", action="store_true")
    args = ap.parse_args()

    if args.help:
        print(__doc__)
        return 0
    if getattr(args, "self_test"):
        return 0 if self_test() else 1

    for name in ("final", "lock", "results", "roster", "template"):
        path = getattr(args, name)
        if not os.path.exists(path):
            print(f"  ERROR no {name} file at {path}")
            if name in ("final", "lock"):
                print("        The final round has not been drawn in this checkout. Fetch it from")
                print("        the published repository, or pass --final / --lock explicitly.")
            return 2
    return 0 if check(args) else 1


if __name__ == "__main__":
    sys.exit(main())
