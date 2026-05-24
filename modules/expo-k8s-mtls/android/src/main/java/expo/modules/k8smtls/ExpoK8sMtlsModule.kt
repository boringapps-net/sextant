package expo.modules.k8smtls

import android.os.Bundle
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import java.io.ByteArrayInputStream
import java.net.ServerSocket
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

class K8sRequestOptions : Record {
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var body: String? = null

  @Field var pkcs12Base64: String? = null
  @Field var pkcs12Password: String? = null

  @Field var caBundlesDerBase64: List<String> = emptyList()

  @Field var insecureSkipTLSVerify: Boolean = false

  @Field var tlsServerName: String? = null

  @Field var timeoutSeconds: Double = 30.0
}

class K8sResponse : Record {
  @Field var status: Int = 0
  @Field var headers: Map<String, String> = emptyMap()
  @Field var body: String = ""
}

class K8sWebSocketOptions : Record {
  @Field var url: String = ""
  @Field var headers: Map<String, String> = emptyMap()
  @Field var protocols: List<String> = emptyList()
  @Field var pkcs12Base64: String? = null
  @Field var pkcs12Password: String? = null
  @Field var caBundlesDerBase64: List<String> = emptyList()
  @Field var insecureSkipTLSVerify: Boolean = false
  @Field var tlsServerName: String? = null
}

class K8sMtlsException(message: String, cause: Throwable? = null) :
  CodedException("K8sMtlsError", message, cause)

class ExpoK8sMtlsModule : Module() {
  // Active streaming calls keyed by stream id so JS can cancel.
  private val streams = ConcurrentHashMap<String, Call>()
  // Active WebSocket sessions.
  private val sockets = ConcurrentHashMap<String, WebSocket>()
  // Active port-forward sessions — each owns a ServerSocket + N TCP↔WS bridges.
  private val portForwards = ConcurrentHashMap<String, PortForwardSession>()
  private val streamJob = SupervisorJob()
  private val streamScope = CoroutineScope(Dispatchers.IO + streamJob)

