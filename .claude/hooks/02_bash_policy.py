#!/usr/bin/env python3
"""Block risky shell commands and enforce deterministic installs."""
import json, re, sys

def block(reason: str) -> None:
    print(f"Blocked by bash policy: {reason}", file=sys.stderr)
    sys.exit(2)

data = json.load(sys.stdin)
cmd = ((data.get("tool_input") or {}).get("command") or "").strip()
if not cmd:
    sys.exit(0)

c = cmd.lower()

deny = [
    (r"\bsudo\b", "sudo is not allowed from the agent"),
    (r"\brm\s+-rf\b\s+(/|~|\$home|\$root)", "destructive rm -rf target"),
    (r"\bmkfs\b|\bdd\b\s+if=/dev/", "disk-destructive command"),
    (r"\bshutdown\b|\breboot\b", "system power commands are not allowed"),
    (r"(curl|wget).*\|\s*(bash|sh|zsh)", "network-piped shell execution"),
    (r"\bgit\s+push\b.*--force", "force-push is blocked"),
]

deny_determinism = [
    (r"\bnpm\s+install\b", "use `npm ci` for lockfile-reproducible installs"),
    (r"\bpnpm\s+install\b(?!.*--frozen-lockfile)", "use `pnpm install --frozen-lockfile`"),
    (r"\byarn\s+install\b(?!.*--immutable)", "use `yarn install --immutable`"),
]

for pat, why in deny:
    if re.search(pat, c):
        block(why)

for pat, why in deny_determinism:
    if re.search(pat, c):
        block(why)

# gh defaults to the upstream parent (exa-labs), not the Kastalien-Research fork.
# Require an explicit repo target on PR creation to avoid PRs against upstream.
#
# Strip quoted text first so neither the literal string `gh pr create` nor a fake
# `-R` inside a --title/--body can be mistaken for a real command or repo flag.
# Treat `;`, `&`, `|`, `(`, backtick (command substitution), and newline as command
# boundaries, and allow benign wrappers (command/time/env/nohup/exec/builtin/stdbuf)
# before `gh`. The repo-flag check is scoped to each create command's own argument
# span so an -R on an unrelated earlier command cannot satisfy it.
c_clean = re.sub(r"'[^']*'|\"[^\"]*\"", " ", c)
boundary = r"[;&|(`\n]|&&|\|\|"
wrappers = r"(?:(?:command|time|env|nohup|exec|builtin|stdbuf)\s+)*"
for m in re.finditer(rf"(?:^|{boundary})\s*{wrappers}gh\s+pr\s+create\b", c_clean):
    args = re.split(boundary, c_clean[m.end():], maxsplit=1)[0]
    if not re.search(r"(^|\s)(-r|--repo)(\s|=)", args):
        block("`gh pr create` must set the target repo explicitly with -R <owner/repo> "
              "(gh defaults to the upstream parent, not the fork)")

sys.exit(0)
