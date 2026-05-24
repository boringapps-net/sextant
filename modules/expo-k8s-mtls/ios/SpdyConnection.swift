import Foundation

// Lightweight SPDY/3 connection multiplexer. Owns a SpdyFramer, tracks
// open streams by id, auto-replies to PING, dispatches incoming frames to
// the right SpdyStream. Used inside PortForwardBridge — one connection per
// WS, with two streams per logical port forward (a data stream and an
// error stream, matching kubectl's portforward.k8s.io semantics).
//
// Threading: callers must drive `feed(_:)`, `openStream(_:fin:)`, etc.
// from a single serial queue. We don't lock — `PortForwardBridge` already
// confines everything to its own queue, so adding internal locking would
// just be deadlock-fuel.

// MARK: - SpdyStream

internal final class SpdyStream {
  let id: UInt32
  weak var connection: SpdyConnection?
  var requestHeaders: [(String, String)] = []
  var replyHeaders: [(String, String)] = []

  /// Fired when the peer's SYN_REPLY arrives. `replyHeaders` is also stashed
  /// on the stream so late observers don't miss it.
  var onReply: ([(String, String)]) -> Void = { _ in }

  /// Fired on every received DATA frame. `fin` is true on the final frame.
  var onData: (Data, Bool) -> Void = { _, _ in }

  /// Fired when the stream ends — either we received FIN+last DATA, or the
  /// peer sent RST_STREAM (in which case `status` carries the reason).
  var onClose: (_ rstStatus: UInt32?) -> Void = { _ in }

  fileprivate(set) var closed = false

  init(id: UInt32, connection: SpdyConnection) {
    self.id = id
    self.connection = connection
  }

  /// Send a DATA frame on this stream. If `fin` is true the stream half-
  /// closes on our side; the peer can still send data back unless it also
  /// sent FIN.
  func write(_ data: Data, fin: Bool = false) {
    connection?.sendData(streamId: id, data: data, fin: fin)
  }

  /// Abort the stream. SPDY/3 status codes: 5 = CANCEL (the "I'm done"
  /// case), 6 = INTERNAL_ERROR, etc. — see RstStreamStatus in moby/spdystream.
  func reset(status: UInt32 = 5) {
    if closed { return }
    closed = true
    connection?.sendRstStream(streamId: id, status: status)
  }
}

// MARK: - SpdyConnection

internal final class SpdyConnection {
  private let framer: SpdyFramer
  private let sendBytes: (Data) -> Void
  // Highest client stream id we've allocated so far. Client streams are
  // odd-numbered per SPDY/3 §2.3.2 — 1, 3, 5, …
  private var nextStreamId: UInt32 = 1
  private var streams: [UInt32: SpdyStream] = [:]
  // Tracks the highest server-initiated stream id we've seen — needed if
  // we ever send GOAWAY (so the peer knows which inbound streams we
  // acknowledged before tearing down). Server streams are even.
  private var lastSeenServerStreamId: UInt32 = 0

  /// Called when the peer sends GOAWAY. After GOAWAY no new streams may
  /// open; existing streams ≤ lastGoodStreamId continue.
  var onGoaway: (_ lastGoodStreamId: UInt32, _ status: UInt32) -> Void = { _, _ in }

  /// Called when the framer can't decode a frame. The bridge should treat
  /// this as a fatal error and close.
  var onProtocolError: (_ message: String) -> Void = { _ in }

  init(send: @escaping (Data) -> Void) throws {
    self.framer = try SpdyFramer()
    self.sendBytes = send
  }

  /// Feed raw bytes from the WebSocket. Each WS binary frame's payload
  /// goes here; the framer handles partial-frame and multi-frame cases.
  func feed(_ data: Data) {
    do {
      let frames = try framer.feed(data)
      for frame in frames { dispatch(frame) }
    } catch let err as SpdyError {
      switch err {
      case .malformed(let msg): onProtocolError("malformed SPDY frame: \(msg)")
      }
    } catch {
      onProtocolError("SPDY decode error: \(error.localizedDescription)")
    }
  }

  /// Open a new client-initiated stream with the given NV headers. Returns
  /// the SpdyStream so the caller can hook up data callbacks and write.
  func openStream(
    headers: [(String, String)],
    fin: Bool = false,
    unidirectional: Bool = false
  ) -> SpdyStream {
    let id = nextStreamId
    nextStreamId += 2
    let stream = SpdyStream(id: id, connection: self)
    stream.requestHeaders = headers
    streams[id] = stream
    let frame = framer.encodeSynStream(
      streamId: id, fin: fin, unidirectional: unidirectional, headers: headers
    )
    sendBytes(frame)
    return stream
  }

  // MARK: - Internal send helpers (called by SpdyStream)

  fileprivate func sendData(streamId: UInt32, data: Data, fin: Bool) {
    // SPDY/3 limits DATA payload to 2^24-1 bytes — fragment if a caller
    // ever pushes a single chunk larger than that.
    let maxLen = (1 << 24) - 1
    if data.count <= maxLen {
      sendBytes(framer.encodeData(streamId: streamId, payload: data, fin: fin))
      return
    }
    var offset = 0
    while offset < data.count {
      let end = min(offset + maxLen, data.count)
      let chunk = data.subdata(in: (data.startIndex + offset)..<(data.startIndex + end))
      let isLast = end == data.count
      sendBytes(framer.encodeData(streamId: streamId, payload: chunk, fin: fin && isLast))
      offset = end
    }
  }

  fileprivate func sendRstStream(streamId: UInt32, status: UInt32) {
    sendBytes(framer.encodeRstStream(streamId: streamId, status: status))
    streams.removeValue(forKey: streamId)
  }

  /// Send GOAWAY then forget all streams. Caller is responsible for closing
  /// the underlying WS after this.
  func sendGoaway(status: UInt32 = 0) {
    sendBytes(framer.encodeGoaway(lastGoodStreamId: lastSeenServerStreamId, status: status))
    for stream in streams.values { stream.closed = true }
    streams.removeAll()
  }

  // MARK: - Frame dispatch

  private func dispatch(_ frame: SpdyFrame) {
    switch frame {
    case .synReply(let id, _, let headers):
      guard let stream = streams[id] else { return }
      stream.replyHeaders = headers
      stream.onReply(headers)

    case .data(let id, let fin, let payload):
      guard let stream = streams[id] else { return }
      stream.onData(payload, fin)
      if fin {
        // Half-close from peer side. We keep the stream in the table because
        // our side may still want to write; SpdyStream.closed only flips on
        // RST_STREAM or our own reset().
      }

    case .rstStream(let id, let status):
      let stream = streams.removeValue(forKey: id)
      stream?.closed = true
      stream?.onClose(status)

    case .ping(let id):
      // Echo the id back — SPDY/3 says receivers reply with an identical
      // PING immediately. Client-sent pings use odd ids, server-sent use
      // even; we don't need to track which is which to reply correctly.
      sendBytes(framer.encodePing(id: id))

    case .goaway(let last, let status):
      onGoaway(last, status)

    case .headers(let id, _, _):
      // The portforward protocol doesn't use HEADERS frames for anything
      // we care about. Track the stream id but otherwise ignore.
      if id > lastSeenServerStreamId, id % 2 == 0 {
        lastSeenServerStreamId = id
      }

    case .windowUpdate, .settings:
      // K8s portforward never sends meaningful flow-control updates over
      // the tunnelled link; ignore.
      break
    }
  }
}
