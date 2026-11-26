"""Perps event decoder, adapted from research/jupiter-feasibility/raw/decode_events.py.

Same logic (Anchor self-CPI event decoding from inner instructions); changes: IDL is loaded
lazily from the vendored perps_idl.json, and only trade/liquidation events are kept by callers.
"""
import hashlib
import json
import os
import struct

PROGRAM = "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu"
EVENT_CPI_TAG = bytes.fromhex("e445a52e51cb9a1d")
_A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_IDL = None


def b58(s):
    n = 0
    for c in s:
        n = n * 58 + _A.index(c)
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + b


def b58e(b):
    n = int.from_bytes(b, "big")
    o = ""
    while n:
        n, r = divmod(n, 58)
        o = _A[r] + o
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + o


def _idl():
    global _IDL
    if _IDL is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "perps_idl.json")
        with open(path) as f:
            idl = json.load(f)
        types = {t["name"]: t["type"] for t in idl["types"]}
        ev = {}
        for e in idl["events"]:
            ev[hashlib.sha256(("event:" + e["name"]).encode()).digest()[:8]] = e
        _IDL = (types, ev)
    return _IDL


class _R:
    def __init__(s, b):
        s.b = b
        s.o = 0

    def t(s, n):
        v = s.b[s.o:s.o + n]
        assert len(v) == n, "short read"
        s.o += n
        return v


def _rd(r, t, types):
    if isinstance(t, str):
        f = {"u8": "<B", "u16": "<H", "u32": "<I", "u64": "<Q", "i64": "<q", "i32": "<i", "bool": "<?"}
        if t == "publicKey":
            return b58e(r.t(32))
        if t in ("u128", "i128"):
            lo, hi = struct.unpack("<QQ" if t == "u128" else "<Qq", r.t(16))
            return lo + (hi << 64)
        return struct.unpack(f[t], r.t(struct.calcsize(f[t])))[0]
    if "option" in t:
        return _rd(r, t["option"], types) if r.t(1)[0] else None
    if "defined" in t:
        d = types[t["defined"]]
        if d["kind"] == "enum":
            i = r.t(1)[0]
            v = d["variants"][i]
            if "fields" not in v:
                return v["name"]
            return {v["name"]: [_rd(r, x if isinstance(x, (str, dict)) else x["type"], types) for x in v["fields"]]}
        return {x["name"]: _rd(r, x["type"], types) for x in d["fields"]}
    if "array" in t:
        return [_rd(r, t["array"][0], types) for _ in range(t["array"][1])]
    if "vec" in t:
        return [_rd(r, t["vec"], types) for _ in range(struct.unpack("<I", r.t(4))[0])]
    raise ValueError("unsupported type %r" % (t,))


def decode_events(tx):
    """tx = getTransaction JSON-RPC response dict. Returns [(event_name, fields)]; undecodable -> ('UNKNOWN', hex)."""
    types, ev = _idl()
    res = tx["result"]
    la = res["meta"].get("loadedAddresses") or {}
    keys = res["transaction"]["message"]["accountKeys"] + la.get("writable", []) + la.get("readonly", [])
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in keys]
    out = []
    for ii in res["meta"].get("innerInstructions") or []:
        for ins in ii["instructions"]:
            if keys[ins["programIdIndex"]] != PROGRAM:
                continue
            d = b58(ins["data"])
            if d[:8] != EVENT_CPI_TAG:
                continue
            e = ev.get(d[8:16])
            if not e:
                out.append(("UNKNOWN", d[8:16].hex()))
                continue
            try:
                r = _R(d[16:])
                out.append((e["name"], {f["name"]: _rd(r, f["type"], types) for f in e["fields"]}))
            except Exception as exc:  # decode failure must not kill the run
                out.append(("DECODE_ERROR:" + e["name"], str(exc)))
    return out
