import sqlite3
from pathlib import Path

p = Path(r"C:\dsh_projects\sekaisync-handoff-2026-08-14\store\kb\sekaisync.db")
url = "file:" + p.as_posix()
print("exists:", p.exists(), "size:", p.stat().st_size)

for label, u in (("ro", url + "?mode=ro"), ("rw", url), ("immutable", url + "?immutable=1")):
    try:
        c = sqlite3.connect(u, uri=True, timeout=15)
        ver = c.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        ent = c.execute("SELECT count(*) FROM entities").fetchone()
        print(f"{label}: OK schema_version={ver} entities={ent}")
        c.close()
    except Exception as e:
        print(f"{label}: FAIL {type(e).__name__}: {e}")

# also: is the file even a SQLite db?
with open(p, "rb") as fh:
    head = fh.read(16)
print("magic:", head)
