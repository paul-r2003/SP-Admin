/**
 * SP Admin → Slack daily kitchen cleaning reminder.
 *
 * Runs every 15 minutes on weekdays (see .github/workflows/slack-cleaning-alert.yml). Each run:
 *   1. Checks the Slack connection and saves it, with the channel list, to slack/status (shown in Settings).
 *   2. Answers a pending "Send test message" request from Settings.
 *   3. Once the configured alert time has passed on a working day, posts that day's reminder — exactly once.
 *      Each day is claimed in slackAlerts/{date} inside a transaction, so overlapping or repeated runs can't
 *      post twice. Failed sends are retried on later runs (MAX_ATTEMPTS in total).
 *
 * Environment (GitHub Actions secrets):
 *   SLACK_BOT_TOKEN           xoxb-… bot token. Scopes: chat:write, channels:read, groups:read, users:read, users:read.email
 *   FIREBASE_SERVICE_ACCOUNT  JSON key of a Firebase service account (bypasses Firestore rules)
 */
import { cert, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const MAX_ATTEMPTS = 5
/** A claim older than this is treated as abandoned (the run that made it crashed). */
const STALE_CLAIM_MS = 10 * 60 * 1000

const DEFAULT_CONFIG = { enabled: false, channelId: '', alertTime: '09:00', timeZone: 'Europe/Stockholm', skipDates: [] }

const CHECKLIST = [
  'Clean the kitchen countertop and tables.',
  'Wash and organize used cups and utensils.',
  'Clean the sink and surrounding area.',
  'Empty the kitchen dustbin.',
  'Sweep and mop the kitchen floor.',
  'Arrange kitchen items neatly.',
]

const log = (...args) => console.log(new Date().toISOString(), ...args)

// ---------------------------------------------------------------- Slack

const TOKEN = process.env.SLACK_BOT_TOKEN
const TRANSIENT = new Set(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class SlackError extends Error {
  constructor(method, code) {
    super(`${method}: ${code}`)
    this.code = code
  }
}

/** Calls a Slack Web API method, retrying rate limits and transient errors with backoff. */
async function slack(method, params = {}, retries = 3) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, typeof v === 'string' ? v : JSON.stringify(v))
  for (let attempt = 1; ; attempt++) {
    let code
    try {
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 429) {
        code = 'ratelimited'
        await sleep((Number(res.headers.get('retry-after')) || 5) * 1000)
      } else {
        const json = await res.json()
        if (json.ok) return json
        code = json.error ?? `http_${res.status}`
      }
    } catch (err) {
      code = err?.name === 'TimeoutError' ? 'request_timeout' : 'network_error'
    }
    if (attempt > retries || !(TRANSIENT.has(code) || code === 'network_error')) throw new SlackError(method, code)
    log(`Slack ${method} failed (${code}), retry ${attempt}/${retries}`)
    await sleep(1000 * 2 ** attempt)
  }
}

async function listChannels() {
  const channels = []
  let cursor
  let types = 'public_channel,private_channel'
  for (let page = 0; page < 10; page++) {
    let res
    try {
      res = await slack('conversations.list', { types, exclude_archived: 'true', limit: '200', cursor })
    } catch (err) {
      // Without groups:read the bot can still list public channels.
      if (err.code === 'missing_scope' && types !== 'public_channel') {
        types = 'public_channel'
        page--
        continue
      }
      throw err
    }
    for (const c of res.channels) channels.push({ id: c.id, name: c.name, isPrivate: !!c.is_private, isMember: !!c.is_member })
    cursor = res.response_metadata?.next_cursor
    if (!cursor) break
  }
  return channels.sort((a, b) => Number(b.isMember) - Number(a.isMember) || a.name.localeCompare(b.name))
}

/** Slack user id for an email, or null (no match / missing users:read.email scope). */
async function slackUserId(email) {
  if (!email) return null
  try {
    return (await slack('users.lookupByEmail', { email: email.trim().toLowerCase() }, 1)).user.id
  } catch (err) {
    log(`No Slack user for ${email} (${err.code})`)
    return null
  }
}

