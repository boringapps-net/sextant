import ExpoModulesCore
import Foundation
import Network
import Security
import UIKit

// A request payload from JS. Fields mirror those defined in TS index.ts.
struct K8sRequestOptions: Record {
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: [String: String] = [:]
  @Field var body: String?

  // Base64-encoded PKCS12 bundle containing the client cert + private key.
  @Field var pkcs12Base64: String?
  @Field var pkcs12Password: String?

  // Base64-encoded DER certificates to add as trust anchors for server validation.
  @Field var caBundlesDerBase64: [String] = []

  // Skip ALL server-cert validation. Dangerous; only for explicit user opt-in.
  @Field var insecureSkipTLSVerify: Bool = false

  // Override the hostname used for cert validation (kubeconfig `tls-server-name`).
  @Field var tlsServerName: String?

  // Total request timeout in seconds.
  @Field var timeoutSeconds: Double = 30
}

struct K8sResponse: Record {
  @Field var status: Int = 0
  @Field var headers: [String: String] = [:]
  @Field var body: String = ""
}

struct K8sWebSocketOptions: Record {
  @Field var url: String = ""
  @Field var headers: [String: String] = [:]
  @Field var protocols: [String] = []
  @Field var pkcs12Base64: String?
  @Field var pkcs12Password: String?
  @Field var caBundlesDerBase64: [String] = []
  @Field var insecureSkipTLSVerify: Bool = false
  @Field var tlsServerName: String?
}

struct K8sPortForwardOptions: Record {
  // Cluster API server URL. Same scheme as the bearer/mtls config used for
  // other native calls — we re-parse it here so the bridge can rebuild the
  // upstream NWConnection per-TCP-connection.
  @Field var serverUrl: String = ""
  @Field var namespace: String = ""
  @Field var podName: String = ""
  // The pod-side port to forward to.
  @Field var remotePort: Int = 0
  // The desired local port. 0 = let the OS assign one.
  @Field var localPort: Int = 0
  // Authorization / extra headers (e.g. "Authorization: Bearer …").
  @Field var headers: [String: String] = [:]
  @Field var pkcs12Base64: String?
  @Field var pkcs12Password: String?
  @Field var caBundlesDerBase64: [String] = []
  @Field var insecureSkipTLSVerify: Bool = false
  @Field var tlsServerName: String?
}

public final class ExpoK8sMtlsModule: Module {
  // Active streaming sessions keyed by stream id so JS can cancel.
  private var streams: [String: URLSession] = [:]
  private let streamsLock = NSLock()

  // Active WebSocket connections. We drive RFC 6455 ourselves over raw
  // NWConnection (TLS only) because Apple's NWProtocolWebSocket validator is
  // opaque and rejects responses we'd accept (and strips reserved headers).
  // ManualWebSocket owns the connection and exposes send/close methods.
  internal var sockets: [String: ManualWebSocket] = [:]
  internal let socketsLock = NSLock()

  // Active port-forward sessions keyed by id. Each owns a NWListener and a
  // collection of TCP↔K8sWS bridges (see PortForwarder.swift).
  internal var portForwards: [String: PortForwardSession] = [:]
  internal let portForwardsLock = NSLock()

  // We hold a single UIApplication background task while at least one port
  // forward is active. iOS gives us a finite window (typically 25-180s
  // depending on system load) after the user switches away — enough for a
  // few Safari round-trips against a live forward, which is the whole
  // point. If the user keeps the forward open longer than the budget, iOS
  // suspends us, the listener stops accepting, and the forward effectively
  // ends until they return. That's the documented expectation and matches
  // kubectl's "closes when terminal closes" semantics.
  private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
  private let backgroundTaskLock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("ExpoK8sMtls")

    // Events emitted from streaming requests + WebSocket sessions + port
    // forwards.
    Events(
      "onK8sChunk", "onK8sDone", "onK8sError",
      "onK8sWsOpen", "onK8sWsMessage", "onK8sWsClose", "onK8sWsError",
      "onK8sPfListening", "onK8sPfStatus", "onK8sPfError", "onK8sPfClosed"
    )

