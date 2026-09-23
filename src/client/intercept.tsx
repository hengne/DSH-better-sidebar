/**
 * Interception of the chat's produced-files row: the turn-tail chain entry
 * that replaces ui-deliverables' row when the closing turn produced files.
 * The takeover looks identical (same chip row); the chips open the file in
 * the sidebar instead of the host OS. Priority -1 runs before the default-0
 * deliverables entry; when nothing was produced the selector returns null
 * and the original row renders unchanged.
 */
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { revealPaths, type SidebarStore } from './state.ts'
import { t } from './locales.ts'
import { resolveSidebarPath, selectProducedFiles } from './produced-files.ts'
import css from './sidebar.module.css'

/** Open a file in the sidebar's editor (used by the intercepted row and the explorer). */
export function openSidebarFile(ctx: Context, store: SidebarStore, sessionId: string, path: string): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const absolute = resolveSidebarPath(summary?.cwd, path)
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
  // Route through the sidebar service so the editor descriptor's dedupeKey
  // (per-path) applies; the id is path-derived so multiple editors coexist.
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title, path: absolute, id: `editor:${absolute}` })
}

/**
 * Reveal the produced files in the sidebar explorer: expand their parent
 * directories, highlight the rows, and focus the explorer tab. Unknown
 * files fall back to revealing the workspace root itself.
 */
export function revealInExplorer(
  ctx: Context,
  store: SidebarStore,
  sessionId: string,
  files: readonly string[],
): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const cwd = summary?.cwd
  // Deliverables report paths as-is (often relative to the session cwd), but
  // the explorer tree and revealPaths work on absolute paths — resolve every
  // target so the ancestors expand and the row actually matches.
  const targets = files.length > 0
    ? files.map(path => resolveSidebarPath(cwd, path))
    : cwd === undefined ? [] : [cwd]
  store.reduce(state => revealPaths(state, cwd, targets))
  // Focus the single-instance editor home tab (the files window) where the
  // reveal highlight renders. Read via ctx.get like every other internal
  // consumer (#357): the provider is not on this fiber chain, so a direct
  // ctx.betterSidebar read can throw before optional chaining applies.
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title: t('files') })
}

/** The intercepted produced-files row (visual twin of the deliverables chips). */
export function SidebarProducedFiles(props: {
  matched: readonly string[]
  openInSidebar: (path: string) => void
  /** Reveal the produced files in the explorer ("Show in folder" twin). */
  onShowInFolder: (files: readonly string[]) => void
}) {
  const { matched, openInSidebar, onShowInFolder } = props
  const shown = matched.slice(0, 6)
  const hidden = matched.length - shown.length
  return (
    <div className={css.producedRow}>
      <span className={css.producedLabel}>{t('produced')}</span>
      {shown.map(path => {
        const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
        const name = at === -1 ? path : path.slice(at + 1)
        return (
          <button
            key={path}
            type="button"
            className={css.producedChip}
            title={path}
            onClick={() => { openInSidebar(path) }}
          >
            <IconCodeOutline16 size={12} />
            <span>{name}</span>
          </button>
        )
      })}
      {hidden > 0 && <span className={css.producedMore}>+{hidden}</span>}
      {hidden > 0 && (
        <button
          type="button"
          className={css.producedMore}
          style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
          onClick={() => { onShowInFolder(matched) }}
        >
          {t('showInFolder')}
        </button>
      )}
    </div>
  )
}

/**
 * Decide whether the sidebar takes over a Turn's produced-files row. Declines
 * (null) while the editor tab type is disabled in the side card settings — the
 * row then falls back to the default deliverables behavior instead of offering
 * chips that cannot open — and while the sidebar is externally disabled
 * (aionui-panel chosen).
 */
export function selectTurnTail(store: SidebarStore): (owner: unknown) => readonly string[] | null {
  return (owner) => {
    if (store.getSuspended()) return null
    if (store.getPrefs().tabsEnabled['editor'] === false) return null
    return selectProducedFiles(owner)
  }
}

/**
 * Register the turn-tail interception (returns the disposer).
 *
 * The slot is a CHILD slot the host's ui-conversation declares in its
 * `conversation.chat.node` children table. Registering it directly races the
 * declaration — the ui-slots core's load-time validation throws "not declared
 * (a parent entry's children table must declare it)" when the parent entry is
 * not on the ledger yet. slots.inject waits for the declaration: the callback
 * runs synchronously when the slot is already declared, otherwise it runs
 * inside the declaring register() call once the declaration commits;
 * declaration collapse disposes the entry and a later declaration re-registers
 * it. This mirrors @deepseek-ai/dsh-client-ui-deliverables' registration of
 * the same slot.
 *
 * Two host contracts exist for this slot:
 *
 * - Hosts up to DSH 0.1.6-alpha.1 declare it as a CHAIN slot: entries carry a
 *   `select` and the lowest `priority` whose selector accepts the Turn takes
 *   the whole tail over. This is where the sidebar replaces the default
 *   produced-files row with chips that open in the sidebar.
 * - DSH 0.1.6-alpha.2 and later declare it as a LIST slot: every entry needs
 *   an `id`, there is no `select`, and the host renders EVERY entry, so a
 *   second entry would sit under the default deliverables row and duplicate
 *   its chips. Registering the chain shape there throws
 *   'list slot "conversation.chat.turnTail" requires options.id'. On those
 *   hosts the takeover is not needed: the host's own `openFile` funnel goes
 *   through `sidebarRight.openResource`, and this plugin's `editor` / `files`
 *   tab types are registered in the `extension` band, which takes over the
 *   builtin kind's address claims — so the default row's chips already open
 *   in the sidebar. The registration is therefore skipped on list-slot hosts
 *   (the disposer is still returned so callers need no host detection).
 */
export function registerTurnTailInterception(ctx: Context, store: SidebarStore): () => void {
  const select = selectTurnTail(store)
  return ctx.slots.inject('conversation.chat.turnTail', () => {
    try {
      return ctx.slots.register({
        name: 'conversation.chat.turnTail',
        select,
        priority: -1,
        registrant: 'dsh-better-sidebar',
        inject: (sessionId: string) => ({
          openInSidebar: (path: string) => { openSidebarFile(ctx, store, sessionId, path) },
          onShowInFolder: (files: readonly string[]) => { revealInExplorer(ctx, store, sessionId, files) },
        }),
      }, SidebarProducedFiles)
    } catch (error) {
      if (isListSlotContract(error)) return () => {}
      throw error
    }
  })
}

/** Whether a registration error is the list-slot host refusing the chain shape. */
function isListSlotContract(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('requires options.id')
}
