import Foundation

// SPDY/3 frame codec — encode + decode + zlib-compressed NV header blocks.
//
// We implement the strict subset of SPDY/3 needed for the port-forward
// tunnel (K8s "SPDY/3.1+portforward.k8s.io" subprotocol over WebSocket):
//
//   Send:    SYN_STREAM, DATA, RST_STREAM, PING (reply), GOAWAY
//   Receive: SYN_REPLY, DATA, RST_STREAM, PING, GOAWAY, plus we tolerate
//            SETTINGS / WINDOW_UPDATE / HEADERS by parsing past them
//            without acting (apiserver / kubelet never use them for
//            portforward but the framer must skip cleanly).
//
// Reference: SPDY/3 spec (chromium.org/spdy/spdy-protocol/spdy-protocol-draft3-1)
// and moby/spdystream which is what K8s uses on the server side.

// MARK: - Frame model

internal enum SpdyControlType: UInt16 {
  case synStream = 1
  case synReply = 2
  case rstStream = 3
  case settings = 4
  case ping = 6
  case goaway = 7
  case headers = 8
  case windowUpdate = 9
}

internal enum SpdyFrame {
  case synReply(streamId: UInt32, fin: Bool, headers: [(String, String)])
  case rstStream(streamId: UInt32, status: UInt32)
  case settings  // payload ignored
  case ping(id: UInt32)
  case goaway(lastGoodStreamId: UInt32, status: UInt32)
  case headers(streamId: UInt32, fin: Bool, headers: [(String, String)])
  case windowUpdate(streamId: UInt32, delta: UInt32)
  case data(streamId: UInt32, fin: Bool, payload: Data)
}

internal enum SpdyError: Error {
  case malformed(String)
}

// MARK: - Framer

internal final class SpdyFramer {
  private let compressor: ZlibCompressor
  private let decompressor: ZlibDecompressor
  private var rxBuffer = Data()
  // Tracks whether we've already sent the FIN flag on a stream so callers
  // don't send DATA after FIN by accident (debug aid; the framer doesn't
  // enforce state machine validity itself).

  init() throws {
    self.compressor = try ZlibCompressor(dictionary: SPDY3_DICTIONARY)
    self.decompressor = try ZlibDecompressor(dictionary: SPDY3_DICTIONARY)
  }

  // MARK: Decode

  /// Append bytes from the wire and return any complete frames now parseable.
  /// Partial frames remain buffered for the next call.
  func feed(_ data: Data) throws -> [SpdyFrame] {
    rxBuffer.append(data)
    var out: [SpdyFrame] = []
    while true {
      // Need at least the 8-byte common header to know how much follows.
      if rxBuffer.count < 8 { return out }
      let h0 = rxBuffer[rxBuffer.startIndex]
      let isControl = (h0 & 0x80) != 0
      // Bytes 5-7 are the 24-bit length.
      let payloadLen = (Int(rxBuffer[rxBuffer.startIndex + 5]) << 16)
                    | (Int(rxBuffer[rxBuffer.startIndex + 6]) << 8)
                    |  Int(rxBuffer[rxBuffer.startIndex + 7])
      let frameLen = 8 + payloadLen
      if rxBuffer.count < frameLen { return out }
      let frameBytes = rxBuffer.subdata(in: rxBuffer.startIndex..<(rxBuffer.startIndex + frameLen))
      rxBuffer.removeFirst(frameLen)

      let flags = frameBytes[5 + frameBytes.startIndex]
      let payload = frameBytes.subdata(in: (frameBytes.startIndex + 8)..<(frameBytes.startIndex + frameLen))

      if isControl {
        let type = UInt16(frameBytes[frameBytes.startIndex + 2]) << 8 | UInt16(frameBytes[frameBytes.startIndex + 3])
        guard let ctrlType = SpdyControlType(rawValue: type) else {
          // Unknown control frame type — skip and continue per SPDY/3 spec.
          continue
        }
        if let frame = try decodeControl(type: ctrlType, flags: flags, payload: payload) {
          out.append(frame)
        }
      } else {
        // Data frame: stream id is in bytes 0-3 (high bit is zero for data).
        let streamId = readUInt32(frameBytes, offset: 0) & 0x7FFF_FFFF
        let fin = (flags & 0x01) != 0
        out.append(.data(streamId: streamId, fin: fin, payload: payload))
      }
    }
  }