    AsyncFunction("request") { (options: K8sRequestOptions, promise: Promise) in
      let prepared: PreparedRequest
      do {
        prepared = try prepareRequest(options: options)
      } catch let err as Exception {
        promise.reject(err); return
      } catch {
        promise.reject(Exception(name: "Unknown", description: error.localizedDescription)); return
      }

      let delegate = prepared.delegate
      let cfg = URLSessionConfiguration.ephemeral
      cfg.timeoutIntervalForRequest = options.timeoutSeconds
      cfg.timeoutIntervalForResource = options.timeoutSeconds
      let session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)

      let task = session.dataTask(with: prepared.req) { data, response, error in
        session.finishTasksAndInvalidate()
        if let tlsDetail = delegate.tlsErrorDetail {
          promise.reject(Exception(name: "TLSError", description: tlsDetail))
          return
        }
        if let error = error {
          let ns = error as NSError
          promise.reject(Exception(
            name: "NetworkError",
            description: "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
          ))
          return
        }
        guard let http = response as? HTTPURLResponse else {
          promise.reject(Exception(name: "NetworkError", description: "Non-HTTP response"))
          return
        }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
          if let ks = k as? String, let vs = v as? String { headers[ks] = vs }
        }
        let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        var res = K8sResponse()
        res.status = http.statusCode
        res.headers = headers
        res.body = bodyStr
        promise.resolve(res)
      }
      task.resume()
    }

    // Open a streaming request. Returns a streamId synchronously. Subsequent
    // chunks arrive via `onK8sChunk` events keyed by that id. Completion or
    // error emits `onK8sDone` / `onK8sError`.
    Function("startStream") { (options: K8sRequestOptions) -> String in
      let streamId = UUID().uuidString

      let prepared: PreparedRequest
      do {
        prepared = try prepareRequest(options: options)
      } catch let err as Exception {
        // Synchronously fail by emitting the error before returning. We still
        // return a valid id so the JS subscriber can hear it.
        DispatchQueue.main.async { [weak self] in
          self?.sendEvent("onK8sError", [
            "streamId": streamId,
            "message": err.description,
            "name": err.name,
          ])
        }
        return streamId
      } catch {
        DispatchQueue.main.async { [weak self] in
          self?.sendEvent("onK8sError", [
            "streamId": streamId,
            "message": error.localizedDescription,
            "name": "Unknown",
          ])
        }
        return streamId
      }

      let delegate = prepared.delegate
      delegate.onChunk = { [weak self] data in
        guard let self = self, let s = String(data: data, encoding: .utf8) else { return }
        self.sendEvent("onK8sChunk", ["streamId": streamId, "data": s])
      }
      delegate.onResponse = { [weak self] http in
        // Once we know the HTTP status, surface it as a "head" event so JS can
        // detect non-2xx early and present an error UI instead of waiting for done.
        if let status = http?.statusCode, status >= 400 {
          self?.sendEvent("onK8sError", [
            "streamId": streamId,
            "status": status,
            "message": "HTTP \(status)",
            "name": "HTTPError",
          ])
        }
      }
      delegate.onComplete = { [weak self] error in
        guard let self = self else { return }
        // Tear down stream record.
        self.streamsLock.lock()
        let session = self.streams.removeValue(forKey: streamId)
        self.streamsLock.unlock()
        session?.finishTasksAndInvalidate()

        if let tlsDetail = delegate.tlsErrorDetail {
          self.sendEvent("onK8sError", [
            "streamId": streamId, "name": "TLSError", "message": tlsDetail,
          ])
          return
        }
        if let err = error {
          let ns = err as NSError
          // URLError -999 == cancelled; surface as done rather than error.
          if ns.code == NSURLErrorCancelled {
            self.sendEvent("onK8sDone", ["streamId": streamId, "cancelled": true])
            return
          }
          self.sendEvent("onK8sError", [
            "streamId": streamId,
            "name": "NetworkError",
            "message": "\(ns.domain) \(ns.code): \(ns.localizedDescription)",
          ])
          return
        }
        self.sendEvent("onK8sDone", ["streamId": streamId, "cancelled": false])
      }

      // Streaming sessions have no overall timeout. Per-chunk idle timeout is
      // intentionally long — pods can be quiet for ages.
      let cfg = URLSessionConfiguration.ephemeral
      cfg.timeoutIntervalForRequest = 600   // 10 min between chunks
      cfg.timeoutIntervalForResource = 0    // no overall cap
      let session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)

      streamsLock.lock()
      streams[streamId] = session
      streamsLock.unlock()

      let task = session.dataTask(with: prepared.req)
      task.resume()
      return streamId
    }

    Function("cancelStream") { (streamId: String) in
      self.streamsLock.lock()
      let session = self.streams.removeValue(forKey: streamId)
      self.streamsLock.unlock()
      session?.invalidateAndCancel()
    }

    // Open a WebSocket via Network.framework. URLSession's WS strips Authorization
    // from the handshake (reserved-header list); NWConnection + NWProtocolWebSocket
    // accepts arbitrary headers including Authorization, which is what K8s needs.
    Function("startWebSocket") { (options: K8sWebSocketOptions) -> String in
      let wsId = UUID().uuidString
      self.openNWWebSocket(wsId: wsId, options: options)
      return wsId
    }

    AsyncFunction("sendWebSocketBinary") { (wsId: String, base64: String, promise: Promise) in
      self.socketsLock.lock()
      let ws = self.sockets[wsId]
      self.socketsLock.unlock()
      guard let ws = ws, let data = Data(base64Encoded: base64) else {
        promise.reject(Exception(name: "BadWsHandle", description: "Unknown wsId or invalid base64"))
        return
      }
      ws.sendBinary(data)
      promise.resolve(true)
    }

    AsyncFunction("sendWebSocketText") { (wsId: String, text: String, promise: Promise) in
      self.socketsLock.lock()
      let ws = self.sockets[wsId]
      self.socketsLock.unlock()
      guard let ws = ws else {
        promise.reject(Exception(name: "BadWsHandle", description: "Unknown wsId"))
        return
      }
      ws.sendText(text)
      promise.resolve(true)
    }

    Function("closeWebSocket") { (wsId: String) in
      self.socketsLock.lock()
      let ws = self.sockets.removeValue(forKey: wsId)
      self.socketsLock.unlock()
      ws?.close()
    }

    // ── Port forward ────────────────────────────────────────────────────
    // Spin up a local 127.0.0.1 TCP listener that bridges every incoming
    // connection through a fresh K8s portforward.k8s.io WebSocket. Returns a
    // synchronous id; the bound local port arrives via `onK8sPfListening`.
    Function("startPortForward") { (options: K8sPortForwardOptions) -> String in
      let id = UUID().uuidString
      self.openPortForward(id: id, options: options)
      return id
    }

    Function("stopPortForward") { (id: String) in
      self.portForwardsLock.lock()
      let session = self.portForwards.removeValue(forKey: id)
      self.portForwardsLock.unlock()
      session?.stop(reason: "user-stopped")
      self.refreshBackgroundTask()
    }
  }

  // MARK: - Background task lifecycle
  // Called whenever the active-forward count changes. Begins a background
  // task when going from 0 → ≥1, ends it when going back to 0. iOS won't
  // start the countdown until the app actually moves to background, so
  // calling this in the foreground is a no-op apart from registering intent.
  internal func refreshBackgroundTask() {
    portForwardsLock.lock()
    let activeCount = portForwards.count
    portForwardsLock.unlock()

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.backgroundTaskLock.lock()
      defer { self.backgroundTaskLock.unlock() }

      if activeCount > 0 && self.backgroundTaskId == .invalid {
        let id = UIApplication.shared.beginBackgroundTask(withName: "k8s-portforward") { [weak self] in
          // Expiration handler — iOS is about to suspend us. End the task
          // gracefully; outstanding forwards will stop accepting on the next
          // listener event after suspension.
          NSLog("[k8s-mtls] background task expiring; ending and letting the OS suspend us")
          self?.endBackgroundTaskLocked()
        }
        self.backgroundTaskId = id
        NSLog("[k8s-mtls] began background task id=%lu for %d active port forward(s)",
              UInt(id.rawValue), activeCount)
      } else if activeCount == 0 && self.backgroundTaskId != .invalid {
        self.endBackgroundTaskLocked()
      }
    }
  }

  // Must be called with backgroundTaskLock held OR on a path where mutual
  // exclusion is guaranteed (the expiration handler runs after refresh has
  // released the lock).
  private func endBackgroundTaskLocked() {
    if backgroundTaskId != .invalid {
      let id = backgroundTaskId
      backgroundTaskId = .invalid
      UIApplication.shared.endBackgroundTask(id)
      NSLog("[k8s-mtls] ended background task id=%lu", UInt(id.rawValue))
    }
  }

  // MARK: - Port forward bring-up
  private func openPortForward(id: String, options: K8sPortForwardOptions) {
    // Parse the API server URL once so the bridge knows the host/port/scheme
    // and we don't have to re-validate on every TCP accept.
    guard let serverURL = URL(string: options.serverUrl),
          let host = serverURL.host else {
      sendEvent("onK8sPfError", [
        "id": id, "name": "InvalidURL",
        "message": "Bad cluster URL: \(options.serverUrl)",
      ])
      sendEvent("onK8sPfClosed", ["id": id, "reason": "invalid-url"])
      return
    }
    let isTLS = (serverURL.scheme?.lowercased() ?? "https") == "https"
    let port = UInt16(serverURL.port ?? (isTLS ? 443 : 80))
    let wsScheme = isTLS ? "wss" : "ws"
    // K8s SPDY-over-WS port-forward path. The remote port is *not* a query
    // parameter — kubectl never puts it there, and the apiserver expects the
    // port to come in via the SPDY stream headers (streamType + port +
    // requestID). PortForwardBridge.startSpdy() sends those when it opens
    // the data/error streams.
    let path = "/api/v1/namespaces/\(options.namespace)/pods/\(options.podName)/portforward"

    let upstream = PortForwardUpstream(
      scheme: wsScheme,
      host: host,
      port: port,
      path: path,
      headers: options.headers.map { ($0.key, $0.value) },
      pkcs12Base64: options.pkcs12Base64,
      pkcs12Password: options.pkcs12Password,
      caBundlesDerBase64: options.caBundlesDerBase64,
      insecureSkipTLSVerify: options.insecureSkipTLSVerify,
      tlsServerName: options.tlsServerName,
      remotePort: UInt16(options.remotePort)
    )

    // Build the local listener. localPort=0 → OS picks an ephemeral port and
    // reports it back via onK8sPfListening. We intentionally don't set
    // requiredLocalEndpoint — that's for outbound connections, and setting it
    // on a listener silently breaks accept on at least some iOS versions.
    // NWListener binds to all interfaces by default, which is fine: Safari
    // will reach us via 127.0.0.1 either way and nothing on-device gets
    // anything we wouldn't already share over loopback.
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    params.includePeerToPeer = false
    let listener: NWListener
    do {
      if options.localPort == 0 {
        listener = try NWListener(using: params)
      } else {
        listener = try NWListener(
          using: params,
          on: NWEndpoint.Port(integerLiteral: UInt16(options.localPort))
        )
      }
    } catch {
      sendEvent("onK8sPfError", [
        "id": id, "name": "ListenerCreate",
        "message": "Could not bind 127.0.0.1:\(options.localPort): \(error.localizedDescription)",
      ])
      sendEvent("onK8sPfClosed", ["id": id, "reason": "bind-failed"])
      return
    }

    let queue = DispatchQueue(label: "expo.k8s.pf.\(id)")
    let session = PortForwardSession(
      id: id, module: self, listener: listener, queue: queue, upstream: upstream
    )
    self.portForwardsLock.lock()
    self.portForwards[id] = session
    self.portForwardsLock.unlock()
    session.start()
    refreshBackgroundTask()
  }

  // MARK: - NWConnection-based WebSocket

  private func openNWWebSocket(wsId: String, options: K8sWebSocketOptions) {
    guard let url = URL(string: options.url),
          let host = url.host else {
      sendEvent("onK8sWsError", [
        "wsId": wsId, "name": "InvalidURL", "message": "Bad URL: \(options.url)",
      ])
      return
    }
    let isTLS = url.scheme?.lowercased() == "wss"
    let port = url.port ?? (isTLS ? 443 : 80)

    // Parse client identity / trust anchors (same logic as buildDelegate).
    var clientIdentity: SecIdentity?
    if let p12B64 = options.pkcs12Base64, let p12Data = Data(base64Encoded: p12B64) {
      let password = options.pkcs12Password ?? ""
      let importOptions: [String: Any] = [kSecImportExportPassphrase as String: password]
      var items: CFArray?
      let status = SecPKCS12Import(p12Data as CFData, importOptions as CFDictionary, &items)
      if status == errSecSuccess,
         let array = items as? [[String: Any]],
         let identityRef = array.first?[kSecImportItemIdentity as String] {
        clientIdentity = (identityRef as! SecIdentity)
      } else {
        sendEvent("onK8sWsError", [
          "wsId": wsId, "name": "PKCS12ImportFailed",
          "message": "SecPKCS12Import failed with OSStatus \(status)",
        ])
        return
      }
    }
    var trustAnchors: [SecCertificate] = []
    for derB64 in options.caBundlesDerBase64 {
      guard let der = Data(base64Encoded: derB64),
            let cert = SecCertificateCreateWithData(nil, der as CFData) else { continue }
      trustAnchors.append(cert)
    }

    // TLS-only parameters. We do NOT add NWProtocolWebSocket.Options here —
    // ManualWebSocket drives the WS handshake itself over the raw TCP/TLS
    // connection so we can see exactly what the server sends back.
    let parameters: NWParameters
    if isTLS {
      let tlsOpts = NWProtocolTLS.Options()
      let secOpts = tlsOpts.securityProtocolOptions

      if let serverName = options.tlsServerName, !serverName.isEmpty {
        sec_protocol_options_set_tls_server_name(secOpts, serverName)
      }

      let verifyQueue = DispatchQueue(label: "expo.k8s.ws.tls.verify.\(wsId)")
      let insecure = options.insecureSkipTLSVerify
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

    let conn = NWConnection(
      host: NWEndpoint.Host(host),
      port: NWEndpoint.Port(integerLiteral: UInt16(port)),
      using: parameters
    )
    let queue = DispatchQueue(label: "expo.k8s.ws.\(wsId)")

    // Host header — include port unless it's the default for the scheme.
    let hostHeader: String
    if (isTLS && port == 443) || (!isTLS && port == 80) {
      hostHeader = host
    } else {
      hostHeader = "\(host):\(port)"
    }
    let fullPath = url.path + (url.query.map { "?" + $0 } ?? "")
    let extraHeaders: [(String, String)] = options.headers.map { ($0.key, $0.value) }

    // JS-bound callbacks: each event fires the corresponding onK8sWs* native
    // event keyed by wsId. The port-forward bridge constructs a different set
    // of callbacks that consume the messages locally instead.
    let jsCallbacks = ManualWebSocket.Callbacks(
      onOpen: { [weak self] proto in
        self?.sendEvent("onK8sWsOpen", ["wsId": wsId, "protocol": proto])
      },
      onText: { [weak self] text in
        self?.sendEvent("onK8sWsMessage", ["wsId": wsId, "kind": "text", "data": text])
      },
      onBinary: { [weak self] data in
        self?.sendEvent("onK8sWsMessage", [
          "wsId": wsId, "kind": "binary", "data": data.base64EncodedString(),
        ])
      },
      onClose: { [weak self] code, reason in
        self?.sendEvent("onK8sWsClose", ["wsId": wsId, "code": code, "reason": reason])
      },
      onError: { [weak self] name, message, status in
        var payload: [String: Any] = ["wsId": wsId, "name": name, "message": message]
        if let status = status { payload["status"] = status }
        self?.sendEvent("onK8sWsError", payload)
      }
    )

    let ws = ManualWebSocket(
      wsId: wsId,
      hostHeader: hostHeader,
      path: fullPath,
      protocols: options.protocols,
      extraHeaders: extraHeaders,
      conn: conn,
      queue: queue,
      callbacks: jsCallbacks
    )

    conn.stateUpdateHandler = { [weak self, weak ws] state in
      guard let self = self else { return }
      NSLog("[k8s-mtls] ws %@ NWConnection state: %@", wsId, "\(state)")
      switch state {
      case .setup, .preparing:
        break
      case .ready:
        // TLS is up. Drive the WS handshake at the application layer.
        ws?.sendHandshake()
      case .waiting(let err):
        // Permanent failure — emit and cancel to break NWConnection's retry loop.
        self.socketsLock.lock()
        let still = self.sockets.removeValue(forKey: wsId)
        self.socketsLock.unlock()
        if still != nil {
          self.sendEvent("onK8sWsError", [
            "wsId": wsId,
            "name": "WaitingTerminal",
            "message": "Network framework is waiting (won't retry): \(err.localizedDescription) (code \(err.errorCode))",
          ])
        }
        conn.cancel()
      case .failed(let err):
        self.socketsLock.lock()
        let still = self.sockets.removeValue(forKey: wsId)
        self.socketsLock.unlock()
        if still == nil { return }
        self.sendEvent("onK8sWsError", [
          "wsId": wsId,
          "name": "NetworkError",
          "message": "\(err.localizedDescription) (code \(err.errorCode))",
        ])
      case .cancelled:
        self.socketsLock.lock()
        let still = self.sockets.removeValue(forKey: wsId)
        self.socketsLock.unlock()
        if still != nil {
          self.sendEvent("onK8sWsClose", [
            "wsId": wsId, "code": 1000, "reason": "cancelled",
          ])
        }
      @unknown default:
        break
      }
    }

    self.socketsLock.lock()
    self.sockets[wsId] = ws
    self.socketsLock.unlock()
    conn.start(queue: queue)
  }
}

