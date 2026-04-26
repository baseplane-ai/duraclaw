import { type PushPayload, sendPushNotification } from '~/lib/push'
import { sendFcmNotification } from '~/lib/push-fcm'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 6: extracted body of `SessionDO.dispatchPush(...)`.
 *
 * Pure side-effect dispatcher — fans out push notifications via VAPID
 * (web push) and FCM (Capacitor Android). Reads subscriptions from
 * `AUTH_DB` and prunes stale rows on 410 Gone. No state mutation on
 * the DO; safe to run as fire-and-forget.
 */
export async function dispatchPushImpl(
  ctx: SessionDOContext,
  payload: PushPayload,
  eventType: 'blocked' | 'completed' | 'error',
): Promise<void> {
  const tag = `[push:dispatch ${ctx.ctx.id}]`
  const userId = ctx.state.userId
  if (!userId) {
    console.log(`${tag} no userId on state — skipping`)
    return
  }

  console.log(
    `${tag} begin`,
    JSON.stringify({
      eventType,
      url: payload.url,
      tag: payload.tag,
      sessionId: payload.sessionId,
      hasActions: payload.actions?.length ?? 0,
      hasActionToken: Boolean(payload.actionToken),
      userId,
    }),
  )

  const vapidPublicKey = ctx.env.VAPID_PUBLIC_KEY
  const vapidPrivateKey = ctx.env.VAPID_PRIVATE_KEY
  const vapidSubject = ctx.env.VAPID_SUBJECT

  // TODO: add push preference columns to user_preferences schema
  // (push.enabled, push.blocked, push.completed, push.error were never
  // migrated from the legacy KV shape to the columnar table — the old
  // query against key/value columns always threw. For now, treat all
  // push events as opt-in.)

  // Web push fan-out (VAPID-based)
  if (vapidPublicKey && vapidPrivateKey && vapidSubject) {
    let subscriptions: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
    try {
      const result = await ctx.env.AUTH_DB.prepare(
        'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
      )
        .bind(userId)
        .all<{ id: string; endpoint: string; p256dh: string; auth: string }>()
      subscriptions = result.results
    } catch (err) {
      console.error(`${tag} subscription lookup failed:`, err)
      subscriptions = []
    }

    console.log(`${tag} ${subscriptions.length} web push subscription(s)`)

    const vapid = {
      publicKey: vapidPublicKey,
      privateKey: vapidPrivateKey,
      subject: vapidSubject,
    }

    // Send to all subscriptions (best-effort, no retry)
    for (const sub of subscriptions) {
      const endpointSummary = sub.endpoint.slice(0, 60)
      const result = await sendPushNotification(sub, payload, vapid)
      console.log(
        `${tag} send sub=${sub.id} endpoint=${endpointSummary}... ok=${result.ok} status=${result.status ?? 'n/a'} gone=${Boolean(result.gone)}`,
      )
      if (result.gone) {
        // 410 Gone — delete stale subscription
        try {
          await ctx.env.AUTH_DB.prepare('DELETE FROM push_subscriptions WHERE id = ?')
            .bind(sub.id)
            .run()
          console.log(`${tag} deleted stale subscription ${sub.id}`)
        } catch (err) {
          console.error(`${tag} failed to delete stale subscription ${sub.id}:`, err)
        }
      }
    }
  } else {
    console.log(`${tag} VAPID not configured — skipping web push`)
  }

  // FCM fan-out (Capacitor Android shell). Reads `FCM_SERVICE_ACCOUNT_JSON`
  // — a Worker secret containing the Firebase service account JSON. Opt-in:
  // when unset, the FCM path is silently skipped (no Capacitor deployment).
  const fcmServiceAccount = ctx.env.FCM_SERVICE_ACCOUNT_JSON
  if (fcmServiceAccount) {
    let fcmRows: Array<{ id: string; token: string }> = []
    try {
      const fcmResult = await ctx.env.AUTH_DB.prepare(
        'SELECT id, token FROM fcm_subscriptions WHERE user_id = ?',
      )
        .bind(userId)
        .all<{ id: string; token: string }>()
      fcmRows = fcmResult.results
    } catch (err) {
      console.error(`${tag} fcm subscription lookup failed:`, err)
    }

    if (fcmRows.length > 0) {
      console.log(`${tag} fcm ${fcmRows.length} subscription(s)`)
      for (const row of fcmRows) {
        try {
          const tokenSummary = row.token.slice(0, 16)
          const result = await sendFcmNotification(row.token, payload, fcmServiceAccount)
          console.log(
            `${tag} fcm send sub=${row.id} token=${tokenSummary}... ok=${result.ok} status=${result.status ?? 'n/a'} gone=${Boolean(result.gone)}`,
          )
          if (result.gone) {
            try {
              await ctx.env.AUTH_DB.prepare('DELETE FROM fcm_subscriptions WHERE id = ?')
                .bind(row.id)
                .run()
              console.log(`${tag} fcm deleted stale subscription ${row.id}`)
            } catch (err) {
              console.error(`${tag} fcm failed to delete stale subscription ${row.id}:`, err)
            }
          }
        } catch (err) {
          console.error(`${tag} fcm send threw for sub=${row.id}:`, err)
        }
      }
    }
  }
}
