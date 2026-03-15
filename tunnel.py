"""
tunnel.py — Start SmartNav AI with a public HTTPS tunnel via ngrok.

Usage:
  python tunnel.py                  # starts server + opens ngrok tunnel
  python tunnel.py --token <token>  # use your ngrok authtoken (free)

Get a free authtoken at: https://dashboard.ngrok.com/get-started/your-authtoken

The public HTTPS URL printed to the console works on any phone/browser
with full geolocation access — no certificate warnings.
"""

import argparse
import atexit
import os
import signal
import subprocess
import sys
import time


# ---------------------------------------------------------------------------
# Child process tracking — prevents ghost python processes on port 5000
# ---------------------------------------------------------------------------
_server_proc = None


def _cleanup_server():
    """Terminate the background Flask server if it is still running."""
    global _server_proc
    if _server_proc is not None and _server_proc.poll() is None:
        print("\n[tunnel.py] Stopping Flask server…")
        _server_proc.terminate()
        try:
            _server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _server_proc.kill()
            _server_proc.wait(timeout=3)
        _server_proc = None


def _signal_handler(signum, frame):
    """Handle SIGINT / SIGTERM by cleaning up and exiting."""
    _cleanup_server()
    sys.exit(0)


def main():
    global _server_proc

    parser = argparse.ArgumentParser()
    parser.add_argument("--token", help="ngrok authtoken (optional, free at ngrok.com)")
    parser.add_argument("--port",  default=5000, type=int)
    args = parser.parse_args()

    # Set token if provided
    if args.token:
        from pyngrok import conf
        conf.get_default().auth_token = args.token

    # Register cleanup handlers BEFORE starting the server
    atexit.register(_cleanup_server)
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    # Start Flask as a tracked subprocess (NOT a daemon thread)
    env = os.environ.copy()
    env["PYTHONPATH"] = os.path.dirname(__file__)
    _server_proc = subprocess.Popen(
        [sys.executable, "app.py"],
        cwd=os.path.dirname(__file__) or ".",
        env=env,
    )
    time.sleep(3)  # wait for Flask to boot

    # Check it actually started
    if _server_proc.poll() is not None:
        print("[tunnel.py] Flask server exited unexpectedly.")
        sys.exit(1)

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

        # Keep alive — wait for the server process instead of sleeping
        _server_proc.wait()

    except Exception as e:
        print(f"\n[tunnel.py] Could not start ngrok tunnel: {e}")
        print("  Get a free token at https://dashboard.ngrok.com")
        print(f"  Then run: python tunnel.py --token YOUR_TOKEN\n")
        print(f"  Server is running at: https://{_local_ip()}:{args.port}")
        print("  Trust the cert in Chrome: Advanced → Proceed to site\n")

        # Keep alive — wait for the server process
        try:
            _server_proc.wait()
        except KeyboardInterrupt:
            pass

    finally:
        _cleanup_server()


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
    main()