// Hints surfaced alongside WS handshake HTTP statuses.
private func httpStatusHint(_ status: Int) -> String {
  switch status {
  case 401: return "Unauthorized. Your token is missing or invalid."
  case 403: return "Forbidden. Your token lacks RBAC for this action (for exec, you need verbs: create on resource pods/exec)."
  case 404: return "Not found. The pod or container may have terminated, or the resource path is wrong."
  case 400: return "Bad request. Check the command and container name."
  case 500..<600: return "Server error from the cluster."
  default: return ""
  }
}

// MARK: - Request preparation (shared by request + startStream)

private struct PreparedRequest {
  let req: URLRequest
  let delegate: K8sURLSessionDelegate
}

private func buildDelegate(
  pkcs12Base64: String?,
  pkcs12Password: String?,
  caBundlesDerBase64: [String],
  insecureSkipTLSVerify: Bool,
  tlsServerName: String?
) throws -> K8sURLSessionDelegate {
  var clientIdentity: SecIdentity?
  if let p12B64 = pkcs12Base64, let p12Data = Data(base64Encoded: p12B64) {
    let password = pkcs12Password ?? ""
    let importOptions: [String: Any] = [kSecImportExportPassphrase as String: password]
    var items: CFArray?
    let status = SecPKCS12Import(p12Data as CFData, importOptions as CFDictionary, &items)
    if status == errSecSuccess,
       let array = items as? [[String: Any]],
       let identityRef = array.first?[kSecImportItemIdentity as String] {
      clientIdentity = (identityRef as! SecIdentity)
    } else {
      throw Exception(
        name: "PKCS12ImportFailed",
        description: "SecPKCS12Import failed with OSStatus \(status). Check that pkcs12Password is correct."
      )
    }
  }

  var trustAnchors: [SecCertificate] = []
  var anchorParseErrors: [String] = []
  for (idx, derB64) in caBundlesDerBase64.enumerated() {
    guard let derData = Data(base64Encoded: derB64) else {
      anchorParseErrors.append("anchor[\(idx)]: base64 decode failed (\(derB64.count) chars)")
      continue
    }
    if let cert = SecCertificateCreateWithData(nil, derData as CFData) {
      trustAnchors.append(cert)
    } else {
      anchorParseErrors.append("anchor[\(idx)]: SecCertificateCreateWithData rejected \(derData.count) bytes (not valid DER X.509)")
    }
  }
  if !anchorParseErrors.isEmpty {
    throw Exception(
      name: "InvalidCABundle",
      description: "Could not parse one or more CA certificates:\n" + anchorParseErrors.joined(separator: "\n")
    )
  }

  return K8sURLSessionDelegate(
    clientIdentity: clientIdentity,
    trustAnchors: trustAnchors,
    insecureSkipTLSVerify: insecureSkipTLSVerify,
    tlsServerName: tlsServerName
  )
}

