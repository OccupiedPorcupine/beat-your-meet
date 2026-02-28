"""Google Meet UI interaction helpers.

Handles the browser automation for joining a Google Meet call:
clicking through join screens, dismissing dialogs, and detecting
meeting state changes.
"""

import asyncio
import logging

from playwright.async_api import Page

logger = logging.getLogger("bridge.meet")


async def join_meeting(page: Page, meet_url: str) -> bool:
    """Navigate to a Google Meet URL and join the call.

    Returns True if successfully joined, False otherwise.
    """
    logger.info(f"Navigating to {meet_url}")
    await page.goto(meet_url, wait_until="networkidle", timeout=30000)

    # Wait for the page to settle
    await asyncio.sleep(3)

    # Dismiss any "Got it" / cookie consent dialogs
    await _dismiss_dialogs(page)

    # Turn off camera and mic before joining (we use injected audio instead)
    await _disable_camera_and_mic(page)

    # Click the join button
    joined = await _click_join_button(page)
    if not joined:
        logger.error("Failed to find and click join button")
        return False

    # Wait for the meeting to load (look for the meeting controls)
    try:
        await page.wait_for_selector(
            '[data-is-muted], [aria-label*="microphone"], [aria-label*="Turn off"]',
            timeout=30000,
        )
        logger.info("Successfully joined Google Meet")
        return True
    except Exception:
        logger.warning("Meeting controls not found — may be in waiting room")
        return await _handle_waiting_room(page)


async def _dismiss_dialogs(page: Page) -> None:
    """Dismiss common Google Meet pre-join dialogs."""
    dismiss_selectors = [
        'button:has-text("Got it")',
        'button:has-text("Dismiss")',
        'button:has-text("Accept")',
        'button:has-text("I understand")',
        '[aria-label="Close"]',
    ]
    for selector in dismiss_selectors:
        try:
            btn = page.locator(selector).first
            if await btn.is_visible(timeout=1000):
                await btn.click()
                await asyncio.sleep(0.5)
        except Exception:
            pass


async def _disable_camera_and_mic(page: Page) -> None:
    """Turn off camera on the pre-join screen.

    The mic is left ON because getUserMedia is overridden to return the
    agent audio stream as the "microphone". If Meet mutes the mic, agent
    audio won't reach other participants.
    """
    # Camera off button
    try:
        cam_btn = page.locator('[aria-label*="camera" i][data-is-muted="false"]').first
        if await cam_btn.is_visible(timeout=2000):
            await cam_btn.click()
            await asyncio.sleep(0.3)
    except Exception:
        pass


async def _click_join_button(page: Page) -> bool:
    """Find and click the 'Join now' or 'Ask to join' button."""
    join_selectors = [
        'button:has-text("Join now")',
        'button:has-text("Ask to join")',
        'button:has-text("Join")',
        '[jsname="Qx7uuf"]',  # Google Meet join button jsname (may change)
    ]
    for selector in join_selectors:
        try:
            btn = page.locator(selector).first
            if await btn.is_visible(timeout=2000):
                await btn.click()
                logger.info(f"Clicked join button: {selector}")
                return True
        except Exception:
            continue
    return False


async def _handle_waiting_room(page: Page) -> bool:
    """Wait for host admission (up to 5 minutes)."""
    logger.info("Appears to be in waiting room — waiting for host to admit...")

    # Poll for meeting controls appearing (means we were admitted)
    for _ in range(60):  # 60 * 5s = 5 minutes
        await asyncio.sleep(5)
        try:
            controls = page.locator(
                '[data-is-muted], [aria-label*="microphone"], [aria-label*="Turn off"]'
            )
            if await controls.first.is_visible(timeout=1000):
                logger.info("Admitted to meeting!")
                return True
        except Exception:
            pass

        # Check if we were denied
        try:
            denied = page.locator('text="You can\'t join this call"')
            if await denied.is_visible(timeout=500):
                logger.error("Meeting join was denied")
                return False
        except Exception:
            pass

    logger.error("Timed out waiting for admission (5 minutes)")
    return False


async def detect_meeting_ended(page: Page) -> bool:
    """Check if the meeting has ended."""
    end_indicators = [
        'text="You\'ve been removed from the meeting"',
        'text="The meeting has ended"',
        'text="You left the meeting"',
        'text="Return to home screen"',
    ]
    for selector in end_indicators:
        try:
            el = page.locator(selector)
            if await el.is_visible(timeout=500):
                return True
        except Exception:
            pass
    return False
