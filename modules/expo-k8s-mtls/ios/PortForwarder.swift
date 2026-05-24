import Foundation
import Network
import Security

// Upstream connection details + cluster credentials shared by every TCP→WS
// bridge inside a single port-forward session. Captured once when the session
// is started so callers don't have to ferry creds across event boundaries.
struct PortForwardUpstream {
  let scheme: String                    // "wss" or "ws"
  let host: String
  let port: UInt16
  let path: String                      // /api/v1/namespaces/{ns}/pods/{name}/portforward?ports={p}
  let headers: [(String, String)]
  let pkcs12Base64: String?
  let pkcs12Password: String?
  let caBundlesDerBase64: [String]
  let insecureSkipTLSVerify: Bool
  let tlsServerName: String?
  let remotePort: UInt16
}

/// One port-forward session. Owns a NWListener bound to 127.0.0.1:localPort.
/// Every accepted TCP connection spawns a fresh K8s portforward.k8s.io
/// WebSocket via `PortForwardBridge` — kubectl multiplexes multiple local
/// connections onto a single SPDY stream pair, but doing the same over our
/// hand-rolled WebSocket would mean inventing local stream IDs. One WS per
/// connection is conceptually simpler and the cost is a few hundred ms of
/// TLS handshake per HTTP connection, which is fine for tooling.
final class PortForwardSession {
  let id: String
  weak var module: ExpoK8sMtlsModule?
  let queue: DispatchQueue
  let listener: NWListener
  let upstream: PortForwardUpstream

  private var bridges: [PortForwardBridge] = []
  private let bridgesLock = NSLock()
  private var listeningEmitted = false

  init(
    id: String,
    module: ExpoK8sMtlsModule,
    listener: NWListener,
    queue: DispatchQueue,
    upstream: PortForwardUpstream
  ) {
    self.id = id
    self.module = module
    self.listener = listener
    self.queue = queue
    self.upstream = upstream
  }

  func start() {
    listener.stateUpdateHandler = { [weak self] state in
      guard let self = self else { return }
      switch state {
      case .ready:
        if !self.listeningEmitted {
          self.listeningEmitted = true
          let port: UInt16 = self.listener.port?.rawValue ?? 0
          self.module?.sendEvent("onK8sPfListening", [
            "id": self.id,
            "localPort": Int(port),
          ])
        }
      case .failed(let err):
        self.module?.sendEvent("onK8sPfError", [
          "id": self.id,
          "name": "ListenerFailed",
          "message": err.localizedDescription,
        ])
        self.stop(reason: "listener-failed")
      case .cancelled:
        // The cancelled state is reached after stop() so we don't need to do
        // anything here — stop() already emits onK8sPfClosed.
        break
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] conn in
      self?.acceptConnection(conn)
    }
    listener.start(queue: queue)
  }

  func stop(reason: String = "stopped") {
    listener.cancel()
    bridgesLock.lock()
    let snap = bridges
    bridges.removeAll()
    bridgesLock.unlock()
    for b in snap { b.close() }
    // Remove ourselves from the module's session table so the background-
    // task refcount reflects reality even when the apiserver killed us
    // (server-initiated close, network error, etc.) rather than the user.
    if let m = module {
      m.portForwardsLock.lock()
      m.portForwards.removeValue(forKey: id)
      m.portForwardsLock.unlock()
      m.sendEvent("onK8sPfClosed", ["id": id, "reason": reason])
      m.refreshBackgroundTask()
    }
  }

  private func acceptConnection(_ tcp: NWConnection) {
    let bridge = PortForwardBridge(session: self, tcp: tcp)
    bridgesLock.lock()
    bridges.append(bridge)
    let n = bridges.count
    bridgesLock.unlock()
    NSLog("[k8s-mtls] pf %@ ← accepted TCP connection from local client (bridges=%d)", id, n)
    module?.sendEvent("onK8sPfStatus", [
      "id": id,
      "kind": "connection-opened",
      "bridges": n,
    ])
    bridge.start()
  }

