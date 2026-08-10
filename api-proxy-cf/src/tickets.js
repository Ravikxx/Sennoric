export class TicketError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'TicketError'
    this.status = status
  }
}

const VALID_STATUSES = ['open', 'replied', 'closed']

function serializeTicket(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    email: row.email,
    name: row.name,
    subject: row.subject,
    message: row.message,
    category: row.category,
    anonymous: Boolean(row.anonymous),
    status: row.status,
    admin_reply: row.admin_reply,
    replied_by: row.replied_by,
    replied_at: row.replied_at,
    created_at: row.created_at,
  }
}

export async function createTicket(db, { user, email, name, subject, message, category }) {
  const cleanSubject = String(subject || '').trim().slice(0, 200)
  const cleanMessage = String(message || '').trim().slice(0, 5000)
  const cleanEmail = String(email || user?.email || '').trim().toLowerCase()
  if (!cleanSubject) throw new TicketError('Subject is required.')
  if (!cleanMessage) throw new TicketError('Message is required.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new TicketError('A valid email is required.')

  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO tickets (id, user_id, email, name, subject, message, category, anonymous, status)
     VALUES (?,?,?,?,?,?,?,?,'open')`
  ).bind(
    id,
    user?.id || null,
    cleanEmail,
    String(name || user?.email || '').trim().slice(0, 200) || null,
    cleanSubject,
    cleanMessage,
    String(category || 'general').trim().slice(0, 50) || 'general',
    user ? 0 : 1,
  ).run()

  const row = await db.prepare('SELECT * FROM tickets WHERE id=?').bind(id).first()
  return serializeTicket(row)
}

export async function listTickets(db, { status, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50))
  const query = status && VALID_STATUSES.includes(status)
    ? db.prepare('SELECT * FROM tickets WHERE status=? ORDER BY created_at DESC LIMIT ?').bind(status, safeLimit)
    : db.prepare('SELECT * FROM tickets ORDER BY created_at DESC LIMIT ?').bind(safeLimit)
  const { results } = await query.all()
  return results.map(serializeTicket)
}

export async function getTicket(db, ticketId) {
  const row = await db.prepare('SELECT * FROM tickets WHERE id=?').bind(ticketId).first()
  if (!row) throw new TicketError('Ticket not found.', 404)
  return serializeTicket(row)
}

export async function replyToTicket(db, { ticketId, reply, adminEmail, status }) {
  const cleanReply = String(reply || '').trim().slice(0, 5000)
  if (!cleanReply) throw new TicketError('Reply message is required.')
  const nextStatus = status && VALID_STATUSES.includes(status) ? status : 'replied'
  const existing = await db.prepare('SELECT id FROM tickets WHERE id=?').bind(ticketId).first()
  if (!existing) throw new TicketError('Ticket not found.', 404)

  await db.prepare(
    `UPDATE tickets SET admin_reply=?, replied_by=?, replied_at=?, status=? WHERE id=?`
  ).bind(cleanReply, adminEmail, Date.now(), nextStatus, ticketId).run()

  return getTicket(db, ticketId)
}

export async function setTicketStatus(db, { ticketId, status }) {
  if (!VALID_STATUSES.includes(status)) throw new TicketError('Invalid status.')
  const existing = await db.prepare('SELECT id FROM tickets WHERE id=?').bind(ticketId).first()
  if (!existing) throw new TicketError('Ticket not found.', 404)
  await db.prepare('UPDATE tickets SET status=? WHERE id=?').bind(status, ticketId).run()
  return getTicket(db, ticketId)
}
