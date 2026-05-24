import CommonCrypto
import Foundation
import Network
import Security

/// RFC 6455 WebSocket client implemented on top of a raw NWConnection.
///
/// We bypass Apple's `NWProtocolWebSocket` because its built-in handshake
/// validator is opaque (it consumes the upgrade response and only reports
/// success/failure with no detail), and it strips reserved headers like
/// Authorization that we need for some K8s auth flows. By driving the
/// handshake ourselves we get full visibility into what the server actually
/// sent back, and we accept any response that satisfies the RFC's stated
/// requirements — no more, no less.
///
/// Threading: all mutable state is accessed only from `queue`. NWConnection
/// callbacks run on `queue` and JS-initiated sends dispatch onto it before
/// touching the connection. No locks needed.
final class ManualWebSocket {
  /// Closure-based event sink. The module's JS-bound path passes callbacks
  /// that forward to sendEvent; the in-Swift port-forward bridge passes
  /// callbacks that handle the K8s portforward stream framing locally.
  struct Callbacks {
    var onOpen: (_ negotiatedProtocol: String) -> Void = { _ in }
    var onText: (_ text: String) -> Void = { _ in }
    var onBinary: (_ data: Data) -> Void = { _ in }
    var onClose: (_ code: Int, _ reason: String) -> Void = { _, _ in }
    var onError: (_ name: String, _ message: String, _ status: Int?) -> Void = { _, _, _ in }
  }

  let wsId: String
  let conn: NWConnection
  let queue: DispatchQueue
  let hostHeader: String          // "host" or "host:port"
  let path: String                // "/api/v1/..?stdin=true..."
  let protocols: [String]
  let extraHeaders: [(String, String)]
  let secWebSocketKey: String
  let expectedAccept: String
  let callbacks: Callbacks

  // All state below is queue-confined.
  private var rxBuffer = Data()
  private var handshakeDone = false
  private var closed = false
  private var negotiatedProtocol = ""
  // Set when we got a non-101 status. Keeps the receive loop alive so the
  // body can finish arriving — most servers (K8s included) explain *why* the
  // upgrade was rejected in the response body, not the headers.
  private var handshakeFailed = false
  private var failedStatus = 0
  private var failedHeaders = ""

  init(
    wsId: String,
    hostHeader: String,
    path: String,
    protocols: [String],
    extraHeaders: [(String, String)],
    conn: NWConnection,
    queue: DispatchQueue,
    callbacks: Callbacks
  ) {
    self.wsId = wsId
    self.conn = conn
    self.queue = queue
    self.hostHeader = hostHeader
    self.path = path
    self.protocols = protocols
    self.extraHeaders = extraHeaders
    self.callbacks = callbacks

    // RFC 6455 §4.1: Sec-WebSocket-Key is a base64-encoded 16-byte nonce.
    var keyBytes = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, 16, &keyBytes)
    self.secWebSocketKey = Data(keyBytes).base64EncodedString()