const post = (channel, text) => slack('chat.postMessage', { channel, text, unfurl_links: 'false', unfurl_media: 'false' })

// ---------------------------------------------------------------- Dates in the office time zone

function zonedNow(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday }
}

const longDate = (dateKey) =>
  new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

// ---------------------------------------------------------------- Messages

function reminderText({ date, assignees, area }) {
  return [
    ':broom: *Daily Kitchen Cleaning Reminder*',
    '',
    'Good morning, team!',
    '',
    `:date: *Date:* ${longDate(date)}`,
    `:bust_in_silhouette: *Assigned Employee:* ${assignees.join(', ')}`,
    `:round_pushpin: *Cleaning Area:* ${area}`,
    '',
    "*Today's Cleaning Checklist:*",
    ...CHECKLIST.map((item) => `• ${item}`),
    '',
    'Please complete the cleaning tasks today and keep the kitchen clean and tidy.',
    '',
    'Thank you!',
  ].join('\n')
}

// ---------------------------------------------------------------- Main

async function main() {
  if (!TOKEN) throw new Error('SLACK_BOT_TOKEN secret is not set')
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is not set')

  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) })
  const db = getFirestore()
  const workspace = db.collection('workspaces').doc('default')
  const configRef = workspace.collection('slack').doc('config')
  const statusRef = workspace.collection('slack').doc('status')

  const [configSnap, statusSnap] = await Promise.all([configRef.get(), statusRef.get()])
  const config = { ...DEFAULT_CONFIG, ...(configSnap.data() ?? {}) }
  const prevStatus = statusSnap.data() ?? {}
  const nowIso = new Date().toISOString()

  // 1. Connection check
  const status = { checkedAt: nowIso }
  try {
    const authInfo = await slack('auth.test')
    Object.assign(status, { connected: true, team: authInfo.team, botName: authInfo.user, error: null })
  } catch (err) {
    log('Slack connection failed:', err.message)
    await statusRef.set({ ...status, connected: false, error: describeSlackError(err.code) }, { merge: true })
    process.exitCode = 1
    return
  }
  try {
    status.channels = await listChannels()
  } catch (err) {
    log('Could not list channels:', err.message)
    status.error = describeSlackError(err.code)
  }
  const channelName = status.channels?.find((c) => c.id === config.channelId)?.name

  // 2. Test message requested from Settings
  if (config.testRequestedAt && config.testRequestedAt !== prevStatus.lastTest?.requestedAt) {
    const lastTest = { requestedAt: config.testRequestedAt, at: nowIso, ok: false }
    if (!config.channelId) lastTest.error = 'No channel selected.'
    else {
      try {
        await post(
          config.channelId,
          `:white_check_mark: *SP Admin is connected to this channel.*\nKitchen cleaning reminders will be posted here at ${config.alertTime} (${config.timeZone}) on working days.` +
            (config.enabled ? '' : '\n_Automatic alerts are currently turned off in SP Admin settings._') +
            (config.testRequestedBy ? `\n_Test sent by ${config.testRequestedBy}._` : ''),
        )
        lastTest.ok = true
        log('Test message sent to', channelName ?? config.channelId)
      } catch (err) {
        lastTest.error = describeSlackError(err.code)
        log('Test message failed:', err.message)
      }
    }
    status.lastTest = lastTest
  }
  await statusRef.set(status, { merge: true })

  // 3. Daily reminder
  await sendDailyAlert({ config, workspace, channelName })
}