  func removeBridge(_ bridge: PortForwardBridge) {
    bridgesLock.lock()
    bridges.removeAll(where: { $0 === bridge })
    let n = bridges.count
    bridgesLock.unlock()
    module?.sendEvent("onK8sPfStatus", [
      "id": id,
      "kind": "connection-closed",
      "bridges": n,
    ])
  }
}

/// One TCP ↔ K8s-portforward-WS pair. Runs the K8s SPDY-tunnel-over-
/// WebSocket protocol:
///
///   1. Open WS with subprotocol "SPDY/3.1+portforward.k8s.io"
///   2. Inside the WS, speak SPDY/3.1 (control + data frames, zlib-
///      compressed NV header blocks with the SPDY/3 dictionary)
///   3. Open two SPDY streams per port forward:
///        • error stream (streamType=error, port=N, requestID=0)   — opened first
///        • data  stream (streamType=data,  port=N, requestID=0)
///   4. Local TCP bytes → DATA frames on the data stream
///   5. DATA frames on the data stream → local TCP send
///   6. DATA frames on the error stream → surface as PfError + close
///
/// One SPDY connection per WS, one stream-pair per local TCP connection.
/// (kubectl multiplexes many local connections onto one SPDY conn, but the
/// per-connection isolation is simpler and the WS handshake cost is the
/// only real overhead — fine for an interactive tool.)
final class PortForwardBridge {
  weak var session: PortForwardSession?
  let tcp: NWConnection
  var ws: ManualWebSocket?

  // SPDY layer comes up after the WS handshake completes. Any local TCP
  // bytes that arrive before then sit in pendingTCPData and get flushed
  // by startSpdy() onto the data stream once it exists.
  private var spdy: SpdyConnection?
  private var dataStream: SpdyStream?
  private var errorStream: SpdyStream?
  private var spdyReady = false

  private var pendingTCPData: [Data] = []
  private var closed = false
  private let queue: DispatchQueue

  init(session: PortForwardSession, tcp: NWConnection) {
    self.session = session
    self.tcp = tcp
    self.queue = session.queue
  }

  // Counters so we can see, in the logs, whether Safari ever actually wrote
  // anything before the connection died.
  private var rxFromLocal: Int = 0
  private var txToLocal: Int = 0

  func start() {
    tcp.stateUpdateHandler = { [weak self] state in
      guard let self = self else { return }
      NSLog("[k8s-mtls] pf-bridge local TCP state: %@ (rx=%d tx=%d)",
            "\(state)", self.rxFromLocal, self.txToLocal)
      switch state {
      case .failed(let err):
        self.close(reason: "local-tcp-failed: \(err.localizedDescription)")
      case .cancelled:
        self.close(reason: "local-tcp-cancelled")
      default:
        break
      }
    }
    tcp.start(queue: queue)
    openUpstream()
    receiveTCPLoop()
  }