private func prepareRequest(options: K8sRequestOptions) throws -> PreparedRequest {
  guard let url = URL(string: options.url) else {
    throw Exception(name: "InvalidURL", description: "Bad URL: \(options.url)")
  }

  let delegate = try buildDelegate(
    pkcs12Base64: options.pkcs12Base64,
    pkcs12Password: options.pkcs12Password,
    caBundlesDerBase64: options.caBundlesDerBase64,
    insecureSkipTLSVerify: options.insecureSkipTLSVerify,
    tlsServerName: options.tlsServerName
  )

  var req = URLRequest(url: url)
  req.httpMethod = options.method.uppercased()
  req.timeoutInterval = options.timeoutSeconds
  for (k, v) in options.headers { req.setValue(v, forHTTPHeaderField: k) }
  if let body = options.body { req.httpBody = body.data(using: .utf8) }

  return PreparedRequest(req: req, delegate: delegate)
}

// MARK: - URLSession delegate

// Handles TLS challenges + (when set) streams data chunks to JS via closures.
final class K8sURLSessionDelegate: NSObject,
                                    URLSessionDelegate,
                                    URLSessionTaskDelegate,
                                    URLSessionDataDelegate,
                                    URLSessionWebSocketDelegate {
  let clientIdentity: SecIdentity?
  let trustAnchors: [SecCertificate]
  let insecure: Bool
  let tlsServerName: String?

  var tlsErrorDetail: String?

  // Streaming hooks. The non-streaming path leaves these nil.
  var onChunk: ((Data) -> Void)?
  var onResponse: ((HTTPURLResponse?) -> Void)?
  var onComplete: ((Error?) -> Void)?

  // WebSocket hooks.
  var onWsOpen: ((String?) -> Void)?
  var onWsClose: ((Int, String?) -> Void)?
  var onWsHandshakeError: ((Error) -> Void)?

  init(
    clientIdentity: SecIdentity?,
    trustAnchors: [SecCertificate],
    insecureSkipTLSVerify: Bool,
    tlsServerName: String?
  ) {
    self.clientIdentity = clientIdentity
    self.trustAnchors = trustAnchors
    self.insecure = insecureSkipTLSVerify
    self.tlsServerName = tlsServerName
  }

  // MARK: Auth

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let method = challenge.protectionSpace.authenticationMethod
    switch method {
    case NSURLAuthenticationMethodServerTrust:
      guard let trust = challenge.protectionSpace.serverTrust else {
        tlsErrorDetail = "ServerTrust challenge with no SecTrust object"
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
      if let name = tlsServerName, !name.isEmpty {
        let policy = SecPolicyCreateSSL(true, name as CFString)
        SecTrustSetPolicies(trust, policy)
      }
      if insecure {
        completionHandler(.useCredential, URLCredential(trust: trust))
        return
      }
      if !trustAnchors.isEmpty {
        SecTrustSetAnchorCertificates(trust, trustAnchors as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
      }
      var cfErr: CFError?
      if SecTrustEvaluateWithError(trust, &cfErr) {
        completionHandler(.useCredential, URLCredential(trust: trust))
        return
      }
      tlsErrorDetail = buildTlsFailureReport(
        trust: trust, cfErr: cfErr, host: challenge.protectionSpace.host
      )
      completionHandler(.cancelAuthenticationChallenge, nil)

    case NSURLAuthenticationMethodClientCertificate:
      guard let identity = clientIdentity else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
      let credential = URLCredential(identity: identity, certificates: nil, persistence: .forSession)
      completionHandler(.useCredential, credential)

    default:
      completionHandler(.performDefaultHandling, nil)
    }
  }

  // MARK: Data delegate (used only when streaming)

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    onResponse?(response as? HTTPURLResponse)
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    onChunk?(data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // Used by both the data-task streaming path and the WebSocket handshake.
    // WS open success is signalled separately via URLSessionWebSocketDelegate.
    if let onWsHandshakeError = onWsHandshakeError {
      if let err = error { onWsHandshakeError(err); return }
      // Successful WS completion (peer-initiated close) is handled in the
      // didCloseWith callback below — nothing to do here.
    }
    onComplete?(error)
  }

  // MARK: WebSocket delegate

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    onWsOpen?(`protocol`)
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) }
    onWsClose?(closeCode.rawValue, reasonStr)
  }

  // MARK: TLS diagnostics

  private func buildTlsFailureReport(trust: SecTrust, cfErr: CFError?, host: String) -> String {
    var lines: [String] = ["TLS trust evaluation failed."]
    if let err = cfErr {
      let nsErr = err as Error as NSError
      lines.append("Reason: \(nsErr.localizedDescription) (\(nsErr.domain) \(nsErr.code))")
    }
    let validatedHost = (tlsServerName?.isEmpty == false) ? tlsServerName! : host
    lines.append("Validated hostname: \(validatedHost)")
    let chain = serverChain(trust: trust)
    if chain.isEmpty {
      lines.append("Server presented no certificates.")
    } else {
      lines.append("Server chain (\(chain.count) cert\(chain.count == 1 ? "" : "s")):")
      for (i, cert) in chain.enumerated() {
        lines.append("  [\(i)] \(certSummary(cert))")
      }
    }
    lines.append("Configured anchors: \(trustAnchors.count)")
    for (i, cert) in trustAnchors.enumerated() {
      lines.append("  [\(i)] \(certSummary(cert))")
    }
    return lines.joined(separator: "\n")
  }

  private func serverChain(trust: SecTrust) -> [SecCertificate] {
    if #available(iOS 15.0, *), let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] {
      return chain
    }
    let count = SecTrustGetCertificateCount(trust)
    var out: [SecCertificate] = []
    for i in 0..<count {
      if let c = SecTrustGetCertificateAtIndex(trust, i) { out.append(c) }
    }
    return out
  }

  private func certSummary(_ cert: SecCertificate) -> String {
    let subject = (SecCertificateCopySubjectSummary(cert) as String?) ?? "(no subject)"
    var commonRef: CFString?
    if SecCertificateCopyCommonName(cert, &commonRef) == errSecSuccess,
       let cn = commonRef as String?, cn != subject {
      return "subject=\(subject) cn=\(cn)"
    }
    return "subject=\(subject)"
  }
}
