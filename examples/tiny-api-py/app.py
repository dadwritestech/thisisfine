"""Fine Notes API: a tiny HTTP service with no dependencies.

Used by thisisfine's walkthrough and end-to-end test. It ships with a bug on
purpose: an expired session token still gets you in.

    python app.py --port 8000
    curl -H "Authorization: Bearer old-token" localhost:8000/me
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# token -> session; "old-token" expired on 2000-01-01
SESSIONS = {
    "alice-token": {"user": "alice", "expires": 4102444800},
    "old-token": {"user": "alice", "expires": 946684800},
}


def session_for(header):
    token = header[len("Bearer "):] if header.startswith("Bearer ") else ""
    session = SESSIONS.get(token)
    if session is None:
        return None, "unknown token"
    return session, None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            return self.reply(200, {"ok": True})
        if self.path == "/me":
            session, error = session_for(self.headers.get("Authorization", ""))
            if error:
                return self.reply(401, {"error": error})
            return self.reply(200, {"user": session["user"]})
        self.reply(404, {"error": "not found"})

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else int(os.environ.get("PORT", "8000"))
    print(f"Fine Notes API on http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