  private func decodeControl(
    type: SpdyControlType,
    flags: UInt8,
    payload: Data
  ) throws -> SpdyFrame? {
    switch type {
    case .synReply:
      // Layout: 4 bytes streamId, then zlib-compressed NV block.
      guard payload.count >= 4 else { throw SpdyError.malformed("synReply <4 bytes") }
      let streamId = readUInt32(payload, offset: 0) & 0x7FFF_FFFF
      let nvCompressed = payload.subdata(in: (payload.startIndex + 4)..<payload.endIndex)
      let headers = try decompressAndParseNV(nvCompressed)
      return .synReply(streamId: streamId, fin: (flags & 0x01) != 0, headers: headers)

    case .rstStream:
      guard payload.count == 8 else { throw SpdyError.malformed("rstStream != 8 bytes") }
      let streamId = readUInt32(payload, offset: 0) & 0x7FFF_FFFF
      let status = readUInt32(payload, offset: 4)
      return .rstStream(streamId: streamId, status: status)

    case .ping:
      guard payload.count == 4 else { throw SpdyError.malformed("ping != 4 bytes") }
      let id = readUInt32(payload, offset: 0)
      return .ping(id: id)

    case .goaway:
      guard payload.count == 8 else { throw SpdyError.malformed("goaway != 8 bytes") }
      let last = readUInt32(payload, offset: 0) & 0x7FFF_FFFF
      let status = readUInt32(payload, offset: 4)
      return .goaway(lastGoodStreamId: last, status: status)

    case .headers:
      guard payload.count >= 4 else { throw SpdyError.malformed("headers <4 bytes") }
      let streamId = readUInt32(payload, offset: 0) & 0x7FFF_FFFF
      let nvCompressed = payload.subdata(in: (payload.startIndex + 4)..<payload.endIndex)
      let headers = try decompressAndParseNV(nvCompressed)
      return .headers(streamId: streamId, fin: (flags & 0x01) != 0, headers: headers)

    case .windowUpdate:
      guard payload.count == 8 else { throw SpdyError.malformed("windowUpdate != 8 bytes") }
      let streamId = readUInt32(payload, offset: 0) & 0x7FFF_FFFF
      let delta = readUInt32(payload, offset: 4) & 0x7FFF_FFFF
      return .windowUpdate(streamId: streamId, delta: delta)

    case .settings:
      // K8s doesn't use SETTINGS for portforward — surface as a tagged frame so
      // higher layers can log if they want, but no fields parsed.
      return .settings

    case .synStream:
      // Server sends SYN_STREAM in some protocols (push promises etc.), but
      // not for portforward. If one arrives we don't need to act on it.
      return nil
    }
  }

  private func decompressAndParseNV(_ compressed: Data) throws -> [(String, String)] {
    if compressed.isEmpty { return [] }
    let raw = try decompressor.decompress(compressed)
    return try parseNVBlock(raw)
  }

  private func parseNVBlock(_ raw: Data) throws -> [(String, String)] {
    if raw.count < 4 { return [] }
    let count = Int(readUInt32(raw, offset: 0))
    var pos = 4
    var out: [(String, String)] = []
    out.reserveCapacity(count)
    for _ in 0..<count {
      guard raw.count >= pos + 4 else { throw SpdyError.malformed("NV: short name length") }
      let nameLen = Int(readUInt32(raw, offset: pos))
      pos += 4
      guard raw.count >= pos + nameLen else { throw SpdyError.malformed("NV: short name") }
      let name = String(data: raw.subdata(in: (raw.startIndex + pos)..<(raw.startIndex + pos + nameLen)), encoding: .utf8) ?? ""
      pos += nameLen
      guard raw.count >= pos + 4 else { throw SpdyError.malformed("NV: short value length") }
      let valueLen = Int(readUInt32(raw, offset: pos))
      pos += 4
      guard raw.count >= pos + valueLen else { throw SpdyError.malformed("NV: short value") }
      let value = String(data: raw.subdata(in: (raw.startIndex + pos)..<(raw.startIndex + pos + valueLen)), encoding: .utf8) ?? ""
      pos += valueLen
      out.append((name, value))
    }
    return out
  }

  // MARK: Encode