  private func openUpstream() {
    guard let session = session else { return }
    let upstream = session.upstream
    let isTLS = upstream.scheme == "wss"

    // TLS / mTLS setup — mirrors ExpoK8sMtlsModule.openNWWebSocket. Kept
    // local so the bridge doesn't need a back-reference into the module's
    // verify-block plumbing.
    var clientIdentity: SecIdentity?
    if let p12B64 = upstream.pkcs12Base64, let p12Data = Data(base64Encoded: p12B64) {
      let password = upstream.pkcs12Password ?? ""
      let importOptions: [String: Any] = [kSecImportExportPassphrase as String: password]
      var items: CFArray?
      let status = SecPKCS12Import(p12Data as CFData, importOptions as CFDictionary, &items)
      if status == errSecSuccess,
         let array = items as? [[String: Any]],
         let identityRef = array.first?[kSecImportItemIdentity as String] {
        clientIdentity = (identityRef as! SecIdentity)
      } else {
        emitUpstreamError("PKCS12ImportFailed", "SecPKCS12Import OSStatus \(status)")
        close()
        return
      }
    }
    var trustAnchors: [SecCertificate] = []
    for derB64 in upstream.caBundlesDerBase64 {
      guard let der = Data(base64Encoded: derB64),
            let cert = SecCertificateCreateWithData(nil, der as CFData) else { continue }
      trustAnchors.append(cert)
    }

    let parameters: NWParameters
    if isTLS {
      let tlsOpts = NWProtocolTLS.Options()
      let secOpts = tlsOpts.securityProtocolOptions
      if let serverName = upstream.tlsServerName, !serverName.isEmpty {
        sec_protocol_options_set_tls_server_name(secOpts, serverName)
      }
      let verifyQueue = DispatchQueue(label: "expo.k8s.pf.tls.verify")
      let insecure = upstream.insecureSkipTLSVerify
      let anchorsCopy = trustAnchors
      sec_protocol_options_set_verify_block(secOpts, { _, secTrust, completion in
        let trust = sec_trust_copy_ref(secTrust).takeRetainedValue()
        if insecure { completion(true); return }
        if !anchorsCopy.isEmpty {
          SecTrustSetAnchorCertificates(trust, anchorsCopy as CFArray)
          SecTrustSetAnchorCertificatesOnly(trust, true)
        }
        var cfErr: CFError?
        completion(SecTrustEvaluateWithError(trust, &cfErr))
      }, verifyQueue)
      if let identity = clientIdentity, let secIdentity = sec_identity_create(identity) {
        sec_protocol_options_set_local_identity(secOpts, secIdentity)
      }
      parameters = NWParameters(tls: tlsOpts)
    } else {
      parameters = NWParameters.tcp
    }

    let wsConn = NWConnection(
      host: NWEndpoint.Host(upstream.host),
      port: NWEndpoint.Port(integerLiteral: upstream.port),
      using: parameters
    )

    let hostHeader: String
    if (isTLS && upstream.port == 443) || (!isTLS && upstream.port == 80) {
      hostHeader = upstream.host
    } else {
      hostHeader = "\(upstream.host):\(upstream.port)"
    }

    let wsId = "pf-\(UUID().uuidString)"
    NSLog("[k8s-mtls] pf-bridge opening K8s WS %@:%d%@", upstream.host, upstream.port, upstream.path)
    let cb = ManualWebSocket.Callbacks(
      onOpen: { [weak self] proto in
        NSLog("[k8s-mtls] pf-bridge K8s WS OPEN (subprotocol=%@)", proto)
        if let s = self?.session {
          s.module?.sendEvent("onK8sPfStatus", [
            "id": s.id,
            "kind": "ws-open",
            "bridges": -1,
          ])
        }
        // Spin the SPDY layer up now that the tunnel is ready. This is what
        // actually opens the data + error streams so the apiserver knows
        // which port we want.
        self?.startSpdy()
      },
      onText: { _ in
        // SPDY/3 is binary-only; ignore any unexpected text.
      },
      onBinary: { [weak self] data in
        // Every WS binary message carries 0..N SPDY frames (the framer
        // copes with partials and multi-frames). Just feed it through.
        self?.spdy?.feed(data)
      },
      onClose: { [weak self] code, reason in
        NSLog("[k8s-mtls] pf-bridge K8s WS closed code=%d reason=%@", code, reason)
        // Surface a status event so the JS side sees "ws-close" even when
        // the close was clean (no onError path). Otherwise the bridge dies
        // invisibly to the user when the apiserver hangs up.
        if let s = self?.session {
          s.module?.sendEvent("onK8sPfStatus", [
            "id": s.id,
            "kind": "ws-close-\(code)",
            "bridges": -1,
          ])
        }
        self?.close(reason: "ws-close-\(code)-\(reason)")
      },
      onError: { [weak self] name, message, _ in
        NSLog("[k8s-mtls] pf-bridge K8s WS error: %@ — %@", name, message)
        self?.emitUpstreamError(name, message)
        self?.close(reason: "ws-error-\(name)")
      }
    )

    let ws = ManualWebSocket(
      wsId: wsId,
      hostHeader: hostHeader,
      path: upstream.path,
      // SPDY/3.1+portforward.k8s.io is the only WS subprotocol K8s accepts
      // for the portforward endpoint. The inner protocol is SPDY/3.1
      // (handled below by SpdyConnection); the "portforward.k8s.io" tail
      // tells the apiserver to use the data/error stream semantics.
      protocols: ["SPDY/3.1+portforward.k8s.io"],
      extraHeaders: upstream.headers,
      conn: wsConn,
      queue: queue,
      callbacks: cb
    )
    self.ws = ws

    wsConn.stateUpdateHandler = { [weak self, weak ws] state in
      guard let self = self else { return }
      NSLog("[k8s-mtls] pf-bridge K8s NWConnection state: %@", "\(state)")
      switch state {
      case .ready:
        NSLog("[k8s-mtls] pf-bridge K8s TLS/TCP ready — sending WS handshake")
        ws?.sendHandshake()
      case .failed(let err):
        self.emitUpstreamError("UpstreamConnect",
          "\(err.localizedDescription) (code \(err.errorCode))")
        self.close(reason: "ws-conn-failed")
      case .waiting(let err):
        // Permanent network failure (NWConnection won't retry on its own
        // since we treat unreachable upstream as a hard error).
        self.emitUpstreamError("UpstreamWaiting",
          "\(err.localizedDescription) (code \(err.errorCode))")
        self.close(reason: "ws-conn-waiting")
      case .cancelled:
        self.close(reason: "ws-conn-cancelled")
      default:
        break
      }
    }
    wsConn.start(queue: queue)
  }

