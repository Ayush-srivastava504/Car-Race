/**
 * Single source of truth for device/input detection.
 *
 * Previously main.ts computed `mobileMode` (UA sniff + coarse-pointer media
 * query, used for renderer quality/camera FOV/shadow settings) while
 * input.ts separately computed `isTouch` (ontouchstart/maxTouchPoints,
 * used to decide whether to show the on-screen touch controls at all).
 * These two checks can disagree — e.g. a device with a coarse pointer but
 * no real touch support would get mobile rendering/camera tuning but no
 * touch UI, or a touch-capable laptop would get touch controls but
 * desktop-tier rendering — so what the game *looks* tuned for and what
 * controls it *shows* could silently mismatch. Both files now import from
 * here instead of computing their own answer.
 */

/** True if the device can receive real touch events. */
export const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;

/** True if the primary pointer is coarse (finger-sized), per the CSS media query. */
export const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

/** True if the UA string or viewport width looks like a phone/tablet. */
export const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 820;

/**
 * Drives renderer quality, camera FOV, and shadow settings. Touch capability
 * is included here too (not just UA/pointer-shape) so a touch-capable
 * device that fails the UA/coarse-pointer checks still gets mobile-tier
 * perf/camera tuning to match the touch controls it will actually show.
 */
export const mobileMode = isMobileUA || isCoarsePointer || hasTouch;