    // RFC 6455 §4.2.2: expected Sec-WebSocket-Accept = base64(SHA1(key + GUID))
    let combined = self.secWebSocketKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    let combinedData = Data(combined.utf8)
    var hash = [UInt8](repeating: 0, count: Int(CC_SHA1_DIGEST_LENGTH))
    combinedData.withUnsafeBytes { ptr in
      _ = CC_SHA1(ptr.baseAddress, CC_LONG(combinedData.count), &hash)
    }
    self.expectedAccept = Data(hash).base64EncodedString()
  }

  // MARK: - Lifecycle

  /// Called once the NWConnection transitions to .ready. Sends the HTTP/1.1
  /// upgrade request and starts the receive loop.
  func sendHandshake() {
    var lines: [String] = []
    lines.append("GET \(path) HTTP/1.1")
    lines.append("Host: \(hostHeader)")
    lines.append("Upgrade: websocket")
    lines.append("Connection: Upgrade")
    lines.append("Sec-WebSocket-Key: \(secWebSocketKey)")
    lines.append("Sec-WebSocket-Version: 13")
    if !protocols.isEmpty {
      lines.append("Sec-WebSocket-Protocol: \(protocols.joined(separator: ", "))")
    }
    for (k, v) in extraHeaders {
      lines.append("\(k): \(v)")
    }
    let request = lines.joined(separator: "\r\n") + "\r\n\r\n"
    NSLog("[k8s-mtls] ws %@ → sending handshake (%d bytes, protocols=%@)",
          wsId, request.utf8.count, protocols.joined(separator: ","))

    conn.send(content: Data(request.utf8), completion: .contentProcessed { [weak self] err in
      guard let self = self else { return }
      if let err = err {
        self.queue.async {
          self.emitError("Failed to send WS upgrade request: \(err.localizedDescription)")
        }
        return
      }
      self.startReceive()
    })
  }

  private func startReceive() {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
      guard let self = self else { return }
      // The queue this fires on is the one we passed to conn.start(queue:),
      // which is our own `queue`. Single-threaded from here on.
      if self.closed { return }
      if let error = error {
        self.emitError("Receive error: \(error.localizedDescription) (code \(error.errorCode))")
        return
      }
      if let data = data, !data.isEmpty {
        self.rxBuffer.append(data)
        if self.handshakeFailed {
          // Keep accumulating body bytes; a timer scheduled when we hit
          // !=101 will emit the full diagnostic once enough body has
          // arrived (or 300ms passes).
        } else if !self.handshakeDone {
          self.processHandshake()
        } else {
          self.processFrames()
        }
      }
      if isComplete {
        // Server closed the TCP side. The interpretation depends on where we
        // are in the handshake — without this branching, a non-101 response
        // followed immediately by FIN raced our deferred handshake-failure
        // emitter and the real error was lost.
        if !self.closed {
          if self.handshakeFailed {
            // We've already parsed a non-101 status. Whatever body fit in
            // rxBuffer is everything we'll get; emit the proper HTTPError
            // now instead of letting the 300ms timer get there first.
            self.emitHandshakeFailure()
          } else if !self.handshakeDone {
            // Server hung up the TCP without responding to the upgrade
            // request at all. Most commonly: an LB / reverse-proxy in front
            // of the apiserver is stripping the WS Upgrade header, or the
            // PortForwardWebsockets feature gate is off on a pre-1.32
            // cluster, or the cluster's apiserver returned nothing because
            // it didn't recognise the path / method.
            self.callbacks.onError(
              "UpgradeNoResponse",
              "K8s closed the TCP connection without responding to the WebSocket upgrade request.\n\n"
              + "Common causes:\n"
              + "  • A load balancer / reverse proxy in front of the apiserver is not forwarding the WS Upgrade header (e.g. an L7 LB without WS support).\n"
              + "  • The cluster's PortForwardWebsockets feature gate is disabled (pre-1.32 with feature gate off).\n"
              + "  • An ingress controller terminating TLS in front of the apiserver and not proxying WebSocket upgrades.\n\n"
              + "Try: kubectl --v=8 port-forward against the same pod from a workstation — if that's also failing on WebSocket upgrade you've confirmed the cluster side; if it works via SPDY there, the apiserver is fine but our WS path is blocked.",
              nil
            )
            self.closed = true
            self.conn.cancel()
          } else {
            // Normal post-handshake close (the WS lived a healthy life and
            // got a FIN).
            self.callbacks.onClose(1000, "peer-closed-tcp")
            self.closed = true
          }
        }
        return
      }
      if !self.closed {
        self.startReceive()
      }
    }
  }

  // MARK: - Handshake parsing

  private func processHandshake() {
    let delim = Data("\r\n\r\n".utf8)
    guard let range = rxBuffer.range(of: delim) else { return }   // need more

    let headerBytes = rxBuffer.subdata(in: 0..<range.lowerBound)
    let remaining = rxBuffer.subdata(in: range.upperBound..<rxBuffer.count)
    rxBuffer = remaining

    guard let headerStr = String(data: headerBytes, encoding: .utf8) else {
      emitError("Server handshake response is not valid UTF-8 (\(headerBytes.count) bytes)")
      return
    }

    NSLog("[k8s-mtls] ws %@ ← handshake response received (%d bytes):\n%@",
          wsId, headerBytes.count, headerStr)

    let lines = headerStr.components(separatedBy: "\r\n")
    guard let statusLine = lines.first else {
      emitError("Empty handshake response")
      return
    }

    // Status line: "HTTP/1.1 101 Switching Protocols"
    let statusParts = statusLine.split(separator: " ", maxSplits: 2)
    guard statusParts.count >= 2, let status = Int(statusParts[1]) else {
      emitError("Could not parse status line: \(statusLine)")
      return
    }

    // Headers — lowercase keys for case-insensitive lookup.
    var headers: [String: String] = [:]
    for line in lines.dropFirst() where !line.isEmpty {
      guard let colon = line.firstIndex(of: ":") else { continue }
      let k = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
      let v = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      headers[k] = v
    }

    if status != 101 {
      // Don't emit yet — the server typically explains the actual cause in
      // the response body (e.g. "Unable to upgrade: portforward WebSockets
      // feature gate is disabled", or "Bad Request: unable to negotiate
      // subprotocol"). Keep the receive loop alive for ~300ms so the body
      // can arrive, then emit the full diagnostic.
      handshakeFailed = true
      failedStatus = status
      failedHeaders = headerStr
      queue.asyncAfter(deadline: .now() + 0.3) { [weak self] in
        self?.emitHandshakeFailure()
      }
      return
    }

    // RFC 6455 §4.1: Upgrade must contain "websocket" (case-insensitive).
    let upgrade = headers["upgrade"]?.lowercased() ?? ""
    if !upgrade.contains("websocket") {
      emitError("Bad Upgrade header: '\(upgrade)' (expected to contain 'websocket')\n\nFull response:\n\(headerStr)")
      return
    }
    // RFC 6455 §4.1: Connection must contain "Upgrade" (case-insensitive).
    let connHdr = headers["connection"]?.lowercased() ?? ""
    if !connHdr.contains("upgrade") {
      emitError("Bad Connection header: '\(connHdr)' (expected to contain 'upgrade')\n\nFull response:\n\(headerStr)")
      return
    }
    // RFC 6455 §4.1: Sec-WebSocket-Accept must equal our computed value.
    let accept = headers["sec-websocket-accept"] ?? ""
    if accept != expectedAccept {
      emitError("""
        Sec-WebSocket-Accept mismatch.
          got:      \(accept)
          expected: \(expectedAccept)
          our key:  \(secWebSocketKey)

        Full response:
        \(headerStr)
        """)
      return
    }

    // Subprotocol — empty is OK if we didn't offer any. If we did offer some,
    // the server SHOULD pick one of them, but we tolerate it picking nothing
    // (some servers don't echo a subprotocol if there's only one path).
    negotiatedProtocol = headers["sec-websocket-protocol"] ?? ""
    if !protocols.isEmpty
        && !negotiatedProtocol.isEmpty
        && !protocols.contains(where: { $0.caseInsensitiveCompare(negotiatedProtocol) == .orderedSame }) {
      emitError("Server picked subprotocol '\(negotiatedProtocol)' which we did not offer (\(protocols.joined(separator: ", ")))")
      return
    }

    handshakeDone = true
    callbacks.onOpen(negotiatedProtocol)

    // The first frame data may have arrived in the same TCP read.
    if !rxBuffer.isEmpty {
      processFrames()
    }
  }

  // MARK: - Frame parsing

  private struct WSFrame {
    let fin: Bool
    let opcode: UInt8
    let payload: Data
  }

  private func processFrames() {
    while !rxBuffer.isEmpty {
      guard let (frame, consumed) = parseOneFrame() else { return }  // need more bytes
      rxBuffer.removeSubrange(0..<consumed)
      dispatchFrame(frame)
      if closed { return }
    }
  }

  /// Parses one RFC 6455 frame from rxBuffer's head. Returns nil if the
  /// buffer doesn't yet contain a complete frame (caller will wait for more).
  private func parseOneFrame() -> (WSFrame, Int)? {
    guard rxBuffer.count >= 2 else { return nil }
    var pos = 0
    let b0 = rxBuffer[pos]; pos += 1
    let b1 = rxBuffer[pos]; pos += 1
    let fin = (b0 & 0x80) != 0
    let opcode = b0 & 0x0F
    let masked = (b1 & 0x80) != 0
    var payloadLen = Int(b1 & 0x7F)

    if payloadLen == 126 {
      guard rxBuffer.count >= pos + 2 else { return nil }
      payloadLen = (Int(rxBuffer[pos]) << 8) | Int(rxBuffer[pos + 1])
      pos += 2
    } else if payloadLen == 127 {
      guard rxBuffer.count >= pos + 8 else { return nil }
      var pl: UInt64 = 0
      for i in 0..<8 { pl = (pl << 8) | UInt64(rxBuffer[pos + i]) }
      pos += 8
      payloadLen = Int(pl)
    }

    var maskKey = [UInt8](repeating: 0, count: 4)
    if masked {
      guard rxBuffer.count >= pos + 4 else { return nil }
      for i in 0..<4 { maskKey[i] = rxBuffer[pos + i] }
      pos += 4
    }

    guard rxBuffer.count >= pos + payloadLen else { return nil }
    var payload = rxBuffer.subdata(in: pos..<(pos + payloadLen))
    if masked {
      for i in 0..<payload.count { payload[i] ^= maskKey[i % 4] }
    }
    pos += payloadLen

    return (WSFrame(fin: fin, opcode: opcode, payload: payload), pos)
  }

  private func dispatchFrame(_ frame: WSFrame) {
    switch frame.opcode {
    case 0x1: // text
      if let text = String(data: frame.payload, encoding: .utf8) {
        callbacks.onText(text)
      }
    case 0x2: // binary
      callbacks.onBinary(frame.payload)
    case 0x8: // close
      // Echo + close. Pull the status code out of the payload if present.
      var code = 1000
      var reason = "peer-close"
      if frame.payload.count >= 2 {
        code = (Int(frame.payload[0]) << 8) | Int(frame.payload[1])
        if frame.payload.count > 2 {
          reason = String(data: frame.payload.subdata(in: 2..<frame.payload.count), encoding: .utf8) ?? reason
        }
      }
      sendFrame(opcode: 0x8, payload: frame.payload)
      callbacks.onClose(code, reason)
      closed = true
      conn.cancel()
    case 0x9: // ping → reply pong
      sendFrame(opcode: 0xA, payload: frame.payload)
    case 0xA: // pong — nothing to do
      break
    case 0x0: // continuation — best-effort; K8s exec/portforward don't fragment.
      callbacks.onBinary(frame.payload)
    default:
      break
    }
  }

  // MARK: - Send (called from external threads — dispatched onto `queue`)

  func sendBinary(_ data: Data) {
    queue.async { [weak self] in self?.sendFrame(opcode: 0x2, payload: data) }
  }

  func sendText(_ text: String) {
    queue.async { [weak self] in self?.sendFrame(opcode: 0x1, payload: Data(text.utf8)) }
  }

  func close() {
    queue.async { [weak self] in
      guard let self = self, !self.closed else { return }
      self.closed = true
      // Close frame with code 1000 (normal).
      var payload = Data()
      payload.append(0x03); payload.append(0xE8)
      self.sendFrame(opcode: 0x8, payload: payload)
      // Give the close frame a moment to flush, then drop the socket.
      self.queue.asyncAfter(deadline: .now() + 0.1) { self.conn.cancel() }
    }
  }

  /// Build + send a single RFC 6455 frame. Client frames MUST be masked.
  /// Called from `queue` only.
  private func sendFrame(opcode: UInt8, payload: Data) {
    // Allow control frames (close) even after we've flagged closed=true so
    // close handshakes complete; otherwise drop.
    if closed && opcode != 0x8 { return }

    var frame = Data()
    frame.append(0x80 | (opcode & 0x0F))  // FIN=1, opcode

    var maskKey = [UInt8](repeating: 0, count: 4)
    _ = SecRandomCopyBytes(kSecRandomDefault, 4, &maskKey)

    let len = payload.count
    if len < 126 {
      frame.append(0x80 | UInt8(len))  // MASK=1
    } else if len <= 65535 {
      frame.append(0x80 | 126)
      frame.append(UInt8((len >> 8) & 0xFF))
      frame.append(UInt8(len & 0xFF))
    } else {
      frame.append(0x80 | 127)
      let lenU = UInt64(len)
      for i in (0..<8).reversed() {
        frame.append(UInt8((lenU >> (UInt64(i) * 8)) & 0xFF))
      }
    }
    frame.append(contentsOf: maskKey)

    var masked = payload
    for i in 0..<masked.count { masked[i] ^= maskKey[i % 4] }
    frame.append(masked)

    conn.send(content: frame, completion: .contentProcessed { _ in })
  }

  // MARK: - Helpers

  private func emitError(_ message: String) {
    if closed { return }
    closed = true
    NSLog("[k8s-mtls] ws %@ ✗ %@", wsId, message)
    callbacks.onError("WebSocketError", message, nil)
    conn.cancel()
  }

  /// Called by the deferred scheduler after a non-101 handshake response.
  /// Emits the actual server explanation (response body) alongside the
  /// status and headers. The body is the load-bearing part of the error —
  /// the K8s API server uses it for "Unable to upgrade" reasons.
  private func emitHandshakeFailure() {
    if closed { return }
    let bodyStr: String
    if rxBuffer.isEmpty {
      bodyStr = "(no body)"
    } else if let s = String(data: rxBuffer, encoding: .utf8) {
      bodyStr = s
    } else {
      bodyStr = "(\(rxBuffer.count) bytes of non-UTF-8 body)"
    }
    NSLog("[k8s-mtls] ws %@ ✗ handshake failed: HTTP %d\nheaders:\n%@\nbody:\n%@",
          wsId, failedStatus, failedHeaders, bodyStr)
    callbacks.onError(
      "HTTPError",
      "Server returned HTTP \(failedStatus) instead of 101 Switching Protocols.\n\nResponse headers:\n\(failedHeaders)\n\nResponse body:\n\(bodyStr)",
      failedStatus
    )
    closed = true
    conn.cancel()
  }
}
