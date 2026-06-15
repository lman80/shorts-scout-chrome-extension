#!/usr/bin/env python3
"""Generate the standalone website (web/index.html) from the extension board.

It reuses watchlist.html's exact markup + styles, injects Firebase + the chrome
shim (cloud-app.js), and removes the auto-load of watchlist.js (cloud-app.js
loads it after sign-in). Re-run this whenever watchlist.html / watchlist.js change.
"""
import shutil, pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
web = root / "web"

html = (root / "watchlist.html").read_text(encoding="utf-8")

FB = "https://www.gstatic.com/firebasejs/10.12.2"
head_inject = f"""
    <script src="{FB}/firebase-app-compat.js"></script>
    <script src="{FB}/firebase-auth-compat.js"></script>
    <script src="{FB}/firebase-firestore-compat.js"></script>
    <script src="firebase-config.js"></script>
    <script src="cloud-app.js"></script>
    <style>
      #cloud-gate {{ position: fixed; inset: 0; z-index: 200; display: none; place-items: center;
        background: radial-gradient(900px 500px at 50% 0%, #15151b, #0a0a0b); }}
      .cg-box {{ text-align: center; max-width: 380px; padding: 30px; }}
      .cg-logo {{ width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 14px;
        background: linear-gradient(135deg, #ff0033, #ff5a7a); display: grid; place-items: center; font-size: 28px; }}
      .cg-box h1 {{ font-size: 24px; margin: 0 0 6px; }}
      .cg-box h2 {{ font-size: 18px; margin: 0 0 8px; }}
      .cg-box p {{ color: #9b9ba6; margin: 0 0 18px; line-height: 1.5; }}
      .cg-box code {{ background: #1d1d22; padding: 1px 6px; border-radius: 5px; }}
      .cg-btn {{ background: #ff0033; color: #fff; border: none; border-radius: 10px; padding: 12px 22px;
        font-size: 15px; font-weight: 700; cursor: pointer; }}
      .cg-btn:hover {{ background: #e0002d; }}
      #cloud-acct {{ position: fixed; right: 14px; bottom: 14px; z-index: 70; display: flex; align-items: center; gap: 8px;
        background: #16161a; border: 1px solid #2a2a31; border-radius: 999px; padding: 6px 8px 6px 12px; box-shadow: 0 8px 30px rgba(0,0,0,.45); }}
      .ca-status {{ font-size: 11px; color: #6e6e78; }}
      .ca-btn {{ background: #1d1d22; border: 1px solid #2a2a31; color: #f4f4f6; border-radius: 999px;
        padding: 6px 11px; font-size: 12px; font-weight: 600; cursor: pointer; }}
      .ca-btn:hover {{ background: #25252b; }}
      .ca-av {{ width: 26px; height: 26px; border-radius: 50%; }}
    </style>
"""
html = html.replace("</head>", head_inject + "  </head>", 1)

# cloud-app.js injects watchlist.js itself after auth, so drop the auto-load.
html = html.replace('<script src="watchlist.js"></script>', '<!-- watchlist.js loaded by cloud-app.js after sign-in -->')

(web / "index.html").write_text(html, encoding="utf-8")
for f in ("watchlist.js", "marked.min.js"):
    shutil.copy(root / f, web / f)
print("Built web/index.html and copied watchlist.js + marked.min.js")