  // Allow PortForwardSession to emit events without exposing `sendEvent` (which
  // is protected on the Module base class). Kept internal so it stays
  // module-private.
  internal fun emit(event: String, payload: Bundle) {
    sendEvent(event, payload)
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoK8sMtls")

    Events(
      "onK8sChunk", "onK8sDone", "onK8sError",
      "onK8sWsOpen", "onK8sWsMessage", "onK8sWsClose", "onK8sWsError",
      "onK8sPfListening", "onK8sPfStatus", "onK8sPfError", "onK8sPfClosed",
    )

    AsyncFunction("request") { options: K8sRequestOptions ->
      doRequest(options)
    }

    Function("startStream") { options: K8sRequestOptions ->
      val streamId = UUID.randomUUID().toString()
      val client = try {
        buildClient(options, streaming = true)
      } catch (t: Throwable) {
        sendEvent("onK8sError", bundleOf(
          "streamId" to streamId,
          "name" to "ClientError",
          "message" to (t.message ?: t.toString()),
        ))
        return@Function streamId
      }
      val req = buildRequest(options)
      val call = client.newCall(req)
      streams[streamId] = call

      streamScope.launch {
        try {
          call.execute().use { resp ->
            if (!resp.isSuccessful) {
              sendEvent("onK8sError", bundleOf(
                "streamId" to streamId,
                "name" to "HTTPError",
                "status" to resp.code,
                "message" to "HTTP ${resp.code}",
              ))
              return@use
            }
            val body = resp.body ?: run {
              sendEvent("onK8sDone", bundleOf("streamId" to streamId, "cancelled" to false))
              return@use
            }
            val source = body.source()
            val buf = okio.Buffer()
            while (isActive && !source.exhausted()) {
              val read = source.read(buf, 8 * 1024)
              if (read == -1L) break
              val text = buf.readUtf8()
              if (text.isNotEmpty()) {
                sendEvent("onK8sChunk", bundleOf("streamId" to streamId, "data" to text))
              }
            }
            sendEvent("onK8sDone", bundleOf(
              "streamId" to streamId,
              "cancelled" to call.isCanceled(),
            ))
          }
        } catch (t: Throwable) {
          if (call.isCanceled()) {
            sendEvent("onK8sDone", bundleOf("streamId" to streamId, "cancelled" to true))
          } else {
            sendEvent("onK8sError", bundleOf(
              "streamId" to streamId,
              "name" to (t::class.simpleName ?: "Error"),
              "message" to (t.message ?: t.toString()),
            ))
          }
        } finally {
          streams.remove(streamId)
        }
      }
      streamId
    }

    Function("cancelStream") { streamId: String ->
      streams.remove(streamId)?.cancel()
    }

    Function("startWebSocket") { options: K8sWebSocketOptions ->
      val wsId = UUID.randomUUID().toString()
      val client = try {
        buildClient(toRequestOptions(options), streaming = true)
      } catch (t: Throwable) {
        sendEvent("onK8sWsError", bundleOf(
          "wsId" to wsId,
          "name" to "ClientError",
          "message" to (t.message ?: t.toString()),
        ))
        return@Function wsId
      }
      val rb = Request.Builder().url(options.url)
      options.headers.forEach { (k, v) -> rb.header(k, v) }
      if (options.protocols.isNotEmpty()) {
        rb.header("Sec-WebSocket-Protocol", options.protocols.joinToString(", "))
      }
      val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          sendEvent("onK8sWsOpen", bundleOf(
            "wsId" to wsId,
            "protocol" to (response.header("Sec-WebSocket-Protocol") ?: ""),
          ))
        }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
          sendEvent("onK8sWsMessage", bundleOf(
            "wsId" to wsId,
            "kind" to "binary",
            "data" to bytes.base64(),
          ))
        }
        override fun onMessage(webSocket: WebSocket, text: String) {
          sendEvent("onK8sWsMessage", bundleOf(
            "wsId" to wsId, "kind" to "text", "data" to text,
          ))
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
          webSocket.close(code, reason)
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
          sockets.remove(wsId)
          sendEvent("onK8sWsClose", bundleOf(
            "wsId" to wsId, "code" to code, "reason" to reason,
          ))
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          sockets.remove(wsId)
          val status = response?.code ?: 0
          val hint = httpStatusHint(status)
          // K8s puts the actual upgrade-failure reason in the body — read it
          // so the user sees "feature gate disabled" / "subprotocol mismatch"
          // rather than a bare HTTP code.
          val body = try { response?.body?.string().orEmpty() } catch (_: Throwable) { "" }
          val msg = if (status > 0) {
            buildString {
              append("Handshake failed: HTTP ").append(status)
              if (hint.isNotEmpty()) append(" — ").append(hint)
              if (body.isNotEmpty()) append("\n\nResponse body:\n").append(body)
            }
          } else {
            t.message ?: t.toString()
          }
          sendEvent("onK8sWsError", bundleOf(
            "wsId" to wsId,
            "name" to (t::class.simpleName ?: "Error"),
            "message" to msg,
            "status" to status,
          ))
        }
      }
      val ws = client.newWebSocket(rb.build(), listener)
      sockets[wsId] = ws
      wsId
    }

    AsyncFunction("sendWebSocketBinary") { wsId: String, base64: String ->
      val ws = sockets[wsId] ?: throw K8sMtlsException("Unknown wsId: $wsId")
      val bs = base64.decodeBase64() ?: throw K8sMtlsException("Bad base64 payload")
      ws.send(bs)
    }

    AsyncFunction("sendWebSocketText") { wsId: String, text: String ->
      val ws = sockets[wsId] ?: throw K8sMtlsException("Unknown wsId: $wsId")
      ws.send(text)
    }

    Function("closeWebSocket") { wsId: String ->
      sockets.remove(wsId)?.close(1000, "client-closed")
    }

    // ── Port forward ────────────────────────────────────────────────────
    // Bind a local ServerSocket and bridge every accepted connection through
    // a fresh portforward.k8s.io WebSocket. Returns the session id
    // synchronously; the assigned local port (if 0 was requested) arrives via
    // the `onK8sPfListening` event.
    Function("startPortForward") { options: K8sPortForwardOptions ->
      val id = UUID.randomUUID().toString()
      try {
        openPortForward(id, options)
      } catch (t: Throwable) {
        sendEvent("onK8sPfError", bundleOf(
          "id" to id,
          "name" to (t::class.simpleName ?: "Error"),
          "message" to (t.message ?: t.toString()),
        ))
        sendEvent("onK8sPfClosed", bundleOf("id" to id, "reason" to "init-failed"))
      }
      id
    }

    Function("stopPortForward") { id: String ->
      portForwards.remove(id)?.stop("user-stopped")
    }

    OnDestroy {
      streams.values.forEach { it.cancel() }
      streams.clear()
      sockets.values.forEach { it.close(1000, "destroy") }
      sockets.clear()
      portForwards.values.forEach { it.stop("destroy") }
      portForwards.clear()
      streamJob.cancel()
    }
  }

  // MARK: - Port forward bring-up
  private fun openPortForward(id: String, options: K8sPortForwardOptions) {
    // Reuse the existing client builder via the request-options shape — only
    // TLS fields are read, the same way startWebSocket does it.
    val ro = K8sRequestOptions().apply {
      url = options.serverUrl
      pkcs12Base64 = options.pkcs12Base64
      pkcs12Password = options.pkcs12Password
      caBundlesDerBase64 = options.caBundlesDerBase64
      insecureSkipTLSVerify = options.insecureSkipTLSVerify
      tlsServerName = options.tlsServerName
    }
    val httpClient = buildClient(ro, streaming = true)

    // Compose the upstream wss:// URL — same path shape kubectl uses for
    // websocket port-forward (the API server multiplexes streams over it).
    val base = options.serverUrl.trimEnd('/')
    val wssBase = base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
    val upstreamUrl =
      "$wssBase/api/v1/namespaces/${options.namespace}/pods/${options.podName}/portforward?ports=${options.remotePort}"

    // Bind a 127.0.0.1 listener. options.localPort==0 → OS picks an ephemeral
    // port (read back from ServerSocket.localPort once bound).
    val server = ServerSocket(options.localPort, 50, pfLoopback())

    val session = PortForwardSession(
      id = id,
      module = this,
      server = server,
      client = httpClient,
      upstreamUrl = upstreamUrl,
      headers = options.headers,
    )
    portForwards[id] = session
    session.start()
  }

  // Reuse TLS plumbing by mapping WS options to the request-options shape used
  // by buildClient. method/headers/body fields are irrelevant for the client
  // builder — only TLS settings are read.
  private fun toRequestOptions(ws: K8sWebSocketOptions): K8sRequestOptions {
    val o = K8sRequestOptions()
    o.url = ws.url
    o.pkcs12Base64 = ws.pkcs12Base64
    o.pkcs12Password = ws.pkcs12Password
    o.caBundlesDerBase64 = ws.caBundlesDerBase64
    o.insecureSkipTLSVerify = ws.insecureSkipTLSVerify
    o.tlsServerName = ws.tlsServerName
    return o
  }

  private fun doRequest(options: K8sRequestOptions): K8sResponse {
    val client = buildClient(options, streaming = false)
    return client.newCall(buildRequest(options)).execute().use { resp ->
      val out = K8sResponse()
      out.status = resp.code
      out.headers = resp.headers.toMultimap()
        .mapValues { it.value.joinToString(", ") }
      out.body = resp.body?.string() ?: ""
      out
    }
  }

  private fun buildRequest(options: K8sRequestOptions): Request {
    val rb = Request.Builder().url(options.url)
    val mediaType = options.headers["Content-Type"]?.toMediaTypeOrNull()
    val body = options.body?.toRequestBody(mediaType)
    when (options.method.uppercase()) {
      "GET" -> rb.get()
      "DELETE" -> if (body != null) rb.delete(body) else rb.delete()
      "POST" -> rb.post(body ?: "".toRequestBody(null))
      "PUT" -> rb.put(body ?: "".toRequestBody(null))
      "PATCH" -> rb.patch(body ?: "".toRequestBody(null))
      "HEAD" -> rb.head()
      else -> rb.method(options.method.uppercase(), body)
    }
    options.headers.forEach { (k, v) -> rb.header(k, v) }
    return rb.build()
  }

  private fun buildClient(options: K8sRequestOptions, streaming: Boolean): OkHttpClient {
    val timeout = options.timeoutSeconds.toLong().coerceAtLeast(1)
    val b = OkHttpClient.Builder()
      .connectTimeout(timeout, TimeUnit.SECONDS)
      // For streams there is no overall read deadline; in-between-chunk timeout is generous.
      .readTimeout(if (streaming) 0 else timeout, TimeUnit.SECONDS)
      .writeTimeout(timeout, TimeUnit.SECONDS)
      // Disable response buffering for true chunk-by-chunk delivery.
      .retryOnConnectionFailure(true)

    configureTls(b, options)
    return b.build()
  }

  private fun configureTls(builder: OkHttpClient.Builder, options: K8sRequestOptions) {
    val hasClientCert = !options.pkcs12Base64.isNullOrEmpty()
    val hasCustomCa = options.caBundlesDerBase64.isNotEmpty()

    if (!hasClientCert && !hasCustomCa && !options.insecureSkipTLSVerify) return

    val keyManagers = if (hasClientCert) {
      val p12Bytes = Base64.decode(options.pkcs12Base64, Base64.DEFAULT)
      val password = (options.pkcs12Password ?: "").toCharArray()
      val keyStore = KeyStore.getInstance("PKCS12").apply {
        load(ByteArrayInputStream(p12Bytes), password)
      }
      val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
        init(keyStore, password)
      }
      kmf.keyManagers
    } else null

    val trustManager: X509TrustManager = if (options.insecureSkipTLSVerify) {
      InsecureTrustManager()
    } else if (hasCustomCa) {
      val factory = CertificateFactory.getInstance("X.509")
      val trustStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null) }
      options.caBundlesDerBase64.forEachIndexed { i, b64 ->
        val der = Base64.decode(b64, Base64.DEFAULT)
        val cert = factory.generateCertificate(ByteArrayInputStream(der)) as X509Certificate
        trustStore.setCertificateEntry("ca-$i", cert)
      }
      val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
        init(trustStore)
      }
      tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
    } else {
      val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
        init(null as KeyStore?)
      }
      tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
    }

    val sslCtx = SSLContext.getInstance("TLS")
    sslCtx.init(keyManagers, arrayOf<TrustManager>(trustManager), SecureRandom())
    builder.sslSocketFactory(sslCtx.socketFactory, trustManager)

    if (options.insecureSkipTLSVerify) {
      builder.hostnameVerifier { _, _ -> true }
    }
  }
}

private fun httpStatusHint(status: Int): String = when (status) {
  401 -> "Unauthorized. Your token is missing or invalid."
  403 -> "Forbidden. Your token lacks RBAC for this action (for exec, you need verbs: create on resource pods/exec)."
  404 -> "Not found. The pod or container may have terminated, or the resource path is wrong."
  400 -> "Bad request. Check the command and container name."
  in 500..599 -> "Server error from the cluster."
  else -> ""
}

private class InsecureTrustManager : X509TrustManager {
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

private fun bundleOf(vararg pairs: Pair<String, Any?>): Bundle =
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