  /// Brings the SPDY layer up on top of the now-open WS, opens the two
  /// portforward streams (error + data — in that order to match kubectl),
  /// and flushes any client bytes that arrived before SPDY was ready.
  private func startSpdy() {
    guard let session = session, let ws = ws else { return }
    let port = Int(session.upstream.remotePort)
    do {
      let conn = try SpdyConnection { [weak ws] frame in
        // Each SPDY frame goes out as one WS binary message. The K8s
        // tunneling_connection on the server side reads bytes off the WS
        // and feeds them into its own SPDY framer, so frame-per-message
        // is fine (it's just how kubectl does it too).
        ws?.sendBinary(frame)
      }
      conn.onGoaway = { [weak self] last, status in
        NSLog("[k8s-mtls] pf-bridge SPDY GOAWAY lastGood=%d status=%d", last, status)
        self?.emitUpstreamError("SpdyGoAway", "peer sent GOAWAY (status=\(status))")
        self?.close(reason: "spdy-goaway-\(status)")
      }
      conn.onProtocolError = { [weak self] msg in
        NSLog("[k8s-mtls] pf-bridge SPDY protocol error: %@", msg)
        self?.emitUpstreamError("SpdyProtocol", msg)
        self?.close(reason: "spdy-protocol-error")
      }

      // kubectl opens the error stream first, then the data stream, both
      // with the SAME requestID. We mirror that exactly so the kubelet's
      // pairing logic links them.
      let requestId = "0"
      let errStream = conn.openStream(headers: [
        ("streamType", "error"),
        ("port", String(port)),
        ("requestID", requestId),
      ])
      errStream.onData = { [weak self] data, _ in
        // The apiserver / kubelet writes plain-text reasons on the error
        // stream (e.g. "Error forwarding to backend: dial tcp 10.0.0.1:N:
        // connect: connection refused"). Surface them as PfErrors so the
        // user sees what actually went wrong.
        let msg = String(data: data, encoding: .utf8) ?? "error stream binary data (\(data.count) bytes)"
        NSLog("[k8s-mtls] pf-bridge SPDY error stream: %@", msg)
        self?.emitUpstreamError("RemoteStream", msg)
      }
      errStream.onClose = { [weak self] status in
        NSLog("[k8s-mtls] pf-bridge SPDY error stream closed (rstStatus=%@)",
              status.map(String.init) ?? "nil")
        // Error stream closing alone isn't a hard failure — the data
        // stream may still be servicing the connection. Don't tear down.
        _ = self
      }
      self.errorStream = errStream

      let dataStream = conn.openStream(headers: [
        ("streamType", "data"),
        ("port", String(port)),
        ("requestID", requestId),
      ])
      dataStream.onData = { [weak self] data, fin in
        guard let self = self else { return }
        let count = data.count
        NSLog("[k8s-mtls] pf-bridge SPDY data → local: %d bytes (fin=%@)",
              count, fin ? "yes" : "no")
        if !data.isEmpty {
          self.tcp.send(content: data, completion: .contentProcessed { [weak self] err in
            if let err = err {
              self?.close(reason: "local-tcp-send-failed: \(err.localizedDescription)")
            } else {
              self?.txToLocal += count
            }
          })
        }
        if fin {
          // Server's done writing on this stream — typical end of HTTP
          // response. We tear down because nothing more will arrive.
          self.close(reason: "data-stream-fin")
        }
      }
      dataStream.onClose = { [weak self] status in
        let label = status.map { "rst-\($0)" } ?? "close"
        NSLog("[k8s-mtls] pf-bridge SPDY data stream closed: %@", label)
        self?.close(reason: "data-stream-\(label)")
      }
      self.dataStream = dataStream

      self.spdy = conn
      self.spdyReady = true

      // Drain any bytes the local client sent before the streams existed.
      let buffered = pendingTCPData.reduce(0) { $0 + $1.count }
      NSLog("[k8s-mtls] pf-bridge SPDY ready — flushing %d buffered byte(s) onto data stream",
            buffered)
      for chunk in pendingTCPData { dataStream.write(chunk) }
      pendingTCPData.removeAll()

      session.module?.sendEvent("onK8sPfStatus", [
        "id": session.id,
        "kind": "spdy-ready",
        "bridges": -1,
      ])
    } catch {
      emitUpstreamError("SpdyInit", error.localizedDescription)
      close(reason: "spdy-init-failed")
    }
  }

