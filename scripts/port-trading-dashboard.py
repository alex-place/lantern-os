#!/usr/bin/env python3
"""
One-off script: extract DASHBOARD_HTML and NEWS_HTML from the AI Trader's
dashboard.py and write them out as static pages for LanternOS, rewriting
the fetch endpoints to go through the LanternOS proxy routes under
/api/trading/dashboard/*.
"""

import re

SRC = r"C:\Independant AI Trader\dashboard.py"
OUT_DASHBOARD = r"C:\Users\krisk\Desktop\lanternOS\public\trading.html"
OUT_NEWS = r"C:\Users\krisk\Desktop\lanternOS\public\trading-news.html"

with open(SRC, "r", encoding="utf-8") as f:
    src = f.read()

# Codepoints produced by decoding a single byte (0x00-0xFF) as cp1252 that
# can be losslessly re-encoded back to that same byte. Mojibake produced by
# "UTF-8 bytes decoded as cp1252, re-encoded as UTF-8" is made up of these.
_SAFE = set()
for _byte in range(0x100):
    try:
        _ch = bytes([_byte]).decode("cp1252")
        if _ch.encode("cp1252") == bytes([_byte]):
            _SAFE.add(_ch)
    except UnicodeDecodeError:
        pass


def fix_mojibake(text):
    """dashboard.py mixes correctly-encoded Unicode (real em dashes,
    box-drawing chars) with double-UTF-8-encoded mojibake. Find minimal
    2-4 char islands that are the cp1252-byte-decomposition of a single
    valid multi-byte UTF-8 character and collapse them, leaving everything
    else (including already-correct text) untouched."""
    out = []
    i, n = 0, len(text)
    while i < n:
        replaced = False
        for width in (4, 3, 2):
            if i + width > n:
                continue
            window = text[i:i + width]
            if not all(c in _SAFE for c in window):
                continue
            try:
                raw = window.encode("cp1252")
                decoded = raw.decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                continue
            if len(decoded) == 1 and ord(decoded) >= 0x80:
                out.append(decoded)
                i += width
                replaced = True
                break
        if not replaced:
            out.append(text[i])
            i += 1
    result = "".join(out)
    # '<-' arrow (U+2190, bytes E2 86 90): byte 0x90 decodes to a control
    # char outside _SAFE, so the 3-char window above never matches. The
    # 2-char remnant left behind is U+00E2 U+2020; patch it directly.
    result = result.replace("â†", "←")
    return result


def extract(name):
    m = re.search(name + r' = r"""(.*?)"""\n', src, re.DOTALL)
    if not m:
        raise SystemExit(f"Could not find {name} in {SRC}")
    return fix_mojibake(m.group(1))


dashboard_html = extract("DASHBOARD_HTML")
news_html = extract("NEWS_HTML")

# Rewrite dashboard fetch endpoints -> LanternOS proxy routes
dash_replacements = {
    "fetch('/api/zones')": "fetch('/api/trading/dashboard/zones')",
    "fetch('/api/watchlist-prices')": "fetch('/api/trading/dashboard/watchlist-prices')",
    "fetch('/api/positions')": "fetch('/api/trading/dashboard/positions')",
    "fetch('/api/market-status')": "fetch('/api/trading/dashboard/market-status')",
    "fetch('/api/agent-log')": "fetch('/api/trading/dashboard/agent-log')",
    "fetch('/api/orders')": "fetch('/api/trading/dashboard/orders')",
    'href="/news" target="_blank"': 'href="/trading-news.html" target="_blank"',
}
for old, new in dash_replacements.items():
    if old not in dashboard_html:
        raise SystemExit(f"Pattern not found in DASHBOARD_HTML: {old!r}")
    dashboard_html = dashboard_html.replace(old, new)

# Rewrite news page fetch endpoints + back link
news_replacements = {
    "fetch('/api/news-feed')": "fetch('/api/trading/dashboard/news-feed')",
}
for old, new in news_replacements.items():
    if old not in news_html:
        raise SystemExit(f"Pattern not found in NEWS_HTML: {old!r}")
    news_html = news_html.replace(old, new)

# Back link to dashboard ("/" -> "/trading.html")
news_html = re.sub(r'(href=")/(" class="back-btn")', r'\1/trading.html\2', news_html)

with open(OUT_DASHBOARD, "w", encoding="utf-8") as f:
    f.write(dashboard_html.lstrip("\n"))

with open(OUT_NEWS, "w", encoding="utf-8") as f:
    f.write(news_html.lstrip("\n"))

print("Wrote", OUT_DASHBOARD)
print("Wrote", OUT_NEWS)
