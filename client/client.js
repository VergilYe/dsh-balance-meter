/**
 * @dsh/dsh-balance — browser half (DSH web client).
 *
 * Loaded as a classic script through `window.__ModuleLoader__.load()`, exactly
 * like every other client bundle. Conventions this file must keep:
 *   - `id` equals the package name, because that identity is how the loader and
 *     the Plugins page address this bundle;
 *   - only platform-seed specifiers may be required (here: `react`); loading
 *     other Harness client packages is against DSH's own authoring rules;
 *   - styles are self-contained: no @import, no remote URLs, and every colour
 *     comes from a `--dsw-*` token so a theme change degrades appearance rather
 *     than rendering.
 *
 * Two extension points are registered:
 *   - `conversation.composer.dock` — the readout. This is the same slot the
 *     shipped session-stats pills use (`id: "stats", order: 0`), so the readout
 *     sits on that row; a negative order puts it to their left.
 *   - `plugins.bundle.config` — a form on this bundle's card on the Plugins
 *     page, so the scalar settings are editable without hand-editing the
 *     profile's cordis.patch.yml.
 *
 * Which route it reports is NOT guessed. A slot's `inject` is handed the
 * session id, and `modelDirectories` resolves that session's current
 * provider/model selection, so the readout follows the model actually in use —
 * rather than listing every adapter the build happens to ship.
 */

