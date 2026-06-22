#!/usr/bin/env python3
"""Canary inject — UserPromptSubmit hook that reads canary signals and injects
a brief pressure summary when thresholds are exceeded."""
import json, os, pathlib, sys, time

data = json.load(sys.stdin)

root = pathlib.Path(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()))
signals_path = root / ".claude" / "state" / "canary_signals.json"

if not signals_path.exists():
    sys.exit(0)

try:
    signals = json.loads(signals_path.read_text())
except (json.JSONDecodeError, OSError):
    sys.exit(0)

# Session-staleness guard: the canary state file persists across conversations.
# On a fresh session, this hook fires on the user's first prompt BEFORE
# 10_canary_monitor.py has had a chance to run (no tool calls yet), so
# `signals` still holds the previous session's counters. Cross-check the
# session_id from hook input against the one stored in the file — if they
# mismatch, the data is from a previous session and we should not inject it
# as if it were the current session's pressure.
current_session = data.get("session_id", "")
stored_session = signals.get("session_id", "")
if current_session and stored_session and current_session != stored_session:
    sys.exit(0)

pressure = signals.get("pressure", 0.0)
if pressure < 0.5:
    sys.exit(0)

edit_count = signals.get("edit_count", 0)
file_count = len(signals.get("files_touched", []))
turn_count = signals.get("turn_count", 0)
components = signals.get("components", {})

# Read current phase
phase_path = root / ".claude" / "state" / "system_phase.json"
phase = "unknown"
if phase_path.exists():
    try:
        phase = json.loads(phase_path.read_text()).get("phase", "unknown")
    except (json.JSONDecodeError, OSError):
        pass

if pressure > 0.7:
    level = "HIGH"
    advice = "Strongly consider phase transition toward completion. Use /helm to evaluate."
elif pressure > 0.5:
    level = "MEDIUM"
    advice = "Monitor scope breadth. Avoid opening new explorations."
else:
    sys.exit(0)

summary = (
    f"[Canary {level}] Pressure: {pressure:.0%} | "
    f"Phase: {phase} | "
    f"Edits: {edit_count}, Files: {file_count}, Turns: {turn_count} | "
    f"Dominant: {max(components, key=components.get) if components else 'n/a'} | "
    f"{advice}"
)

print(summary)
sys.exit(0)
