"""
tunnel.py — Start SmartNav AI with a public HTTPS tunnel via ngrok.

Usage:
  python tunnel.py                  # starts server + opens ngrok tunnel
  python tunnel.py --token <token>  # use your ngrok authtoken (free)

Get a free authtoken at: https://dashboard.ngrok.com/get-started/your-authtoken

The public HTTPS URL printed to the console works on any phone/browser
with full geolocation access — no certificate warnings.
"""

import os, sys, threading, time, subprocess, argparse

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--token", help="ngrok authtoken (optional, free at ngrok.com)")
    parser.add_argument("--port",  default=5000, type=int)
    args = parser.parse_args()

    # Set token if provided
    if args.token:
        from pyngrok import conf
        conf.get_default().auth_token = args.token

    # Start Flask in a background thread
    env = os.environ.copy()
    env["PYTHONPATH"] = os.path.dirname(__file__)
    server = threading.Thread(
        target=lambda: subprocess.run(
            [sys.executable, "app.py"], cwd=os.path.dirname(__file__) or ".", env=env
        ),
        daemon=True,
    )
    server.start()
    time.sleep(3)  # wait for Flask to boot

    # Open ngrok tunnel
    try:
        from pyngrok import ngrok
        tunnel = ngrok.connect(args.port, "http")  # ngrok handles HTTPS automatically
        public_url = tunnel.public_url.replace("http://", "https://")
        print("\n" + "="*60)
        print("  SmartNav AI — PUBLIC HTTPS URL (works on any phone!)")
        print("="*60)
        print(f"\n  👉  {public_url}\n")
        print("  Open this URL on your phone. Chrome will grant GPS access.")
        print("  Press Ctrl+C to stop.\n")
        print("="*60 + "\n")

        # Keep alive
        while True:
            time.sleep(1)

    except Exception as e:
        print(f"\n[tunnel.py] Could not start ngrok tunnel: {e}")
        print("  Get a free token at https://dashboard.ngrok.com")
        print(f"  Then run: python tunnel.py --token YOUR_TOKEN\n")
        print(f"  Server is running at: https://{_local_ip()}:{args.port}")
        print("  Trust the cert in Chrome: Advanced → Proceed to site\n")

        # Keep server alive
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass


def _local_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nShutting down…")
