#!/usr/bin/env python3
"""Test-only static server that also accepts POSTs, so the browser can hand
exported files back for verification.

Not part of the app — it exists so an automated browser run can prove that a
GIF/WebP/APNG produced in the page really decodes with the right frame count
and timing. Serves WEB/ on the given port; POST /collect/<name> writes the body
to tests/out/<name>.
"""

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "out")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        if not self.path.startswith("/collect/"):
            self.send_error(404)
            return
        name = os.path.basename(self.path[len("/collect/"):]) or "blob.bin"
        length = int(self.headers.get("Content-Length", 0))
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, name), "wb") as fh:
            fh.write(self.rfile.read(length))
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b"ok")

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8778
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
