// ── Remote: phone <-> desktop code-agent relay ───────────────────────────────
//
// Lets the Sennoric iPhone app pair with the Sennoric Desktop (Electron) app
// through this worker so the phone can view and drive the desktop's local
// "Code" agent sessions. One Durable Object instance per pairing id holds the
// live desktop (host) socket and relays the JSON message protocol to the
// attached phone (client) socket. Both ends speak the same protocol; the DO
// only forwards frames and never interprets them.
//
// Pairing ownership is enforced at the route layer (index.js): only the
// Sennoric account that created a pairing may connect as host or client.

export class RemoteRelay {
  constructor(state, env) {
    this.state = state
    this.host = null
    this.client = null
  }

  async fetch(request) {
    const url = new URL(request.url)
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'client'

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()

    if (role === 'host') {
      // A new desktop connection replaces any previous one.
      if (this.host) { try { this.host.close(4000, 'replaced by new connection') } catch {} }
      this.host = server
      this.broadcast({ type: 'status', hostConnected: true, clientConnected: !!this.client })

      server.addEventListener('message', (ev) => this.relayToClient(ev.data))
      const onGone = () => {
        if (this.host === server) {
          this.host = null
          this.broadcast({ type: 'status', hostConnected: false, clientConnected: !!this.client })
        }
      }
      server.addEventListener('close', onGone)
      server.addEventListener('error', onGone)
    } else {
      // A new phone connection replaces any previous one.
      if (this.client) { try { this.client.close(4000, 'replaced by new connection') } catch {} }
      this.client = server
      this.broadcast({ type: 'status', hostConnected: !!this.host, clientConnected: true })

      server.addEventListener('message', (ev) => this.relayToHost(ev.data))
      const onGone = () => {
        if (this.client === server) {
          this.client = null
          this.broadcast({ type: 'status', hostConnected: !!this.host, clientConnected: false })
        }
      }
      server.addEventListener('close', onGone)
      server.addEventListener('error', onGone)
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  relayToClient(data) {
    if (this.client) { try { this.client.send(data) } catch {} }
  }

  relayToHost(data) {
    if (this.host) { try { this.host.send(data) } catch {} }
  }

  broadcast(msg) {
    const data = JSON.stringify(msg)
    if (this.host) { try { this.host.send(data) } catch {} }
    if (this.client) { try { this.client.send(data) } catch {} }
  }
}
