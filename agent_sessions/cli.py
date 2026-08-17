"""Command line entry point."""

from __future__ import annotations

import argparse
import os
import socket
import sys
import webbrowser

from . import discovery, index as idx


def _human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _human_num(n: float) -> str:
    for limit, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(n) >= limit:
            return f"{n / limit:.1f}{suffix}"
    return f"{n:.0f}"


def _free_port(host: str, port: int) -> int:
    for candidate in range(port, port + 40):
        with socket.socket() as sock:
            try:
                sock.bind((host, candidate))
                return candidate
            except OSError:
                continue
    raise SystemExit(f"no free port in {port}..{port + 40}")


def cmd_index(args) -> int:
    found = discovery.discover()
    if not found:
        print("No agent transcripts found.")
        print(f"  looked in {discovery.CLAUDE_ROOT}")
        print(f"            {discovery.CODEX_ROOT}")
        return 1
    for agent, groups in found.items():
        files = [p for g in groups for p in ([g["main"]] + g["subs"]) if p]
        subs = sum(len(g["subs"]) for g in groups)
        total = sum(os.path.getsize(p) for p in files if os.path.exists(p))
        extra = f" (+{subs} subagent)" if subs else ""
        print(f"  {agent:<8} {len(groups):>4} sessions{extra:<16} "
              f"{_human_bytes(total):>9}")

    state = {"n": 0}

    def progress(agent, path, n_subs):
        state["n"] += 1
        name = os.path.basename(path)
        tag = f" +{n_subs}" if n_subs else ""
        sys.stdout.write(
            f"\r  indexing {state['n']:>4}  {agent:<7} {(name[:40] + tag):<46}"
        )
        sys.stdout.flush()

    stats = idx.reindex(args.home, force=args.force, progress=progress)
    if state["n"]:
        sys.stdout.write("\r" + " " * 78 + "\r")

    print(
        f"  indexed {stats['indexed']}, unchanged {stats['skipped']}, "
        f"removed {stats['removed']}, failed {stats['failed']} "
        f"in {stats['elapsed']:.1f}s"
    )
    db = idx.db_path(args.home)
    if os.path.exists(db):
        print(f"  database {db} ({_human_bytes(os.path.getsize(db))})")
    return 0


def cmd_serve(args) -> int:
    from .server import serve

    if not os.path.exists(idx.db_path(args.home)) or args.reindex:
        if cmd_index(args) == 1:
            return 1

    port = args.port if args.no_pick_port else _free_port(args.host, args.port)
    url = f"http://{args.host}:{port}"
    conn = idx.connect(args.home)
    n = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    conn.close()

    print(f"\n  agent-sessions  {n} sessions indexed")
    print(f"  serving {url}   (ctrl-c to stop)\n")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        serve(args.host, port, args.home)
    except KeyboardInterrupt:
        print("\n  stopped")
    return 0


def cmd_stats(args) -> int:
    conn = idx.connect(args.home)
    where, params = "", []
    if args.since:
        where, params = " WHERE day >= ?", [args.since]

    row = conn.execute(
        f"""SELECT COUNT(*) n, COALESCE(SUM(input_tokens),0) i,
                   COALESCE(SUM(output_tokens),0) o,
                   COALESCE(SUM(cache_read),0) cr, COALESCE(SUM(cache_write),0) cw,
                   COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(file_size),0) b,
                   SUM(unpriced) unpriced
            FROM sessions{where}""",
        params,
    ).fetchone()
    if not row["n"]:
        print("No sessions indexed. Run: agent-sessions index")
        return 1

    print(f"\n  {row['n']} sessions   {_human_bytes(row['b'])} of transcripts")
    print(
        f"  tokens   input {_human_num(row['i'])}   output {_human_num(row['o'])}"
        f"   cache-read {_human_num(row['cr'])}   cache-write {_human_num(row['cw'])}"
    )
    print(f"  est. cost at API list rates  ${row['cost']:,.2f}", end="")
    print(f"   ({row['unpriced']} sessions unpriced)" if row["unpriced"] else "")

    print("\n  BY AGENT")
    print(f"    {'agent':<10}{'sessions':>9}{'tokens':>10}{'cost':>12}")
    for r in conn.execute(
        f"""SELECT agent, COUNT(*) n, COALESCE(SUM(total_tokens),0) t,
                   COALESCE(SUM(cost_usd),0) c
            FROM sessions{where} GROUP BY agent ORDER BY t DESC""",
        params,
    ):
        print(f"    {r['agent']:<10}{r['n']:>9}{_human_num(r['t']):>10}"
              f"{'$' + format(r['c'], ',.2f'):>12}")

    print("\n  TOP PROJECTS")
    print(f"    {'project':<32}{'sessions':>9}{'tokens':>10}{'cost':>12}")
    for r in conn.execute(
        f"""SELECT project, COUNT(*) n, COALESCE(SUM(total_tokens),0) t,
                   COALESCE(SUM(cost_usd),0) c
            FROM sessions{where}{' AND' if where else ' WHERE'} project IS NOT NULL
            GROUP BY project ORDER BY t DESC LIMIT 12""",
        params,
    ):
        print(f"    {(r['project'] or '')[:31]:<32}{r['n']:>9}"
              f"{_human_num(r['t']):>10}{'$' + format(r['c'], ',.2f'):>12}")

    from .pricing import load_prices, price_for

    prices = load_prices(idx.prices_path(args.home))
    print("\n  MODELS")
    print(f"    {'model':<26}{'sessions':>9}{'tokens':>10}{'cost':>12}")
    for r in conn.execute(
        f"""SELECT model, COUNT(*) n, COALESCE(SUM(total_tokens),0) t,
                   COALESCE(SUM(cost_usd),0) c
            FROM sessions{where}{' AND' if where else ' WHERE'} model IS NOT NULL
            GROUP BY model ORDER BY t DESC LIMIT 15""",
        params,
    ):
        # "no price" is a property of the model, not of any one session.
        priced = price_for(r["model"], prices) is not None
        cost = "$" + format(r["c"], ",.2f") if priced else "no price"
        print(f"    {(r['model'] or '')[:25]:<26}{r['n']:>9}"
              f"{_human_num(r['t']):>10}{cost:>12}")
    print()
    conn.close()
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="agent-sessions",
        description="Index and browse AI coding agent sessions (Claude Code, Codex).",
    )
    parser.add_argument("--home", default=idx.DEFAULT_HOME,
                        help=f"state directory (default: {idx.DEFAULT_HOME})")
    sub = parser.add_subparsers(dest="cmd")

    p = sub.add_parser("index", help="scan transcripts into the local database")
    p.add_argument("--force", action="store_true", help="re-parse unchanged files")
    p.set_defaults(func=cmd_index)

    p = sub.add_parser("serve", help="run the dashboard (default command)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--reindex", action="store_true", help="refresh before serving")
    p.add_argument("--force", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--no-pick-port", action="store_true",
                   help="fail instead of trying the next free port")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("stats", help="print summary tables to the terminal")
    p.add_argument("--since", help="only days on/after YYYY-MM-DD")
    p.set_defaults(func=cmd_stats)

    args = parser.parse_args(argv)
    if not args.cmd:  # bare invocation serves the dashboard
        args = parser.parse_args(["serve", *(argv or [])])
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