window.__ModuleLoader__.load({
	id: '@dsh/dsh-balance',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace this browser half owns. */
		const LOCALE_NS = 'dshBalanceMeter'
		/** Settings namespace of the Loader row this bundle inserts — the row id. */
		const ENTRY_NS = 'balance-meter'
		/** The snapshot route the host half registers. */
		const SNAPSHOT_PATH = '/api/balance-meter/snapshot'
		/** How often the readout re-reads the host cache. Cheap: it is a local read. */
		const POLL_MS = 10000
		/** Fields the configuration form edits, each with its own dictionary keys. */
		const FORM_FIELDS = [
			{ name: 'primary', label: 'fieldPrimary', hint: 'fieldPrimaryHint' },
			{ name: 'autoRefresh', label: 'fieldAutoRefresh', hint: 'fieldAutoRefreshHint' },
			{ name: 'minIntervalSec', label: 'fieldMinInterval', hint: 'fieldMinIntervalHint' },
		]

		const en = {
			chip: 'Balance',
			unavailable: 'Unavailable',
			loading: 'Reading…',
			refresh: 'Refresh now',
			refreshing: 'Refreshing…',
			queried: 'Read',
			never: 'never',
			stale: 'stale',
			secondsAgo: 's ago',
			minutesAgo: 'min ago',
			detail: 'Balance and quota',
			close: 'Close',
			provider: 'Provider',
			billing: 'Billing',
			billingApi: 'API balance',
			billingSubscription: 'Subscription quota',
			endpoint: 'Endpoint',
			credential: 'Credential',
			credentialUnset: 'not set',
			quotaWindows: 'Quota windows',
			resets: 'resets',
			rawEcho: 'Raw response',
			formHint: 'Saved to this profile’s cordis.patch.yml and applied immediately.',
			fieldPrimary: 'Primary route',
			fieldPrimaryHint: 'Used only when no session model is resolved. Empty uses the first catalogued route.',
			fieldAutoRefresh: 'Refresh automatically',
			fieldAutoRefreshHint: 'Let a finished turn trigger a vendor query, within the interval below.',
			fieldMinInterval: 'Minimum interval (seconds)',
			fieldMinIntervalHint: 'Floor between two automatic vendor queries for the same route.',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved.',
			failed: 'The host did not accept this value; the stored setting is unchanged.',
			reset: 'Reset to default',
			overridden: 'Set in this profile',
			readOnly: 'This deployment stores settings read-only.',
			configUnavailable: 'This plugin is not loaded, so its configuration cannot be edited right now.',
		}

		const zh = {
			chip: '余额',
			unavailable: '无法查询',
			loading: '读取中…',
			refresh: '立即刷新',
			refreshing: '刷新中…',
			queried: '读取于',
			never: '尚未读取',
			stale: '可能已过期',
			secondsAgo: ' 秒前',
			minutesAgo: ' 分钟前',
			detail: '余额与余量',
			close: '关闭',
			provider: '供应商',
			billing: '计费方式',
			billingApi: 'API 余额',
			billingSubscription: '订阅余量',
			endpoint: '接口地址',
			credential: '凭据变量',
			credentialUnset: '未配置',
			quotaWindows: '额度窗口',
			resets: '重置',
			rawEcho: '原始响应',
			formHint: '保存会写入本 profile 的 cordis.patch.yml 并立即生效。',
			fieldPrimary: '兜底路由',
			fieldPrimaryHint: '仅在未能解析出会话模型时使用；留空则取目录里第一条可识别的路由。',
			fieldAutoRefresh: '自动刷新',
			fieldAutoRefreshHint: '允许一轮对话结束后触发供应商查询，仍受下面的最小间隔约束。',
			fieldMinInterval: '最小刷新间隔（秒）',
			fieldMinIntervalHint: '同一路由两次自动查询之间的最短间隔。',
			save: '保存',
			saving: '保存中…',
			saved: '已保存。',
			failed: '宿主没有接受该值；已保存的设置未改变。',
			reset: '恢复默认',
			overridden: '本 profile 已设置',
			readOnly: '本部署的设置为只读。',
			configUnavailable: '该插件当前未加载，暂时无法编辑它的配置。',
		}

		/**
		 * Styles under this plugin's own prefix, using only host tokens so a
		 * theme change can never make the readout unreadable. Sized to sit on the
		 * stats row, and the popover opens upward because that row is at the
		 * bottom of the window.
		 */
		const CSS = [
			'.dsh-balance-anchor{position:relative;display:inline-flex;align-items:center;min-width:0}',
			'.dsh-balance-chip{display:inline-flex;align-items:center;gap:5px;appearance:none;border:none;background:none;padding:1px 6px;margin:0;font:inherit;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:var(--dsw-radius-sm);max-width:240px}',
			'.dsh-balance-chip:hover,.dsh-balance-chip[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dsh-balance-chip:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.dsh-balance-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-dot[data-ok="true"]{background:var(--dsw-alias-state-business-primary)}',
			'.dsh-balance-value{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.dsh-balance-value[data-ok="false"]{color:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-pop{position:absolute;bottom:calc(100% + 8px);left:0;z-index:60;width:360px;max-height:70vh;overflow:auto;padding:12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);box-shadow:0 8px 24px rgba(0,0,0,.18);font:inherit;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);text-align:left;cursor:default}',
			'.dsh-balance-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}',
			'.dsh-balance-title{font-size:13px;font-weight:500}',
			'.dsh-balance-close{border:none;background:none;padding:0 2px;font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
			'.dsh-balance-close:hover{color:var(--dsw-alias-label-primary)}',
			'.dsh-balance-hero{font-size:20px;font-weight:600;line-height:1.4;margin:2px 0 6px}',
			'.dsh-balance-row{display:grid;grid-template-columns:84px 1fr;gap:8px;padding:2px 0}',
			'.dsh-balance-key{color:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-val{word-break:break-all}',
			'.dsh-balance-sep{height:0.5px;background:var(--dsw-alias-border-l4);margin:10px 0}',
			'.dsh-balance-win{padding:5px 0}',
			'.dsh-balance-winname{font-weight:500}',
			'.dsh-balance-winnote{color:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-4);margin:5px 0 2px;overflow:hidden}',
			'.dsh-balance-barfill{height:100%;background:var(--dsw-alias-state-business-primary)}',
			'.dsh-balance-msg{margin:4px 0 0;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
			'.dsh-balance-msg[data-error="true"]{color:var(--dsw-alias-label-error)}',
			'.dsh-balance-raw{margin:4px 0 0;padding:6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-4);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto}',
			'.dsh-balance-foot{display:flex;align-items:center;gap:8px;margin-top:10px}',
			'.dsh-balance-btn{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:4px 12px;font:inherit;font-size:12px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
			'.dsh-balance-btn:disabled{opacity:.4;cursor:default}',
			'.dsh-balance-note{color:var(--dsw-alias-label-tertiary);font-size:11px}',
			'.dsh-balance-form{display:flex;flex-direction:column;gap:14px;padding:12px 0;max-width:520px}',
			'.dsh-balance-field{display:flex;flex-direction:column;gap:6px}',
			'.dsh-balance-fieldhead{display:flex;align-items:center;gap:8px}',
			'.dsh-balance-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
			'.dsh-balance-badge{font-size:11px;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}',
			'.dsh-balance-input{height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary)}',
			'.dsh-balance-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.dsh-balance-input:disabled{color:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-check{display:flex;align-items:center;gap:8px}',
			'.dsh-balance-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
			'.dsh-balance-reset:disabled{opacity:.4;cursor:default}',
		].join('')

		/**
		 * Format a timestamp as a short relative age.
		 * @param {number | null} at
		 * @param {(key: string) => string} t
		 * @returns {string}
		 */
		function ago(at, t) {
			if (typeof at !== 'number' || !Number.isFinite(at)) return t('never')
			const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
			if (seconds < 60) return `${seconds}${t('secondsAgo')}`
			return `${Math.round(seconds / 60)}${t('minutesAgo')}`
		}

		/**
		 * Render an ISO reset time in the reader's own locale, degrading to the
		 * raw string rather than throwing on an unexpected value.
		 * @param {unknown} value
		 * @returns {string}
		 */
		function resetText(value) {
			if (typeof value !== 'string' || value === '') return ''
			const at = Date.parse(value)
			if (!Number.isFinite(at)) return value
			return new Date(at).toLocaleString(undefined, {
				month: 'numeric',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			})
		}

		/**
		 * Read the host snapshot.
		 *
		 * The request carries the page's session cookie automatically; a failure
		 * here is reported in the readout rather than thrown, because the
		 * composer must keep rendering even when the host half is unavailable.
		 * @param {{ route: string | null, refresh: boolean }} query
		 * @returns {Promise<object>}
		 */
		async function readSnapshot(query) {
			const params = new URLSearchParams()
			if (query.route !== null && query.route !== '') params.set('route', query.route)
			if (query.refresh) params.set('refresh', '1')
			const suffix = params.toString() === '' ? '' : `?${params.toString()}`
			const response = await fetch(`${SNAPSHOT_PATH}${suffix}`, {
				method: 'GET',
				credentials: 'same-origin',
				headers: { accept: 'application/json' },
			})
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			return response.json()
		}

		/**
		 * Resolve a session's current provider.
		 *
		 * `modelDirectories.directoryFor(sessionId).store` holds the session's
		 * live `{provider, model, reasoningEffort}` selection, so this follows the
		 * model actually selected rather than assuming a default. Returns null
		 * when any link in that chain is unavailable, which leaves the host to
		 * fall back to its primary route.
		 * @param {unknown} directories
		 * @param {string | undefined} sessionId
		 * @returns {object | null}
		 */
		function directoryFor(directories, sessionId) {
			if (directories === null || typeof directories !== 'object') return null
			if (typeof sessionId !== 'string' || sessionId === '') return null
			try {
				return typeof directories.directoryFor === 'function'
					? directories.directoryFor(sessionId)
					: null
			} catch {
				return null
			}
		}

		/**
		 * Subscribe to a session's model selection.
		 * @param {object | null} directory
		 * @returns {{provider: string | null, model: string | null}}
		 */
		function useModelSelection(directory) {
			const store = directory !== null && typeof directory === 'object' ? directory.store : null
			const subscribe = React.useCallback(
				(listener) => (store !== null && typeof store.subscribe === 'function'
					? store.subscribe(listener)
					: () => {}),
				[store],
			)
			const read = React.useCallback(
				() => (store !== null && typeof store.getSnapshot === 'function'
					? store.getSnapshot()
					: null),
				[store],
			)
			const snapshot = React.useSyncExternalStore(subscribe, read, read)

			// Nudge the directory to load once; a failure is not ours to surface,
			// because the selector the user actually drives reports its own.
			React.useEffect(() => {
				if (directory === null || typeof directory.load !== 'function') return
				try {
					Promise.resolve(directory.load()).catch(() => {})
				} catch {
					// A directory that refuses to load simply leaves provider null.
				}
			}, [directory])

			const current = snapshot !== null && typeof snapshot === 'object' ? snapshot.current : null
			const provider = current !== null && typeof current === 'object' ? current.provider : null
			const model = current !== null && typeof current === 'object' ? current.model : null
			return {
				provider: typeof provider === 'string' && provider !== '' ? provider : null,
				model: typeof model === 'string' && model !== '' ? model : null,
			}
		}

		/**
		 * The readout.
		 *
		 * Owns its own polling because the host keeps no timer: a poll asks for a
		 * snapshot, and the host decides whether that poll is allowed to become a
		 * real vendor request. The host separately refreshes on `turn/end`, so a
		 * poll mostly just picks up an already-fresh cached reading.
		 * @param {{ t: (key: string) => string, sessionId?: string, directories?: unknown }} props
		 */
		function BalanceReadout(props) {
			const { t, sessionId, directories } = props
			const directory = React.useMemo(
				() => directoryFor(directories, sessionId),
				[directories, sessionId],
			)
			const { provider } = useModelSelection(directory)

			const [snapshot, setSnapshot] = React.useState(null)
			const [error, setError] = React.useState(null)
			const [busy, setBusy] = React.useState(false)
			const [open, setOpen] = React.useState(false)
			const anchor = React.useRef(null)

			const load = React.useCallback(async (refresh) => {
				try {
					const next = await readSnapshot({ route: provider, refresh })
					setSnapshot(next)
					setError(null)
					return next
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause))
					return null
				}
			}, [provider])

			// Re-read on mount, whenever the selected provider changes, and on a
			// slow poll so a reading refreshed by the host shows up on its own.
			React.useEffect(() => {
				let alive = true
				void load(false)
				const timer = setInterval(() => {
					if (!alive) return
					if (typeof document === 'undefined' || document.visibilityState === 'visible') {
						void load(false)
					}
				}, POLL_MS)
				return () => {
					alive = false
					clearInterval(timer)
				}
			}, [load])

			// Close the popover on Escape or an outside click.
			React.useEffect(() => {
				if (!open) return undefined
				const onKey = (event) => {
					if (event.key === 'Escape') setOpen(false)
				}
				const onDown = (event) => {
					if (anchor.current !== null && !anchor.current.contains(event.target)) setOpen(false)
				}
				document.addEventListener('keydown', onKey)
				document.addEventListener('mousedown', onDown)
				return () => {
					document.removeEventListener('keydown', onKey)
					document.removeEventListener('mousedown', onDown)
				}
			}, [open])

			const routes = snapshot !== null && Array.isArray(snapshot.routes) ? snapshot.routes : []
			const states = snapshot !== null && Array.isArray(snapshot.states) ? snapshot.states : []
			const route = routes[0]
			const state = states[0]
			// Whether there is a figure to render is the host's answer, not this
			// file's: it sends `value` null when it has nothing, and keeps sending
			// the last good figure — with `stale` set and `message` explaining why —
			// when a later attempt failed. Deriving this from `status` here is what
			// made a single failed automatic refresh blank a perfectly good reading.
			const value = state !== undefined && state !== null && typeof state.value === 'string'
				? state.value
				: null
			const hasValue = value !== null
			const stale = state !== undefined && state !== null && state.stale === true

			let text = hasValue ? value : t('loading')
			if (!hasValue && (error !== null || snapshot !== null)) text = t('unavailable')

			/** Refresh on demand, bypassing the host's cooldown. */
			async function refreshNow() {
				setBusy(true)
				await load(true)
				setBusy(false)
			}

			return h(
				'div',
				{ className: 'dsh-balance-anchor', ref: anchor },
				h(
					'button',
					{
						type: 'button',
						className: 'dsh-balance-chip',
						title: error === null ? t('chip') : `${t('chip')}: ${error}`,
						'aria-expanded': open ? 'true' : 'false',
						onClick: () => setOpen((value) => !value),
					},
					h('span', { className: 'dsh-balance-dot', 'data-ok': hasValue ? 'true' : 'false' }),
					h(
						'span',
						{ className: 'dsh-balance-value', 'data-ok': stale ? 'false' : hasValue ? 'true' : 'false' },
						text,
					),
				),
				open
					? h(
							'div',
							{ className: 'dsh-balance-pop', role: 'dialog', 'aria-label': t('detail') },
							h(
								'div',
								{ className: 'dsh-balance-head' },
								h('span', { className: 'dsh-balance-title' }, t('detail')),
								h(
									'button',
									{ type: 'button', className: 'dsh-balance-close', onClick: () => setOpen(false) },
									t('close'),
								),
							),
							error !== null
								? h('p', { className: 'dsh-balance-msg', 'data-error': 'true' }, error)
								: null,
							hasValue
								? h(
										'div',
										{ className: 'dsh-balance-hero' },
										value,
										stale
											? h('span', { className: 'dsh-balance-winnote' }, ` · ${t('stale')}`)
											: null,
									)
								: null,
							hasValue && state.result !== null && Array.isArray(state.result.windows) && state.result.windows.length > 0
								? h(
										'div',
										null,
										h('div', { className: 'dsh-balance-sep' }),
										h('div', { className: 'dsh-balance-key' }, t('quotaWindows')),
										state.result.windows.map((w, index) => h(WindowRow, { key: `${w.key}-${index}`, t, window: w })),
									)
								: null,
							state !== undefined && state !== null && state.message !== null
								? h(
										'p',
										{ className: 'dsh-balance-msg', 'data-error': state.status !== 'ok' ? 'true' : 'false' },
										state.message,
									)
								: null,
							snapshot !== null && snapshot.error !== undefined
								? h('p', { className: 'dsh-balance-msg', 'data-error': 'true' }, snapshot.error)
								: null,
							state !== undefined && state !== null && typeof state.raw === 'string' && state.raw !== ''
								? h(
										'div',
										null,
										h('div', { className: 'dsh-balance-key' }, t('rawEcho')),
										h('pre', { className: 'dsh-balance-raw' }, state.raw),
									)
								: null,
							route !== undefined
								? h(
										'div',
										null,
										h('div', { className: 'dsh-balance-sep' }),
										h(
											'div',
											{ className: 'dsh-balance-row' },
											h('span', { className: 'dsh-balance-key' }, t('provider')),
											h(
												'span',
												{ className: 'dsh-balance-val' },
												route.apiKeyEnv === null || route.apiKeyEnv === ''
													? `${route.label} · ${t('credentialUnset')}`
													: `${route.label} · ${route.apiKeyEnv}`,
											),
										),
										route.billing !== null
											? h(
													'div',
													{ className: 'dsh-balance-row' },
													h('span', { className: 'dsh-balance-key' }, t('billing')),
													h(
														'span',
														{ className: 'dsh-balance-val' },
														route.billing === 'subscription'
															? t('billingSubscription')
															: t('billingApi'),
													),
												)
											: null,
										state !== undefined && state !== null && state.url !== null
											? h(
													'div',
													{ className: 'dsh-balance-row' },
													h('span', { className: 'dsh-balance-key' }, t('endpoint')),
													h('span', { className: 'dsh-balance-val' }, state.url.replace(/^https?:\/\//, '')),
												)
											: null,
										h(
											'div',
											{ className: 'dsh-balance-row' },
											h('span', { className: 'dsh-balance-key' }, t('queried')),
											h(
												'span',
												{ className: 'dsh-balance-val' },
												state === undefined || state === null
													? t('never')
													: `${ago(state.queriedAt, t)}${state.stale === true ? ` · ${t('stale')}` : ''}`,
											),
										),
									)
								: null,
							h(
								'div',
								{ className: 'dsh-balance-foot' },
								h(
									'button',
									{
										type: 'button',
										className: 'dsh-balance-btn',
										disabled: busy,
										onClick: () => {
											void refreshNow()
										},
									},
									busy ? t('refreshing') : t('refresh'),
								),
								snapshot !== null && typeof snapshot.minIntervalSec === 'number'
									? h(
											'span',
											{ className: 'dsh-balance-note' },
											`${t('fieldMinInterval')}: ${snapshot.minIntervalSec}s`,
										)
									: null,
							),
						)
					: null,
			)
		}

		/**
		 * One quota window inside the popover, with a remaining-share bar.
		 * @param {{ t: (key: string) => string, window: object }} props
		 */
		function WindowRow(props) {
			const { t, window: w } = props
			const pct = typeof w.remainingPct === 'number' ? w.remainingPct : null
			const reset = resetText(w.resetAt)
			return h(
				'div',
				{ className: 'dsh-balance-win' },
				h(
					'div',
					null,
					h('span', { className: 'dsh-balance-winname' }, w.label),
					pct === null
						? null
						: h('span', { className: 'dsh-balance-winnote' }, ` · 剩 ${pct.toFixed(0)}%`),
					reset === '' ? null : h('span', { className: 'dsh-balance-winnote' }, ` · ${t('resets')} ${reset}`),
				),
				pct === null
					? null
					: h(
							'div',
							{ className: 'dsh-balance-bar' },
							h('div', { className: 'dsh-balance-barfill', style: { width: `${pct}%` } }),
						),
				w.note === undefined
					? null
					: h('div', { className: 'dsh-balance-winnote' }, w.note),
			)
		}

		/**
		 * The bundle's configuration form.
		 * @param {object} scope
		 */
		function configFormFor(scope) {
			/** @param {{ t: (key: string) => string }} props */
			return function BalanceConfigForm(props) {
				const t = props.t
				const [busy, setBusy] = React.useState(false)
				const [dirty, setDirty] = React.useState(false)
				const [outcome, setOutcome] = React.useState(null)
				const [seenRevision, setSeenRevision] = React.useState(undefined)
				const inputs = React.useRef({})
				const keepOutcome = React.useRef(false)

				const subscribe = React.useMemo(() => (listener) => scope.subscribe(listener), [scope])
				const readState = React.useMemo(() => () => scope.getSnapshot(), [scope])
				const state = React.useSyncExternalStore(subscribe, readState, readState)
				const revision = state === undefined || state === null ? undefined : state.revision
				if (seenRevision !== revision) {
					setSeenRevision(revision)
					setDirty(false)
					if (keepOutcome.current) keepOutcome.current = false
					else setOutcome(null)
				}

				if (state === undefined || state === null || state.status === 'unavailable') {
					return h('p', { className: 'dsh-balance-hint', role: 'status' }, t('configUnavailable'))
				}
				// The settings document has not arrived yet; claiming "unavailable"
				// here would be a lie, and the card fills in on its own.
				if (state.status !== 'ready') return null

				const value = state.value === undefined || state.value === null ? {} : state.value
				const user = state.user === undefined || state.user === null ? {} : state.user
				const writable = state.writable === true

				/** @param {string} field */
				const readField = (field) => {
					const raw = value[field]
					return typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string'
						? raw
						: ''
				}

				/** Queue field writes and report whether the host accepted them. */
				async function commit(writes) {
					setBusy(true)
					setOutcome(null)
					let accepted = true
					try {
						for (const write of writes) {
							if ((await write()) !== true) accepted = false
						}
					} catch {
						accepted = false
					}
					if (accepted) keepOutcome.current = true
					setBusy(false)
					setOutcome(accepted ? 'saved' : 'failed')
				}

				/** Store every field; an empty input clears the profile override. */
				function save() {
					void commit(FORM_FIELDS.map(({ name }) => () => {
						const node = inputs.current[name]
						const next = node === null || node === undefined ? '' : String(node.value).trim()
						if (next === '') return scope.unset(name)
						if (name === 'minIntervalSec') {
							const seconds = Number(next)
							if (!Number.isFinite(seconds) || seconds < 0) return Promise.resolve(false)
							return scope.set(name, seconds)
						}
						if (name === 'autoRefresh') return scope.set(name, next === 'true')
						return scope.set(name, next)
					}))
				}

				/**
				 * Render one configuration field.
				 * @param {{ name: string, label: string, hint: string }} spec
				 * @returns {object}
				 */
				const field = (spec) =>
					h(
						'div',
						{ className: 'dsh-balance-field', key: spec.name },
						h(
							'div',
							{ className: 'dsh-balance-fieldhead' },
							h(
								'label',
								{ className: 'dsh-balance-label', htmlFor: `dsh-balance-${spec.name}` },
								t(spec.label),
							),
							Object.hasOwn(user, spec.name)
								? h('span', { className: 'dsh-balance-badge' }, t('overridden'))
								: null,
						),
						spec.name === 'autoRefresh'
							? h(
									'div',
									{ className: 'dsh-balance-check' },
									h('input', {
										id: `dsh-balance-${spec.name}`,
										key: `revision-${String(state.revision)}`,
										type: 'checkbox',
										ref: (node) => {
											inputs.current[spec.name] = node
										},
										defaultChecked: readField(spec.name) !== false,
										disabled: !writable || busy,
										onChange: () => {
											setDirty(true)
											setOutcome(null)
										},
									}),
									h('span', { className: 'dsh-balance-hint' }, t(spec.hint)),
								)
							: h(
									'div',
									null,
									h('input', {
										id: `dsh-balance-${spec.name}`,
										className: 'dsh-balance-input',
										key: `revision-${String(state.revision)}`,
										type: 'text',
										ref: (node) => {
											inputs.current[spec.name] = node
										},
										defaultValue: String(readField(spec.name)),
										disabled: !writable || busy,
										spellCheck: false,
										autoComplete: 'off',
										onInput: () => {
											setDirty(true)
											setOutcome(null)
										},
									}),
									h('p', { className: 'dsh-balance-hint' }, t(spec.hint)),
								),
					)

				return h(
					'div',
					{ className: 'dsh-balance-form' },
					h('p', { className: 'dsh-balance-hint' }, t('formHint')),
					writable ? null : h('p', { className: 'dsh-balance-hint', role: 'status' }, t('readOnly')),
					...FORM_FIELDS.map((spec) => field(spec)),
					h(
						'div',
						{ className: 'dsh-balance-foot' },
						h(
							'button',
							{
								type: 'button',
								className: 'dsh-balance-btn',
								disabled: !writable || busy || !dirty,
								onClick: save,
							},
							busy ? t('saving') : t('save'),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'dsh-balance-reset',
								disabled: !writable || busy,
								onClick: () => {
									void commit(FORM_FIELDS.map(({ name }) => () => scope.unset(name)))
								},
							},
							t('reset'),
						),
						outcome === null
							? null
							: h(
									'span',
									{ className: 'dsh-balance-hint', role: 'status' },
									outcome === 'saved' ? t('saved') : t('failed'),
								),
					),
				)
			}
		}

		return {
			/** Cordis services this browser half needs; `slots` is mandatory here. */
			inject: ['slots', 'locale'],
			/** @param {object} ctx */
			apply(ctx) {
				/**
				 * Session model directories, when the runtime provides them. Held in
				 * a closure rather than read per render so a registration made before
				 * the service exists still works once it arrives.
				 */
				let modelDirectories = null
				ctx.inject(['modelDirectories'], (scope) => {
					modelDirectories = scope.modelDirectories
				})

				ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'balance-meter: dictionaries')
				ctx.effect(() => {
					const style = document.createElement('style')
					style.setAttribute('data-plugin', '@dsh/dsh-balance')
					style.textContent = CSS
					document.head.appendChild(style)
					return () => {
						style.remove()
					}
				}, 'balance-meter: styles')

				// `order: -10` puts the readout to the left of the shipped stats
				// pills, which register on this same row with `order: 0`.
				ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock',
					id: 'balance',
					order: -10,
					locale: LOCALE_NS,
					inject: (sessionId) => ({ sessionId, directories: modelDirectories }),
				}, BalanceReadout))

				// A form exists only where the Plugins page can carry one. Without
				// `configForms` this half stays inert rather than rendering a form
				// that could not save.
				ctx.inject(['configForms'], (forms) => {
					const scope = forms.configForms.get(ENTRY_NS)
					ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
						{ name: 'plugins.bundle.config', key: '@dsh/dsh-balance', locale: LOCALE_NS },
						configFormFor(scope),
					))
				})
			},
		}
	},
})
