package expo.modules.k8smtls

import android.os.Bundle
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class K8sPortForwardOptions : Record {
  @Field var serverUrl: String = ""
  @Field var namespace: String = ""
  @Field var podName: String = ""
  @Field var remotePort: Int = 0
  // 0 → let the OS pick the local port; the assigned value comes back via
  // the `onK8sPfListening` event.
  @Field var localPort: Int = 0
  @Field var headers: Map<String, String> = emptyMap()
  @Field var pkcs12Base64: String? = null
  @Field var pkcs12Password: String? = null
  @Field var caBundlesDerBase64: List<String> = emptyList()
  @Field var insecureSkipTLSVerify: Boolean = false
  @Field var tlsServerName: String? = null
}

/**
 * One port-forward session. Listens on 127.0.0.1:localPort and bridges every
 * accepted client TCP connection through a fresh portforward.k8s.io
 * WebSocket. One WS per client matches our iOS implementation — kubectl
 * multiplexes onto a single SPDY stream pair, but that requires inventing
 * local stream ids which adds complexity for no real benefit on mobile.
 */
class PortForwardSession(
  val id: String,
  private val module: ExpoK8sMtlsModule,
  private val server: ServerSocket,
  private val client: OkHttpClient,
  private val upstreamUrl: String,
  private val headers: Map<String, String>,
) {
  private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
  private val bridges = ConcurrentHashMap<String, PortForwardBridge>()
  private val stopped = AtomicBoolean(false)

  fun start() {
    module.emit("onK8sPfListening", pfBundleOf(
      "id" to id,
      "localPort" to server.localPort,
    ))
    scope.launch {
      try {
        while (isActive && !server.isClosed) {
          val sock = try { server.accept() } catch (_: IOException) { break }
          val bridgeId = UUID.randomUUID().toString()
          val bridge = PortForwardBridge(bridgeId, this@PortForwardSession, sock)
          bridges[bridgeId] = bridge
          module.emit("onK8sPfStatus", pfBundleOf(
            "id" to id,
            "kind" to "connection-opened",
            "bridges" to bridges.size,
          ))
          bridge.start(client, upstreamUrl, headers)
        }
      } catch (t: Throwable) {
        emitError("ListenerLoop", t.message ?: t.toString())
      }
    }
  }

  fun emitError(name: String, message: String) {
    module.emit("onK8sPfError", pfBundleOf(
      "id" to id, "name" to name, "message" to message,
    ))
  }

  fun stop(reason: String) {
    if (!stopped.compareAndSet(false, true)) return
    try { server.close() } catch (_: IOException) {}
    bridges.values.forEach { it.close() }
    bridges.clear()
    scope.cancel()
    module.emit("onK8sPfClosed", pfBundleOf("id" to id, "reason" to reason))
  }

  fun removeBridge(bridgeId: String) {
    bridges.remove(bridgeId)
    module.emit("onK8sPfStatus", pfBundleOf(
      "id" to id,
      "kind" to "connection-closed",
      "bridges" to bridges.size,
    ))
  }
}

/**
 * One TCP ↔ K8s-portforward-WS pair. portforward.k8s.io binary framing:
 *   first byte = stream index (0 = data, 1 = error)
 *   remaining bytes = payload
 * Initial two frames after the WS opens are 3-byte per-stream init payloads
 * (the port number, which we already know) — we consume + discard them.
 */
class PortForwardBridge(
  val id: String,
  private val session: PortForwardSession,
  private val sock: Socket,
) {
  private val closed = AtomicBoolean(false)
  private var ws: WebSocket? = null
  private val initFramesReceived = AtomicInteger(0)
  private val readerScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

  fun start(client: OkHttpClient, url: String, headers: Map<String, String>) {
    val rb = Request.Builder().url(url)
    headers.forEach { (k, v) -> rb.header(k, v) }
    rb.header("Sec-WebSocket-Protocol", "portforward.k8s.io")

    val listener = object : WebSocketListener() {
      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (closed.get()) return
        // First two frames after open are per-stream init payloads. Skip them.
        if (initFramesReceived.get() < 2) {
          initFramesReceived.incrementAndGet()
          return
        }
        if (bytes.size == 0) return
        val streamByte = bytes.getByte(0).toInt() and 0xFF
        val payload = bytes.substring(1)
        when (streamByte) {
          0 -> {
            try {
              val out = sock.getOutputStream()
              out.write(payload.toByteArray())
              out.flush()
            } catch (_: Throwable) {
              close()
            }
          }
          1 -> {
            // K8s error stream — surface the reason and tear the bridge down.
            session.emitError("RemoteStream", payload.utf8())
            close()
          }
        }
      }
      override fun onMessage(webSocket: WebSocket, text: String) {
        // portforward.k8s.io is binary-only; ignore unexpected text.
      }
      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, reason)
      }
      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        close()
      }
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        val msg = response?.let { "Upstream HTTP ${it.code}: ${it.message}" }
          ?: (t.message ?: t.toString())
        session.emitError("Upstream", msg)
        close()
      }
    }
    ws = client.newWebSocket(rb.build(), listener)

    // Reader loop: copy bytes from the local socket into the WS, prefixing
    // each chunk with the data stream byte (0).
    readerScope.launch {
      try {
        val input = sock.getInputStream()
        val buf = ByteArray(64 * 1024)
        while (isActive && !closed.get()) {
          val n = input.read(buf)
          if (n <= 0) break
          val framed = ByteArray(n + 1)
          framed[0] = 0
          System.arraycopy(buf, 0, framed, 1, n)
          ws?.send(framed.toByteString(0, framed.size))
        }
      } catch (_: IOException) {
        // socket closed during read — fall through to cleanup.
      } finally {
        close()
      }
    }
  }

  fun close() {
    if (!closed.compareAndSet(false, true)) return
    try { ws?.close(1000, "bridge-closed") } catch (_: Throwable) {}
    try { sock.close() } catch (_: Throwable) {}
    readerScope.cancel()
    session.removeBridge(id)
  }
}

// File-local bundle builder — avoids reaching into ExpoK8sMtlsModule.kt's
// file-private equivalent. Only handles the primitive types we actually pass.
internal fun pfBundleOf(vararg pairs: Pair<String, Any?>): Bundle =
  Bundle().apply {
    for ((k, v) in pairs) when (v) {
      null -> putString(k, null)
      is Boolean -> putBoolean(k, v)
      is Int -> putInt(k, v)
      is Long -> putLong(k, v)
      is Double -> putDouble(k, v)
      is String -> putString(k, v)
      else -> putString(k, v.toString())
    }
  }

// Local loopback InetAddress; pulled out so callers don't have to depend on
// java.net directly. We bind ServerSockets to this exclusively — port
// forwards must never accept off-device traffic.
internal fun pfLoopback(): InetAddress = InetAddress.getLoopbackAddress()