  func encodeSynStream(
    streamId: UInt32,
    associatedTo: UInt32 = 0,
    priority: UInt8 = 0,
    slot: UInt8 = 0,
    fin: Bool = false,
    unidirectional: Bool = false,
    headers: [(String, String)]
  ) -> Data {
    let nv = encodeNVBlock(headers)
    let nvCompressed = compressor.compress(nv)
    // Payload: 4 + 4 + 1 + 1 + len(NV)
    var payload = Data()
    payload.append(uint32BE(streamId & 0x7FFF_FFFF))
    payload.append(uint32BE(associatedTo & 0x7FFF_FFFF))
    payload.append(priority << 5)
    payload.append(slot)
    payload.append(nvCompressed)
    var flags: UInt8 = 0
    if fin { flags |= 0x01 }
    if unidirectional { flags |= 0x02 }
    return controlFrame(type: .synStream, flags: flags, payload: payload)
  }

  func encodeData(streamId: UInt32, payload: Data, fin: Bool = false) -> Data {
    var frame = Data()
    frame.append(uint32BE(streamId & 0x7FFF_FFFF)) // C=0, stream id
    let flagsAndLen: UInt32 = (fin ? 0x01000000 : 0) | UInt32(payload.count & 0x00FF_FFFF)
    frame.append(uint32BE(flagsAndLen))
    frame.append(payload)
    return frame
  }

  func encodeRstStream(streamId: UInt32, status: UInt32) -> Data {
    var payload = Data()
    payload.append(uint32BE(streamId & 0x7FFF_FFFF))
    payload.append(uint32BE(status))
    return controlFrame(type: .rstStream, flags: 0, payload: payload)
  }

  func encodePing(id: UInt32) -> Data {
    var payload = Data()
    payload.append(uint32BE(id))
    return controlFrame(type: .ping, flags: 0, payload: payload)
  }

  func encodeGoaway(lastGoodStreamId: UInt32, status: UInt32 = 0) -> Data {
    var payload = Data()
    payload.append(uint32BE(lastGoodStreamId & 0x7FFF_FFFF))
    payload.append(uint32BE(status))
    return controlFrame(type: .goaway, flags: 0, payload: payload)
  }

  private func controlFrame(type: SpdyControlType, flags: UInt8, payload: Data) -> Data {
    var frame = Data()
    // C bit + version 3 → 0x8003 big-endian
    frame.append(0x80)
    frame.append(0x03)
    frame.append(uint16BE(type.rawValue))
    frame.append(flags)
    // 24-bit length, big-endian
    let len = payload.count
    frame.append(UInt8((len >> 16) & 0xFF))
    frame.append(UInt8((len >> 8) & 0xFF))
    frame.append(UInt8(len & 0xFF))
    frame.append(payload)
    return frame
  }

  private func encodeNVBlock(_ headers: [(String, String)]) -> Data {
    var data = Data()
    data.append(uint32BE(UInt32(headers.count)))
    for (name, value) in headers {
      let nameLower = name.lowercased()
      let nameBytes = Array(nameLower.utf8)
      let valueBytes = Array(value.utf8)
      data.append(uint32BE(UInt32(nameBytes.count)))
      data.append(contentsOf: nameBytes)
      data.append(uint32BE(UInt32(valueBytes.count)))
      data.append(contentsOf: valueBytes)
    }
    return data
  }
}

// MARK: - Big-endian helpers

@inline(__always)
private func readUInt16(_ data: Data, offset: Int) -> UInt16 {
  let i = data.startIndex + offset
  return UInt16(data[i]) << 8 | UInt16(data[i + 1])
}

@inline(__always)
private func readUInt32(_ data: Data, offset: Int) -> UInt32 {
  let i = data.startIndex + offset
  return UInt32(data[i]) << 24
       | UInt32(data[i + 1]) << 16
       | UInt32(data[i + 2]) << 8
       | UInt32(data[i + 3])
}

@inline(__always)
private func uint16BE(_ v: UInt16) -> Data {
  return Data([UInt8(v >> 8), UInt8(v & 0xFF)])
}

@inline(__always)
private func uint32BE(_ v: UInt32) -> Data {
  return Data([
    UInt8((v >> 24) & 0xFF),
    UInt8((v >> 16) & 0xFF),
    UInt8((v >> 8) & 0xFF),
    UInt8(v & 0xFF),
  ])
}
