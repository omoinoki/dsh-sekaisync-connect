"""Serve a disposable synthetic store for the connect integration check."""
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from sekaisync import dbstore
from sekaisync.core import SekaiSyncCore
from sekaisync.http_server import serve_http
from sekaisync.models import Entity

store = Path(sys.argv[2])
dbstore.initialize(store)
dbstore.save_entities(store, [Entity(id="character:1", type="character", region="jp",
    names={"ja": "星乃一歌", "en": "Ichika"}, source="master_db", trust="official")])
text = ("星乃一歌🙂 段落 with 長文。\n" * 20000)[:200000]
dbstore.upsert_web_pages(store, "altsource_ms", [
    {"id": str(i), "title": "integrationneedle" if i < 6 else "other story", "text": text,
     "language": "ja", "kind": "event_story", "trust": "community",
     "url": f"https://example.invalid/story/{i}"} for i in range(80)
])
serve_http(SekaiSyncCore(store), host="127.0.0.1", port=0, sites=())