  private func receiveTCPLoop() {
    tcp.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self = self, !self.closed else { return }
      if let data = data, !data.isEmpty {
        self.rxFromLocal += data.count
        NSLog("[k8s-mtls] pf-bridge local → SPDY: %d bytes (spdyReady=%@ total-rx=%d)",
              data.count, self.spdyReady ? "yes" : "no", self.rxFromLocal)
        if self.spdyReady, let stream = self.dataStream {
          stream.write(data)
        } else {
          self.pendingTCPData.append(data)
        }
      }
      if let error = error {
        self.close(reason: "local-tcp-recv-error: \(error.localizedDescription)")
        return
      }
      if isComplete {
        // Local FIN: tell the apiserver the client is done writing (so the
        // pod's read side can also see EOF if it cares), but keep the
        // stream open for the response. The bridge fully closes when the
        // server sends FIN/RST_STREAM back, or on TCP write failure.
        NSLog("[k8s-mtls] pf-bridge local TCP FIN (rx=%d tx=%d)",
              self.rxFromLocal, self.txToLocal)
        if let stream = self.dataStream {
          stream.write(Data(), fin: true)
        } else {
          // No SPDY yet — just tear down; nothing useful can come back.
          self.close(reason: "local-tcp-fin-pre-spdy (rx=\(self.rxFromLocal))")
        }
        return
      }
      self.receiveTCPLoop()
    }
  }

  private func emitUpstreamError(_ name: String, _ message: String) {
    guard let session = session else { return }
    session.module?.sendEvent("onK8sPfError", [
      "id": session.id,
      "name": name,
      "message": message,
    ])
  }

  func close(reason: String = "unspecified") {
    queue.async { [weak self] in
      guard let self = self, !self.closed else { return }
      self.closed = true
      NSLog("[k8s-mtls] pf-bridge CLOSE — reason=%@ (rx=%d tx=%d spdyReady=%@)",
            reason, self.rxFromLocal, self.txToLocal,
            self.spdyReady ? "yes" : "no")
      // Surface the close reason via a status event so the JS log shows it
      // even when no explicit error fired.
      if let s = self.session {
        s.module?.sendEvent("onK8sPfStatus", [
          "id": s.id,
          "kind": "bridge-close:\(reason)",
          "bridges": -1,
        ])
      }
      // RST the streams (best-effort — peer may have already RST'd us),
      // then send GOAWAY before closing the WS so the apiserver sees a
      // graceful shutdown rather than a TCP reset.
      self.dataStream?.reset()
      self.errorStream?.reset()
      self.spdy?.sendGoaway()
      self.ws?.close()
      self.tcp.cancel()
      self.session?.removeBridge(self)
    }
  }
}
