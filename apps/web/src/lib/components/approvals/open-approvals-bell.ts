/** The window event the header bell listens for, so a pending row anywhere
 * on the page can open the one approvals inbox instead of a menu of its own. */
export const OPEN_APPROVALS_BELL_EVENT = "onecli:open-approvals-bell";

export const openApprovalsBell = () => {
  window.dispatchEvent(new Event(OPEN_APPROVALS_BELL_EVENT));
};
