"""Google Meet Bridge — Playwright browser that joins Google Meet
and bridges audio to/from a LiveKit room.

Usage:
    python main.py --meet-url "https://meet.google.com/abc-defg-hij" \
                   --room-name "meet-12345678"

The bridge:
1. Launches a persistent Chrome browser (preserving Google login session)
2. Injects RTCPeerConnection/getUserMedia overrides BEFORE navigating to Meet
3. Navigates to the Google Meet URL and joins the call
4. Injects bridge.js which captures Meet audio and publishes to LiveKit
5. Monitors for meeting end and cleans up
"""

import argparse
import asyncio
import json
import logging
import os
import signal
from pathlib import Path

from dotenv import load_dotenv
from livekit import api
from playwright.async_api import async_playwright

from meet_automation import join_meeting, detect_meeting_ended

# Load env from project root
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("bridge")

# Path to persistent Chrome profile for Google login
CHROME_PROFILE_DIR = str(Path(__file__).resolve().parent / ".chrome-profile")

# Path to the bridge.js script
BRIDGE_JS_PATH = Path(__file__).resolve().parent / "bridge.js"


async def generate_bridge_token(room_name: str) -> str:
    """Generate a LiveKit token for the bridge participant."""
    token = api.AccessToken(
        os.environ["LIVEKIT_API_KEY"],
        os.environ["LIVEKIT_API_SECRET"],
    )
    token.with_identity("google-meet-bridge")
    token.with_name("Google Meet Bridge")
    token.with_grants(
        api.VideoGrants(
            room_join=True,
            room=room_name,
            can_publish=True,
            can_subscribe=True,
            can_publish_data=True,
        )
    )
    return token.to_jwt()


async def run_bridge(meet_url: str, room_name: str) -> None:
    """Main bridge loop."""
    livekit_url = os.environ["LIVEKIT_URL"]
    livekit_token = await generate_bridge_token(room_name)

    logger.info(f"Starting bridge: Meet={meet_url}, Room={room_name}")

    async with async_playwright() as p:
        # Launch Chrome with persistent profile (preserves Google login)
        context = await p.chromium.launch_persistent_context(
            user_data_dir=CHROME_PROFILE_DIR,
            headless=False,
            channel="chrome",
            args=[
                "--use-fake-ui-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            ignore_default_args=["--mute-audio", "--enable-automation"],
            bypass_csp=True,
            viewport={"width": 1280, "height": 720},
        )

        page = context.pages[0] if context.pages else await context.new_page()

        try:
            # Inject the bridge config and overrides BEFORE navigating to Meet.
            # We use add_init_script so the overrides are in place when Meet's
            # JavaScript runs (RTCPeerConnection and getUserMedia must be
            # overridden before Meet creates its peer connections).
            bridge_config = {
                "livekitUrl": livekit_url,
                "livekitToken": livekit_token,
                "roomName": room_name,
            }

            # Read bridge.js source
            bridge_js_source = BRIDGE_JS_PATH.read_text()

            # Set up init script that sets config and overrides
            # Note: bridge.js is an async IIFE that self-executes
            await page.add_init_script(
                f"window.__BRIDGE_CONFIG__ = {json.dumps(bridge_config)};"
            )

            # Join the Google Meet
            logger.info("Joining Google Meet...")
            joined = await join_meeting(page, meet_url)

            if not joined:
                logger.error("Failed to join Google Meet")
                return

            # Now inject bridge.js (after joining, so Meet's RTCPeerConnections
            # are already created and our override has captured their tracks)
            logger.info("Injecting audio bridge script...")

            # Load LiveKit SDK via Playwright's add_script_tag which uses CDP
            # and bypasses Google Meet's Trusted Types CSP enforcement
            logger.info("Loading LiveKit SDK...")
            await page.add_script_tag(
                url="https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.js"
            )
            await page.wait_for_function(
                "typeof window.LivekitClient !== 'undefined'", timeout=10000
            )
            logger.info("LiveKit SDK loaded")

            # Inject bridge.js via add_script_tag (also bypasses Trusted Types)
            await page.add_script_tag(content=bridge_js_source)

            logger.info("Bridge is active — monitoring meeting...")

            # Monitor loop: check for meeting end
            while True:
                await asyncio.sleep(10)

                ended = await detect_meeting_ended(page)
                if ended:
                    logger.info("Meeting has ended")
                    break

                # Check if page is still open
                if page.is_closed():
                    logger.info("Page was closed")
                    break

        except asyncio.CancelledError:
            logger.info("Bridge cancelled — cleaning up")
        except Exception:
            logger.exception("Bridge error")
        finally:
            logger.info("Closing browser...")
            await context.close()


def main():
    parser = argparse.ArgumentParser(description="Google Meet Bridge")
    parser.add_argument("--meet-url", required=True, help="Google Meet URL to join")
    parser.add_argument("--room-name", required=True, help="LiveKit room name")
    args = parser.parse_args()

    # Handle SIGTERM/SIGINT for graceful shutdown
    loop = asyncio.new_event_loop()

    def shutdown(sig):
        logger.info(f"Received signal {sig} — shutting down")
        for task in asyncio.all_tasks(loop):
            task.cancel()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown, sig)

    try:
        loop.run_until_complete(run_bridge(args.meet_url, args.room_name))
    except asyncio.CancelledError:
        pass
    finally:
        loop.close()
        logger.info("Bridge shut down")


if __name__ == "__main__":
    main()
