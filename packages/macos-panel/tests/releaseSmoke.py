import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("Packaged desktop smoke runs only in isolated GitHub Actions")

output = Path(sys.argv[1]).resolve()
archive = next(output.glob("*-mac-arm64.zip"))
assets = json.loads((output / "assets.json").read_text())["assets"]
asset = next(item for item in assets if item["name"] == archive.name)
actual = "sha256:" + hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
if actual != asset["digest"]:
    raise SystemExit("Published asset checksum mismatch")
subprocess.run(["ditto", "-x", "-k", str(archive), str(output / "bundle")], check=True)
bundle = next((output / "bundle").glob("*.app"))
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(bundle)], check=True)
executable = bundle / "Contents" / "MacOS" / "Cherry Studio"
logs = Path.home() / "Library" / "Logs" / "CherryStudio"
result = {"sha256": actual, "bootstrap": False}
started = time.monotonic()
with (output / "stdout.log").open("wb") as stdout, (output / "stderr.log").open("wb") as stderr:
    process = subprocess.Popen([str(executable)], stdout=stdout, stderr=stderr)
    try:
        while time.monotonic() - started < 75:
            if process.poll() is not None:
                result["exitCode"] = process.returncode
                break
            if any("Bootstrap complete" in path.read_text(errors="replace") for path in logs.glob("app.*.log")):
                result["bootstrap"] = True
                time.sleep(3)
                result["stable"] = process.poll() is None
                break
            time.sleep(1)
        subprocess.run(["screencapture", "-x", str(output / "startup.png")], check=False)
    finally:
        result["elapsedSeconds"] = time.monotonic() - started
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for path in logs.glob("app.*.log"):
            shutil.copy2(path, output / path.name)
        (output / "startup.json").write_text(json.dumps(result, indent=2))
if not result["bootstrap"] or not result.get("stable"):
    raise SystemExit("Packaged release did not complete a stable bootstrap; inspect startup evidence")