async function sendDailyAlert({ config, workspace, channelName }) {
  if (!config.enabled) return log('Automatic alerts are off.')
  if (!config.channelId) return log('No channel selected.')

  const { date, time, weekday } = zonedNow(config.timeZone)
  if (weekday === 'Sat' || weekday === 'Sun') return log(`${date} is a weekend.`)
  if (config.skipDates?.includes(date)) return log(`${date} is a skipped date.`)
  if (time < config.alertTime) return log(`Not yet ${config.alertTime} in ${config.timeZone} (now ${time}).`)

  const alertRef = workspace.collection('slackAlerts').doc(date)
  const db = workspace.firestore

  // Claim today's alert so no other run sends it too.
  const claimed = await db.runTransaction(async (t) => {
    const prev = (await t.get(alertRef)).data()
    if (prev?.status === 'sent' || prev?.status === 'no_assignment') return false
    if (prev?.status === 'sending' && Date.now() - Date.parse(prev.updatedAt) < STALE_CLAIM_MS) return false
    if (prev?.status === 'failed' && prev.attempts >= MAX_ATTEMPTS) return false
    t.set(alertRef, { date, status: 'sending', attempts: (prev?.attempts ?? 0) + 1, employeeNames: prev?.employeeNames ?? [], updatedAt: new Date().toISOString() }, { merge: true })
    return true
  })
  if (!claimed) return log(`Alert for ${date} already handled.`)

  try {
    // Always read the latest schedule, so admin edits made before the alert are respected.
    const assignment = (await workspace.collection('cleaning').doc(date).get()).data()
    const ids = assignment?.employeeIds ?? []

    if (!ids.length) {
      const adminId = await slackUserId(config.adminSlackEmail)
      await post(
        adminId ?? config.channelId,
        `:warning: *No one is assigned to kitchen cleaning today* (${longDate(date)}).\nPlease assign an employee in SP Admin → Cleaning. No reminder was sent to the team.`,
      )
      await alertRef.set({ status: 'no_assignment', channelId: adminId ?? config.channelId, employeeNames: [], error: null, updatedAt: new Date().toISOString() }, { merge: true })
      return log(`No assignment for ${date}; notified ${adminId ? 'admin by DM' : 'the channel'}.`)
    }

    // Current names and emails; fall back to the snapshot saved on the assignment.
    const employeeSnaps = await Promise.all(ids.map((id) => workspace.collection('employees').doc(id).get()))
    const people = employeeSnaps.map((s, i) => ({ name: s.data()?.name ?? assignment.employeeNames?.[i] ?? 'Unknown', email: s.data()?.email }))
    const assignees = await Promise.all(people.map(async (p) => {
      const id = await slackUserId(p.email)
      return id ? `<@${id}>` : `*${p.name}*`
    }))
    const area = assignment.area || 'Office Kitchen'

    const res = await post(config.channelId, reminderText({ date, assignees, area }))
    await alertRef.set(
      { status: 'sent', channelId: config.channelId, channelName: channelName ?? null, employeeNames: people.map((p) => p.name), area, sentAt: new Date().toISOString(), messageTs: res.ts, error: null, updatedAt: new Date().toISOString() },
      { merge: true },
    )
    log(`Reminder for ${date} sent to #${channelName ?? config.channelId}: ${people.map((p) => p.name).join(', ')}`)
  } catch (err) {
    const message = err instanceof SlackError ? describeSlackError(err.code) : err.message
    await alertRef.set({ status: 'failed', error: message, updatedAt: new Date().toISOString() }, { merge: true })
    log(`Reminder for ${date} failed:`, err.message)
    process.exitCode = 1
  }
}

function describeSlackError(code) {
  const messages = {
    invalid_auth: 'The Slack bot token is invalid. Update the SLACK_BOT_TOKEN secret.',
    not_authed: 'No Slack bot token. Add the SLACK_BOT_TOKEN secret.',
    token_revoked: 'The Slack app was removed or its token revoked. Reinstall it and update SLACK_BOT_TOKEN.',
    account_inactive: 'The Slack app was removed or its token revoked. Reinstall it and update SLACK_BOT_TOKEN.',
    not_in_channel: 'The bot is not in this channel. In Slack, type /invite @<bot name> in the channel.',
    channel_not_found: 'Channel not found. Pick the channel again, and invite the bot if it is private.',
    is_archived: 'The selected channel is archived.',
    missing_scope: 'The Slack app is missing a permission (scope). See the setup steps in Settings.',
    ratelimited: 'Slack rate limit reached. It will be retried on the next run.',
  }
  return messages[code] ?? `Slack error: ${code}`
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
