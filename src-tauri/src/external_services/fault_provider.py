import json
import os
from pathlib import Path
import select
import sys
import threading
import time

mode, version, directory = sys.argv[1:]
version = int(version)
root = Path(directory)
output_lock = threading.Lock()
with (root / "launches").open("a") as launches:
    launches.write(f"{os.getpid()}\n")


def emit(message):
    with output_lock:
        print(json.dumps(message), flush=True)


def reply(message, result):
    emit({"jsonrpc": "2.0", "id": message["id"], "result": result})


def read_message():
    data = bytearray()
    while True:
        byte = os.read(0, 1)
        if not byte:
            raise SystemExit
        if byte == b"\n":
            return json.loads(data)
        data.extend(byte)


if mode == "no_read":
    while True:
        time.sleep(1)

initialize = read_message()
if mode == "slow_initialize":
    time.sleep(0.25)
reply(initialize, {
    "protocolVersion": version,
    "providerVersion": "fault-injection",
    "capabilities": {"invoke": True, "jobs": True, "cancellation": True, "maxConcurrentJobs": 1},
    "operations": ["test.invoke.v1"],
})
(root / "ready").write_text("ready")

if mode in ("partial", "blocked"):
    if mode == "partial":
        fragment = os.read(0, 1024)
        (root / "fragment").write_bytes(fragment)
    while True:
        time.sleep(1)


def delayed(message):
    value = message["params"]["params"].get("value", "late")
    release = "release_new" if value == "new" else "release"
    while not (root / release).exists():
        time.sleep(0.005)
    reply(message, {"value": value, "pid": os.getpid()})
    (root / "late_sent").write_text("sent")


while True:
    message = read_message()
    method = message.get("method")
    if method == "bibit.shutdown":
        break
    if method == "bibit.cancel":
        (root / "cancel").write_text(json.dumps(message))
        continue
    if method == "bibit.invoke":
        params = message["params"]["params"]
        with (root / "requests").open("a") as requests:
            requests.write(json.dumps(params) + "\n")
        if params.get("hold"):
            (root / "held").write_text("held")
            if version == 1:
                if select.select([0], [], [], 0.15)[0]:
                    (root / "overlap").write_text("overlap")
                time.sleep(0.1)
                reply(message, {"value": "first", "pid": os.getpid()})
            else:
                threading.Thread(target=delayed, args=(message,), daemon=True).start()
        elif mode == "slow_initialize":
            time.sleep(0.25)
            reply(message, {"pid": os.getpid()})
        else:
            reply(message, {"value": params.get("value"), "pid": os.getpid()})
