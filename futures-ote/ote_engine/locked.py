"""Configuration A (the owner-approved OTE settings) is LOCKED for every historical run.

The literal values below are the approved inputs listed in PHASE1-STATUS.md. Tests and the QuantConnect self-check verify that the engine
defaults (ote_engine.strategy.Settings) still equal them and that their hash is unchanged, so a strategy edit cannot slip
into a backtest unnoticed. Changing them requires a new, separately approved configuration, not an edit here.
"""
import dataclasses
import hashlib
import json

CONFIG_A = {
    "swing_len": 5, "min_leg_atr": 3.5, "max_age": 32, "entry_mode": "Limit @ 0.705", "sl_mode": "Swing origin (1.0)", "sl_buf": 0.1,
    "tp2_ext": 0.25, "min_score": 1, "use_fvg": True, "use_ob": True, "use_rb": True, "fvg_min_atr": 0.1, "disp_atr": 1.0, "rb_wick": 0.5,
    "rb_min_atr": 0.8, "rb_look": 8, "max_zones": 70, "allow_long": True, "allow_short": True, "risk_usd": 10.0, "use_be": True,
    "be_frac": 0.45, "use_trail": True, "trail_frac": 0.05, "trail_len": 3, "trail_buf": 0.05, "use_hours": False, "use_sleep": False,
    "weekend_flat": False,
}
CONFIG_A_SHA256 = "ab5168761da91e0cb3a4215c08091dd74e80bdfc3ec692bff94ed0c4ccecaf18"


def digest(d) -> str:
    return hashlib.sha256(json.dumps(d, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def check():
    """(ok, detail). ok only if the engine defaults equal CONFIG_A and CONFIG_A still has its recorded hash."""
    from ote_engine.strategy import Settings
    cur = dataclasses.asdict(Settings())
    if digest(CONFIG_A) != CONFIG_A_SHA256:
        return False, "CONFIG_A no longer matches its recorded hash"
    diff = sorted(k for k in set(cur) | set(CONFIG_A) if cur.get(k) != CONFIG_A.get(k))
    return (not diff), ("unchanged, sha256 " + CONFIG_A_SHA256[:16]) if not diff else f"engine defaults differ from Configuration A: {diff}"
