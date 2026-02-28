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

# Path to the bridge scripts
BRIDGE_INIT_JS_PATH = Path(__file__).resolve().parent / "bridge_init.js"
BRIDGE_JS_PATH = Path(__file__).resolve().parent / "bridge.js"


LIVEKIT_SDK_URL = "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.js"
_livekit_sdk_cache: str | None = None


async def _get_livekit_sdk() -> str:
    """Fetch and cache the LiveKit client SDK source."""
    global _livekit_sdk_cache
    if _livekit_sdk_cache is not None:
        return _livekit_sdk_cache

    import urllib.request
    logger.info(f"Downloading LiveKit SDK from {LIVEKIT_SDK_URL}...")
    with urllib.request.urlopen(LIVEKIT_SDK_URL) as resp:
        _livekit_sdk_cache = resp.read().decode("utf-8")
    logger.info(f"LiveKit SDK downloaded ({len(_livekit_sdk_cache)} bytes)")
    return _livekit_sdk_cache


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

        # Forward browser console logs to Python terminal
        page.on("console", lambda msg: logger.info(f"[browser:{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: logger.error(f"[browser:error] {err}"))

        try:
            bridge_config = {
                "livekitUrl": livekit_url,
                "livekitToken": livekit_token,
                "roomName": room_name,
            }

            # Read script sources
            bridge_init_js_source = BRIDGE_INIT_JS_PATH.read_text()
            bridge_js_source = BRIDGE_JS_PATH.read_text()

            # Inject via add_init_script (CDP — runs BEFORE page JS, no CSP).
            # This installs the RTCPeerConnection and getUserMedia overrides
            # so they're in place when Meet creates its peer connections.
            await page.add_init_script(
                f"window.__BRIDGE_CONFIG__ = {json.dumps(bridge_config)};\n"
                f"{bridge_init_js_source}"
            )

            # Join the Google Meet
            logger.info("Joining Google Meet...")
            joined = await join_meeting(page, meet_url)

            if not joined:
                logger.error("Failed to join Google Meet")
                return

            # Now inject bridge.js (post-join). The RTC overrides from
            # bridge_init.js have already captured Meet's audio tracks.
            # bridge.js connects to LiveKit and publishes the captured audio.
            logger.info("Injecting audio bridge script...")

            # Load LiveKit SDK. Google Meet has an AMD loader (`define`)
            # that hijacks UMD bundles. We fetch the source and wrap it in
            # a closure that shadows `define` as undefined, forcing the UMD
            # factory to use the global variable path instead.
            logger.info("Loading LiveKit SDK...")
            livekit_sdk_source = await _get_livekit_sdk()
            wrapped_sdk = (
                "(function(define) {\n"  # shadow define as undefined
                f"{livekit_sdk_source}\n"
                "})();\n"  # call with no args → define is undefined inside
            )
            await page.add_script_tag(content=wrapped_sdk)
            await page.wait_for_function(
                "typeof window.LivekitClient !== 'undefined' && typeof window.LivekitClient.Room === 'function'",
                timeout=10000,
            )
            logger.info("LiveKit SDK loaded")

            lk_keys = await page.evaluate(
                "Object.keys(window.LivekitClient).filter(k => typeof window.LivekitClient[k] === 'function').slice(0, 15)"
            )
            logger.info(f"LiveKit SDK exports: {lk_keys}")

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
