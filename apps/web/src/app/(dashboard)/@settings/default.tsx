/**
 * The `@settings` slot (plans/flatten-ui.md): the Settings modal
 * renders in parallel with whatever page is under it, from the same URL.
 * This default fills the slot on every route the slot has no page for, and
 * on soft navigations into one, with nothing.
 */
export default function SettingsSlotDefault() {
  return null;
}
