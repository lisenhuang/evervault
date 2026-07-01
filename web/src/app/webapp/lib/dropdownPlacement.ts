// Shared by ModelSelect/VoiceSelect: both portal a viewport-`position: fixed` listbox below their
// trigger button. Near the bottom of a short mobile screen (e.g. the settings drawer's last field)
// that leaves almost no room below, so the list opens upward instead when there's more space above.

const MAX_HEIGHT = 256; // matches Tailwind's max-h-64, the "plenty of room" case
const MARGIN = 8; // gap kept from the trigger and from the viewport edge
const MIN_COMFORTABLE = 160; // ~4 rows; below this we bother flipping if it helps

export function computeDropdownPlacement(rect: DOMRect): { openUp: boolean; maxHeight: number } {
  const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
  const spaceAbove = rect.top - MARGIN;
  const openUp = spaceBelow < MIN_COMFORTABLE && spaceAbove > spaceBelow;
  const maxHeight = Math.max(120, Math.min(MAX_HEIGHT, openUp ? spaceAbove : spaceBelow));
  return { openUp, maxHeight };
}
