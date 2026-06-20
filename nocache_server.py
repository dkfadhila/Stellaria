import http.server
import os

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory="G:/via/Stellaria/build", **kwargs)

if __name__ == '__main__':
    server = http.server.HTTPServer(('127.0.0.1', 5199), NoCacheHandler)
    print("Serving on port 5199 with no-cache headers")
    server.serve_forever()
