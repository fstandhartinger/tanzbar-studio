#!/usr/bin/env python3
"""Clear the studio conversation (feed) and show the first-visit intro again. Jobs and versions stay.
The gateway adopts the runner profile on the next sync because the new rev is higher than its own."""
import json, subprocess, time
p = "/home/flori/.local/state/tanzbar-studio/jobs.json"
subprocess.run(["systemctl", "--user", "stop", "tanzbar-studio-runner"], check=True)
d = json.load(open(p))
d["profile"] = {"rev": int(time.time()), "introDone": False, "feed": []}
json.dump(d, open(p, "w"), ensure_ascii=False, indent=1)
subprocess.run(["systemctl", "--user", "start", "tanzbar-studio-runner"], check=True)
print("feed cleared, intro will show again")
