#!/usr/bin/env python3
"""Independently re-verify every invariant of schedule_template.json.

Nothing in the file's own `verified_properties` block is trusted: every figure is
re-derived from the `rounds` data. Exits non-zero if anything fails to match, so it
is safe to hand to participants who want to check the template themselves.

Usage: python3 verify_template.py data/schedule_template.json
"""
import json
import sys
import itertools
from collections import Counter, defaultdict

EXPECTED = {
    "n_players": 12,
    "n_rounds": 11,
    "n_tables": 3,
    "same_table_per_pair": 3,
    "seat_dist": [3, 3, 3, 2],
    "opposite_per_pair": 1,
    "table_cost": 18,
    "deviating_points": [4, 8, 10],
    "perfect_pairs": 55,
}
SEATS = ["E", "S", "W", "N"]


def fail(msg):
    print(f"  FAIL  {msg}")
    return False


def main(path):
    t = json.load(open(path, encoding="utf-8"))
    R, T, S = EXPECTED["n_rounds"], EXPECTED["n_tables"], 4
    P = EXPECTED["n_players"]
    ok = True

    # ---- structure ----
    if t.get("seat_order") != SEATS:
        ok = fail(f"seat_order should be {SEATS}")
    if len(t.get("rounds", [])) != R:
        print(f"  FAIL  expected {R} rounds")
        sys.exit(1)

    seat = {}  # (round, table, seat_index) -> abstract point
    for r, rd in enumerate(t["rounds"]):
        if len(rd["tables"]) != T:
            print(f"  FAIL  round {r + 1}: expected {T} tables")
            sys.exit(1)
        seen = []
        for tb, tbl in enumerate(rd["tables"]):
            for k in range(S):
                p = tbl["seats"][SEATS[k]]
                seat[(r, tb, k)] = p
                seen.append(p)
        if sorted(seen) != list(range(P)):
            ok = fail(f"round {r + 1} is not a complete partition of the 12 points")

    # ---- condition 2: every pair shares a table exactly 3 times ----
    cooc = Counter()
    for r in range(R):
        for tb in range(T):
            grp = sorted(seat[(r, tb, k)] for k in range(S))
            for u, v in itertools.combinations(grp, 2):
                cooc[(u, v)] += 1
    if len(cooc) != 66 or set(cooc.values()) != {EXPECTED["same_table_per_pair"]}:
        ok = fail(
            f"same-table counts: expected all 66 pairs = {EXPECTED['same_table_per_pair']}, "
            f"got {sorted(set(cooc.values()))} across {len(cooc)} pairs"
        )

    # ---- condition 3: seat distribution per point is {3,3,3,2} ----
    seat_cnt = {p: [0] * 4 for p in range(P)}
    for (r, tb, k), p in seat.items():
        seat_cnt[p][k] += 1
    bad3 = [p for p in range(P) if sorted(seat_cnt[p], reverse=True) != EXPECTED["seat_dist"]]
    if bad3:
        ok = fail(f"seat distribution: points {bad3} do not match {EXPECTED['seat_dist']}")

    # ---- condition 5: every pair sits opposite exactly once ----
    opp = Counter()
    for r in range(R):
        for tb in range(T):
            for k in range(2):
                u, v = seat[(r, tb, k)], seat[(r, tb, k + 2)]
                opp[(min(u, v), max(u, v))] += 1
    if len(opp) != 66 or set(opp.values()) != {EXPECTED["opposite_per_pair"]}:
        ok = fail(
            f"opposite counts: expected all 66 pairs = {EXPECTED['opposite_per_pair']}, "
            f"got {sorted(set(opp.values()))} across {len(opp)} pairs"
        )

    # ---- condition 4: table distribution deviation ----
    tab_cnt = {p: [0] * T for p in range(P)}
    for (r, tb, k), p in seat.items():
        tab_cnt[p][tb] += 1
    cost = sum((c - 4) ** 2 for p in range(P) for c in tab_cnt[p])
    dev = sorted(p for p in range(P) if sorted(tab_cnt[p], reverse=True) != [4, 4, 3])
    if cost != EXPECTED["table_cost"]:
        ok = fail(f"table squared-deviation cost: expected {EXPECTED['table_cost']}, got {cost}")
    if dev != EXPECTED["deviating_points"]:
        ok = fail(f"deviating points: expected {EXPECTED['deviating_points']}, got {dev}")
    for p in dev:
        if sorted(tab_cnt[p], reverse=True) != [5, 3, 3]:
            ok = fail(f"point {p}: deviation shape should be [5,3,3], got {sorted(tab_cnt[p], reverse=True)}")

    # ---- condition 6: number of perfect pairs ----
    adj = defaultdict(list)
    for r in range(R):
        for tb in range(T):
            for k in range(S):
                u, v = seat[(r, tb, k)], seat[(r, tb, (k + 1) % S)]  # u is the upper hand of v
                adj[(min(u, v), max(u, v))].append("up" if u < v else "down")
    if len(adj) != 66 or any(len(d) != 2 for d in adj.values()):
        ok = fail("adjacency structure is malformed: every pair should be adjacent exactly twice")
    perfect = sum(1 for d in adj.values() if len(d) == 2 and d[0] != d[1])
    if perfect != EXPECTED["perfect_pairs"]:
        ok = fail(f"perfect pairs: expected {EXPECTED['perfect_pairs']}, got {perfect}")

    if ok:
        print(
            "  OK    same-table 3x across 66 pairs | seat distribution {3,3,3,2} | "
            f"opposite 1x across 66 pairs | table cost {cost} (deviating points {dev}) | "
            f"perfect pairs {perfect}/66"
        )
        print("Template verified.")
        return 0
    print("Template verification FAILED.")
    return 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
