/**
 * dsh-balance-meter — browser half (DSH web client).
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
 *   - `conversation.session.header.utilities` — the balance chip in the session
 *     header, which is the whole point of the plugin;
 *   - `plugins.bundle.config` — a configuration form on this bundle's card on
 *     the Plugins page, so the scalar settings are editable without hand-editing
 *     the profile's cordis.patch.yml.
 */

window.__ModuleLoader__.load({
	id: 'dsh-balance-meter',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace this browser half owns. */
		const LOCALE_NS = 'dshBalanceMeter'
		/** Settings namespace of the Loader row this bundle inserts — the row id. */
		const ENTRY_NS = 'balance-meter'
		/** The snapshot route the host half registers. */
		const SNAPSHOT_PATH = '/api/balance-meter/snapshot'
		/** How often the chip asks the host for a snapshot while visible. */
		const POLL_MS = 60000
		/**
		 * Fields the configuration form edits, each with its own dictionary keys.
		 * The mapping is explicit because the config field names and the copy keys
		 * are not derivable from one another.
		 */
		const FORM_FIELDS = [
			{ name: 'primary', label: 'fieldPrimary', hint: 'fieldPrimaryHint' },
			{ name: 'autoRefresh', label: 'fieldAutoRefresh', hint: 'fieldAutoRefreshHint' },
			{ name: 'minIntervalSec', label: 'fieldMinInterval', hint: 'fieldMinIntervalHint' },
		]

		const en = {
			chip: 'Balance',
			unavailable: 'Unavailable',
			loading: 'Reading…',
			noRoutes: 'No model routes found in this profile.',
			refresh: 'Refresh now',
			refreshing: 'Refreshing…',
			queried: 'Read',
			never: 'never',
			stale: 'stale',
			secondsAgo: 's ago',
			minutesAgo: 'min ago',
			detail: 'Details',
			route: 'Route',
			provider: 'Provider',
			billing: 'Billing',
			billingApi: 'API balance',
			billingSubscription: 'Subscription quota',
			endpoint: 'Endpoint',
			credential: 'Credential',
			credentialUnset: 'not set',
			source: 'Identified via',
			window: 'Window',
			close: 'Close',
			formTitle: 'Balance meter',
			formHint: 'Saved to this profile’s cordis.patch.yml and applied immediately.',
			fieldPrimary: 'Primary route',
			fieldPrimaryHint: 'Route the header chip reports. Empty uses the first catalogued route.',
			fieldAutoRefresh: 'Refresh automatically',
			fieldAutoRefreshHint: 'Let the header chip trigger a vendor query while it is visible.',
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
			rawEcho: 'Raw response',
		}

		const zh = {
			chip: '余额',
			unavailable: '无法查询',
			loading: '读取中…',
			noRoutes: '当前 profile 里没有发现模型路由。',
			refresh: '立即刷新',
			refreshing: '刷新中…',
			queried: '读取于',
			never: '尚未读取',
			stale: '可能已过期',
			secondsAgo: ' 秒前',
			minutesAgo: ' 分钟前',
			detail: '详情',
			route: '路由',
			provider: '供应商',
			billing: '计费方式',
			billingApi: 'API 余额',
			billingSubscription: '订阅余量',
			endpoint: '接口地址',
			credential: '凭据变量',
			credentialUnset: '未配置',
			source: '识别来源',
			window: '窗口',
			close: '关闭',
			formTitle: '余额与余量',
			formHint: '保存会写入本 profile 的 cordis.patch.yml 并立即生效。',
			fieldPrimary: '优先显示的路由',
			fieldPrimaryHint: '标题栏读数显示哪条路由；留空则取目录里第一条可识别的路由。',
			fieldAutoRefresh: '自动刷新',
			fieldAutoRefreshHint: '允许标题栏读数在可见时触发供应商查询。',
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
			rawEcho: '原始响应',
		}

		/**
		 * Styles under this plugin's own prefix, using only host tokens so a
		 * theme change can never make the chip unreadable.
		 */
		const CSS = [
			'.dsh-balance-anchor{position:relative;display:inline-flex;align-items:center}',
			'.dsh-balance-chip{display:inline-flex;align-items:center;gap:6px;appearance:none;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-md);padding:3px 8px;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);cursor:pointer;max-width:260px}',
			'.dsh-balance-chip:hover{background:var(--dsw-alias-bg-layer-4)}',
			'.dsh-balance-chip:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.dsh-balance-vendor{color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
			'.dsh-balance-value{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.dsh-balance-value[data-ok="false"]{color:var(--dsw-alias-label-tertiary);font-weight:400}',
			'.dsh-balance-stale{color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
			'.dsh-balance-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:40;width:340px;max-height:70vh;overflow:auto;padding:12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
			'.dsh-balance-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}',
			'.dsh-balance-title{font-size:13px;font-weight:500}',
			'.dsh-balance-close{border:none;background:none;padding:0 2px;font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
			'.dsh-balance-close:hover{color:var(--dsh-alias-label-primary)}',
			'.dsh-balance-row{display:grid;grid-template-columns:76px 1fr;gap:8px;padding:2px 0}',
			'.dsh-balance-key{color:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-val{word-break:break-all}',
			'.dsh-balance-sep{height:0.5px;background:var(--dsw-alias-border-l4);margin:10px 0}',
			'.dsh-balance-route{padding:6px 0}',
			'.dsh-balance-route-name{font-weight:500}',
			'.dsh-balance-route-meta{color:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-msg{margin:4px 0 0;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
			'.dsh-balance-msg[data-error="true"]{color:var(--dsh-alias-label-error)}',
			'.dsh-balance-raw{margin:4px 0 0;padding:6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-4);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:140px;overflow:auto}',
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
			'.dsh-balance-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;color:var(--dsh-alias-label-secondary);cursor:pointer}',
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
		 * Strip the scheme and trailing slash from a URL for compact display.
		 * @param {unknown} url
		 * @returns {string}
		 */
		function shortUrl(url) {
			if (typeof url !== 'string' || url === '') return '—'
			return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
		}

		/**
		 * Read the host snapshot.
		 *
		 * The request carries the page's session cookie automatically; a failure
		 * here is reported in the chip rather than thrown, because the header
		 * must keep rendering even when the host half is unavailable.
		 * @param {boolean} refresh
		 * @returns {Promise<object>}
		 */
		async function readSnapshot(refresh) {
			const url = refresh ? `${SNAPSHOT_PATH}?refresh=1` : SNAPSHOT_PATH
			const response = await fetch(url, {
				method: 'GET',
				credentials: 'same-origin',
				headers: { accept: 'application/json' },
			})
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			return response.json()
		}

		/**
		 * The header chip.
		 *
		 * Owns its own polling because the host keeps no timer: a poll asks for a
		 * snapshot, and the host decides whether that poll is allowed to become a
		 * real vendor request.
		 * @param {{ t: (key: string) => string }} props
		 */
		function BalanceChip(props) {
			const { t } = props
			const [snapshot, setSnapshot] = React.useState(null)
			const [error, setError] = React.useState(null)
			const [busy, setBusy] = React.useState(false)
			const [open, setOpen] = React.useState(false)
			const anchor = React.useRef(null)

			const load = React.useCallback(async (refresh) => {
				try {
					const next = await readSnapshot(refresh)
					setSnapshot(next)
					setError(null)
					return next
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause))
					return null
				}
			}, [])

			// Poll while the chip is mounted, and only while the page is visible:
			// a hidden window has no reader, so its vendor calls would be waste.
			React.useEffect(() => {
				let alive = true
				let timer
				const tick = async () => {
					if (!alive) return
					if (typeof document === 'undefined' || document.visibilityState === 'visible') {
						await load(false)
					}
				}
				void load(false)
				timer = setInterval(() => {
					void tick()
				}, POLL_MS)
				const onVisible = () => {
					if (document.visibilityState === 'visible') void tick()
				}
				document.addEventListener('visibilitychange', onVisible)
				return () => {
					alive = false
					clearInterval(timer)
					document.removeEventListener('visibilitychange', onVisible)
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
			const byKey = new Map(states.map((state) => [state.key, state]))
			const primaryKey = snapshot === null ? null : snapshot.primary
			const primaryState = primaryKey === null ? undefined : byKey.get(primaryKey)
			const primaryRoute = routes.find((route) => route.key === primaryKey)

			let text = t('loading')
			let ok = false
			if (error !== null) {
				text = t('unavailable')
			} else if (snapshot !== null) {
				if (routes.length === 0) {
					text = t('unavailable')
				} else if (primaryState !== undefined && primaryState.status === 'ok' && primaryState.result !== null) {
					text = primaryState.result.display
					ok = true
				} else {
					text = t('unavailable')
				}
			}

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
					primaryRoute === undefined
						? null
						: h('span', { className: 'dsh-balance-vendor' }, primaryRoute.label),
					h('span', { className: 'dsh-balance-value', 'data-ok': ok ? 'true' : 'false' }, text),
					primaryState !== undefined && primaryState.stale === true
						? h('span', { className: 'dsh-balance-stale' }, '·')
						: null,
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
							routes.length === 0 && error === null
								? h('p', { className: 'dsh-balance-msg' }, t('noRoutes'))
								: null,
							routes.map((route, index) =>
								h(RouteBlock, {
									key: route.key,
									t,
									route,
									state: byKey.get(route.key),
									first: index === 0,
								}),
							),
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
		 * One route's block inside the popover.
		 * @param {{ t: (key: string) => string, route: object, state: object | undefined, first: boolean }} props
		 */
		function RouteBlock(props) {
			const { t, route, state, first } = props
			const result = state !== undefined && state !== null ? state.result : null
			return h(
				'div',
				null,
				first ? null : h('div', { className: 'dsh-balance-sep' }),
				h(
					'div',
					{ className: 'dsh-balance-route' },
					h('div', { className: 'dsh-balance-route-name' }, route.label),
					h(
						'div',
						{ className: 'dsh-balance-route-meta' },
						route.billing === 'subscription'
							? t('billingSubscription')
							: route.billing === 'api'
								? t('billingApi')
								: t('route'),
						state !== undefined && state !== null
							? ` · ${t('queried')} ${ago(state.queriedAt, t)}`
							: '',
					),
				),
				result !== null
					? result.detail.map((row, index) =>
							h(
								'div',
								{ className: 'dsh-balance-row', key: `d${index}` },
								h('span', { className: 'dsh-balance-key' }, row.label),
								h('span', { className: 'dsh-balance-val' }, row.value),
							),
						)
					: null,
				state !== undefined && state !== null && state.message !== null
					? h(
							'p',
							{ className: 'dsh-balance-msg', 'data-error': state.status !== 'ok' ? 'true' : 'false' },
							state.message,
						)
					: null,
				state !== undefined && state !== null && typeof state.raw === 'string' && state.raw !== ''
					? h(
							'div',
							null,
							h('div', { className: 'dsh-balance-key' }, t('rawEcho')),
							h('pre', { className: 'dsh-balance-raw' }, state.raw),
						)
					: null,
				h(
					'div',
					{ className: 'dsh-balance-row' },
					h('span', { className: 'dsh-balance-key' }, t('provider')),
					h(
						'span',
						{ className: 'dsh-balance-val' },
						route.catalogued ? route.id : `${route.id}（${t('unavailable')}）`,
					),
				),
				h(
					'div',
					{ className: 'dsh-balance-row' },
					h('span', { className: 'dsh-balance-key' }, t('credential')),
					h(
						'span',
						{ className: 'dsh-balance-val' },
						route.apiKeyEnv === null || route.apiKeyEnv === ''
							? t('credentialUnset')
							: route.apiKeyEnv,
					),
				),
				state !== undefined && state !== null && state.url !== null
					? h(
							'div',
							{ className: 'dsh-balance-row' },
							h('span', { className: 'dsh-balance-key' }, t('endpoint')),
							h('span', { className: 'dsh-balance-val' }, shortUrl(state.url)),
						)
					: null,
			)
		}

		/**
		 * The bundle's configuration form.
		 *
		 * A save goes through the settings scope, which writes the same profile
		 * patch layer the `balance_set_endpoint` host tool writes, so both entry
		 * points agree and the change applies without a restart.
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
				const readSnapshot = React.useMemo(() => () => scope.getSnapshot(), [scope])
				const state = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot)
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

				/** Queue one field write and report whether the host accepted it. */
				async function commit(writes) {
					setBusy(true)
					setOutcome(null)
					let accepted = false
					try {
						accepted = true
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
									{
										className: 'dsh-balance-hint',
										role: 'status',
									},
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
				ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'balance-meter: dictionaries')
				ctx.effect(() => {
					const style = document.createElement('style')
					style.setAttribute('data-plugin', 'dsh-balance-meter')
					style.textContent = CSS
					document.head.appendChild(style)
					return () => {
						style.remove()
					}
				}, 'balance-meter: styles')

				// The slot hands `inject` the session id, and this chip deliberately
				// does not ask for it: the route it reports is the profile's primary
				// one, not a per-session route. Taking a value it ignored would read
				// as though per-session routing were implemented.
				ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
					name: 'conversation.session.header.utilities',
					id: 'balance-meter',
					order: -8,
					locale: LOCALE_NS,
				}, BalanceChip))

				// A form exists only where the Plugins page can carry one. Without
				// `configForms` this half stays inert rather than rendering a form
				// that could not save.
				ctx.inject(['configForms'], (forms) => {
					const scope = forms.configForms.get(ENTRY_NS)
					ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
						{ name: 'plugins.bundle.config', key: 'dsh-balance-meter', locale: LOCALE_NS },
						configFormFor(scope),
					))
				})
			},
		}
	},
})
