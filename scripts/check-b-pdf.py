"""Read generated PDF text and page geometry. Requires the bundled pdfplumber runtime."""
import json
from pathlib import Path
import pdfplumber

root = Path(__file__).resolve().parent.parent / "docs/build/evidence/b/pdf"
expected = json.loads((root / "expected.json").read_text())
results = {}
for name in ["quote-500.pdf", "quote-long.pdf"]:
    with pdfplumber.open(root / name) as document:
        pages = [page.extract_text() or "" for page in document.pages]
        text = "\n".join(pages)
        for value in expected["expected"]:
            assert value in text, (name, "missing buyer-facing field", value)
        for value in expected["forbidden"]:
            assert value not in text, (name, "internal field leaked", value)
        assert all("SIMULATION" in page for page in pages), (name, "missing page simulation label")
        assert all(len(page) > 100 for page in pages), (name, "unexpected blank/footer-only page")
        for page in document.pages:
            assert all(40 <= char["x0"] < page.width - 35 for char in page.chars), (name, "horizontal overflow")
            assert all(32 <= char["top"] < page.height - 25 for char in page.chars), (name, "vertical overflow")
        if name == "quote-long.pdf":
            assert len(pages) > 1 and "Confirmation 35:" in text
        (root / (name + ".txt")).write_text(text)
        results[name] = {"pages": len(pages), "text_checks": "passed", "cjk": "passed", "geometry": "passed"}
(root / "text-check.json").write_text(json.dumps(results, indent=2))
print(json.dumps(results))
