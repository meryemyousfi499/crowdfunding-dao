#!/usr/bin/env python3
"""Serveur web de démonstration SANS cache (le navigateur recharge toujours les derniers fichiers).
Usage (depuis la racine du projet) :  python scripts/serve.py   puis ouvrir http://localhost:3000/frontend/
"""
import http.server

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

if __name__ == "__main__":
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 3000), NoCacheHandler)
    print("Serveur sans cache : http://localhost:3000/frontend/   (Ctrl+C pour arrêter)")
    srv.serve_forever()