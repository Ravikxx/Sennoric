#!/usr/bin/env python3.13
"""Smoke-test the DaVinci Resolve MCP tools against the LIVE bridge.

Talks directly to the bridge on 127.0.0.1:9876 — no Sennoric needed. Start the
bridge first (in Resolve: Workspace -> Scripts -> Utility -> resolve_bridge),
open any project with a timeline, then run:

    python3.13 mcp-servers/davinci-resolve/test_tools.py

It lists all tools, then exercises the read-only ones and (with --write) does a
reversible marker round-trip. Nothing here deletes clips or renders.
"""
import socket, json, sys, itertools

_id = itertools.count(1)

def call(sock, method, params=None):
    msg = {"jsonrpc": "2.0", "id": next(_id), "method": method, "params": params or {}}
    sock.sendall((json.dumps(msg) + "\n").encode())
    buf = b""
    sock.settimeout(30)
    while b"\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            raise ConnectionError("bridge closed the connection")
        buf += chunk
    return json.loads(buf.split(b"\n", 1)[0].decode())

def text_of(reply):
    r = reply.get("result", {})
    if isinstance(r, dict) and r.get("content"):
        return ("[isError] " if r.get("isError") else "") + r["content"][0].get("text", "")
    return json.dumps(reply)

def main():
    write = "--write" in sys.argv
    try:
        s = socket.create_connection(("127.0.0.1", 9876), timeout=3)
    except OSError:
        print("FAIL: nothing listening on 127.0.0.1:9876.\n"
              "Start the bridge in Resolve: Workspace -> Scripts -> Utility -> resolve_bridge")
        return 1

    init = call(s, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                   "clientInfo": {"name": "test_tools", "version": "1"}})
    print("connected:", init["result"]["serverInfo"]["name"])

    tools = call(s, "tools/list")["result"]["tools"]
    print(f"\n{len(tools)} tools registered:")
    for t in tools:
        print("  -", t["name"])

    def run(name, args=None, label=None):
        print(f"\n=== {label or name} ===")
        print(text_of(call(s, "tools/call", {"name": name, "arguments": args or {}})))

    # Read-only checks
    run("resolve_get_info")
    run("resolve_list_timelines")
    run("resolve_list_timeline_clips")
    run("resolve_list_markers")

    # Reversible write check (only with --write)
    if write:
        print("\n--- write round-trip (marker at frame 0) ---")
        print(text_of(call(s, "tools/call", {"name": "resolve_add_marker",
              "arguments": {"frame": 0, "color": "Green", "name": "sennoric-test",
                            "note": "created by test_tools.py"}})))
        print(text_of(call(s, "tools/call", {"name": "resolve_list_markers", "arguments": {}})))
        print("(remove it in Resolve: right-click the marker on the timeline ruler -> Delete)")

    s.close()
    print("\nDone.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
