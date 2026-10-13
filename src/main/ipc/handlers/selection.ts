import { application } from '@application'
import type { selectionRequestSchemas } from '@shared/ipc/schemas/selection'
import type { IpcHandlersFor } from '@shared/ipc/types'

/**
 * Thin adapters for the selection request routes: each one translates a parsed
 * route call into a `SelectionService` method (business logic + resource lifecycle
 * stay in that service).
 */
export const selectionHandlers: IpcHandlersFor<typeof selectionRequestSchemas> = {
  'selection.close_action_windows': async () => {
    application.get('SelectionService').closeActionWindows()
  },
  'selection.hide_toolbar': async () => {
    application.get('SelectionService').hideToolbar()
  },
  'selection.write_to_clipboard': async (text) =>
    (await application.get('SelectionService').writeToClipboard(text)) ?? false,
  'selection.determine_toolbar_size': async ({ width, height }) => {
    application.get('SelectionService').determineToolbarSize(width, height)
  },
  'selection.process_action': async ({ actionItem }) => {
    application.get('SelectionService').processAction(actionItem)
  },
  'selection.pin_action_window': async (isPinned, ctx) => {
    if (ctx.senderId) application.get('SelectionService').setActionWindowPinned(ctx.senderId, isPinned)
  },
  'selection.action_window_ready': async ({ requestId }, { senderId }) => {
    if (senderId) application.get('SelectionService').markActionWindowReady(senderId, requestId)
  },
  'selection.resize_agent_window': async (layout, ctx) => {
    if (ctx.senderId) application.get('SelectionAgentWindowService').resize(ctx.senderId, layout)
  },
  'selection.set_agent_window_replaceable': async (replaceable, ctx) => {
    if (ctx.senderId) application.get('SelectionAgentWindowService').setReplaceable(ctx.senderId, replaceable)
  },
  'selection.update_agent_summary': async (summary, ctx) => {
    if (ctx.senderId) application.get('SelectionAgentWindowService').setSummary(ctx.senderId, summary)
  },
  'selection.collapse_agent_window': async (_, ctx) => {
    if (ctx.senderId) application.get('SelectionAgentWindowService').collapse(ctx.senderId)
  },
  'selection.dismiss_blurred_agent_window': async (dismissal, ctx) => {
    if (ctx.senderId) application.get('SelectionAgentWindowService').dismissBlurred(ctx.senderId, dismissal)
  },
  'selection.determine_capsule_size': async (size, ctx) => {
    if (ctx.senderId) application.get('SelectionAgentWindowService').fitCapsuleHost(ctx.senderId, size)
  },
  'selection.restore_agent_window': async (windowId, ctx) => {
    if (ctx.senderId) application.get('SelectionAgentWindowService').restore(ctx.senderId, windowId)
  },
  'selection.close_agent_window': async (windowId, ctx) => {
    if (ctx.senderId) application.get('SelectionAgentWindowService').closeCollapsed(ctx.senderId, windowId)
  },
  'selection.get_linux_env_info': async () => application.get('SelectionService').getLinuxEnvInfo()
}
