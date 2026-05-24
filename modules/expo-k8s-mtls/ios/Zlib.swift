import Foundation

// Direct bindings to Apple's libz (/usr/lib/libz.dylib). We use the C zlib
// API rather than the Compression framework because we need preset-
// dictionary support for SPDY/3 NV header compression — Compression's ZLIB
// is raw deflate without that knob, and Apple doesn't expose zlib.h as a
// Swift module on iOS.
//
// The Podspec links libz with `s.library = 'z'`. We then map the C
// functions and z_stream struct into Swift here.

// MARK: - z_stream

// Mirror of the C `z_stream` struct from zlib.h. Field sizes match a 64-bit
// LP64 layout (iOS arm64 / x86_64); we don't support 32-bit targets.
//
// We never inspect any of these fields except `next_in`, `avail_in`,
// `next_out`, `avail_out`, `total_out`, and `msg` — the rest are internal.
// Default-initialised so a plain `z_stream()` call zero-fills the struct,
// matching the standard zlib idiom of memset(0) before deflateInit_ /
// inflateInit_. deflateInit_ requires zalloc/zfree/opaque to be NULL (zlib
// then uses its built-in allocator) and the buffers to be set per-call.
internal struct z_stream {
  var next_in: UnsafePointer<UInt8>? = nil      // 8
  var avail_in: UInt32 = 0                      // 4 (+ 4 pad)
  var total_in: UInt = 0                        // 8

  var next_out: UnsafeMutablePointer<UInt8>? = nil // 8
  var avail_out: UInt32 = 0                     // 4 (+ 4 pad)
  var total_out: UInt = 0                       // 8

  var msg: UnsafePointer<CChar>? = nil          // 8
  var state: OpaquePointer? = nil               // 8
  var zalloc: OpaquePointer? = nil              // 8
  var zfree: OpaquePointer? = nil               // 8
  var opaque: OpaquePointer? = nil              // 8
  var data_type: Int32 = 0                      // 4 (+ 4 pad)
  var adler: UInt = 0                           // 8
  var reserved: UInt = 0                        // 8
}

// MARK: - libz function bindings

// zlib's deflateInit / inflateInit are macros in C that bake in the runtime
// version string and the sizeof(z_stream); the underlying symbols are the
// trailing-underscore variants which we call directly.

@_silgen_name("deflateInit_")
internal func z_deflateInit_(
  _ strm: UnsafeMutablePointer<z_stream>,
  _ level: Int32,
  _ version: UnsafePointer<CChar>,
  _ stream_size: Int32
) -> Int32

@_silgen_name("deflateSetDictionary")
internal func z_deflateSetDictionary(
  _ strm: UnsafeMutablePointer<z_stream>,
  _ dictionary: UnsafePointer<UInt8>,
  _ dictLength: UInt32
) -> Int32

@_silgen_name("deflate")
internal func z_deflate(
  _ strm: UnsafeMutablePointer<z_stream>,
  _ flush: Int32
) -> Int32

@_silgen_name("deflateEnd")
internal func z_deflateEnd(_ strm: UnsafeMutablePointer<z_stream>) -> Int32

@_silgen_name("inflateInit_")
internal func z_inflateInit_(
  _ strm: UnsafeMutablePointer<z_stream>,
  _ version: UnsafePointer<CChar>,
  _ stream_size: Int32
) -> Int32

@_silgen_name("inflateSetDictionary")
internal func z_inflateSetDictionary(
  _ strm: UnsafeMutablePointer<z_stream>,
  _ dictionary: UnsafePointer<UInt8>,
  _ dictLength: UInt32
) -> Int32

@_silgen_name("inflate")
internal func z_inflate(
  _ strm: UnsafeMutablePointer<z_stream>,
  _ flush: Int32
) -> Int32

@_silgen_name("inflateEnd")
internal func z_inflateEnd(_ strm: UnsafeMutablePointer<z_stream>) -> Int32

@_silgen_name("zlibVersion")
internal func z_zlibVersion() -> UnsafePointer<CChar>

// MARK: - zlib constants

internal let Z_OK: Int32 = 0
internal let Z_STREAM_END: Int32 = 1
internal let Z_NEED_DICT: Int32 = 2
internal let Z_BUF_ERROR: Int32 = -5

internal let Z_NO_FLUSH: Int32 = 0
internal let Z_PARTIAL_FLUSH: Int32 = 1
internal let Z_SYNC_FLUSH: Int32 = 2
internal let Z_FULL_FLUSH: Int32 = 3
internal let Z_FINISH: Int32 = 4

internal let Z_DEFAULT_COMPRESSION: Int32 = -1

// MARK: - Stateful compressor / decompressor wrappers

/// Persistent zlib deflate stream that compresses successive blocks against
/// a preset dictionary, returning each block flushed with Z_SYNC_FLUSH so
/// the peer can decompress it independently while the underlying dictionary
/// state continues to evolve across calls.
internal final class ZlibCompressor {
  private var stream = z_stream()
  private var initialized = false

  init(dictionary: [UInt8]) throws {
    let initRet = z_deflateInit_(
      &stream,
      Z_DEFAULT_COMPRESSION,
      z_zlibVersion(),
      Int32(MemoryLayout<z_stream>.size)
    )
    guard initRet == Z_OK else {
      throw NSError(
        domain: "Zlib", code: Int(initRet),
        userInfo: [NSLocalizedDescriptionKey: "deflateInit failed (\(initRet))"]
      )
    }
    initialized = true
    let dictRet = dictionary.withUnsafeBufferPointer { buf in
      z_deflateSetDictionary(&stream, buf.baseAddress!, UInt32(buf.count))
    }
    guard dictRet == Z_OK else {
      throw NSError(
        domain: "Zlib", code: Int(dictRet),
        userInfo: [NSLocalizedDescriptionKey: "deflateSetDictionary failed (\(dictRet))"]
      )
    }
  }

  deinit {
    if initialized {
      _ = z_deflateEnd(&stream)
    }
  }

  /// Compress `input` and flush so the output is independently decompressible
  /// by the peer (while the deflate state remains active for the next call).
  /// Returns the produced bytes.
  func compress(_ input: Data) -> Data {
    var out = Data()
    input.withUnsafeBytes { (rawIn: UnsafeRawBufferPointer) in
      let inPtr = rawIn.bindMemory(to: UInt8.self).baseAddress!
      stream.next_in = inPtr
      stream.avail_in = UInt32(input.count)

      var buffer = [UInt8](repeating: 0, count: 4096)
      repeat {
        buffer.withUnsafeMutableBufferPointer { outBuf in
          stream.next_out = outBuf.baseAddress!
          stream.avail_out = UInt32(outBuf.count)
          _ = z_deflate(&stream, Z_SYNC_FLUSH)
          let produced = outBuf.count - Int(stream.avail_out)
          if produced > 0 {
            out.append(outBuf.baseAddress!, count: produced)
          }
        }
        // Loop until deflate has consumed all input AND its internal buffer
        // is empty (avail_out > 0 means it had room and produced everything
        // it could for this Z_SYNC_FLUSH).
      } while stream.avail_in > 0 || stream.avail_out == 0
    }
    return out
  }
}

/// Persistent zlib inflate stream. The peer's NV blocks are compressed
/// with the SPDY dictionary; when zlib reports Z_NEED_DICT we install it
/// and continue. Subsequent blocks reuse the same dictionary state.
internal final class ZlibDecompressor {
  private var stream = z_stream()
  private let dictionary: [UInt8]
  private var initialized = false

  init(dictionary: [UInt8]) throws {
    self.dictionary = dictionary
    let initRet = z_inflateInit_(
      &stream,
      z_zlibVersion(),
      Int32(MemoryLayout<z_stream>.size)
    )
    guard initRet == Z_OK else {
      throw NSError(
        domain: "Zlib", code: Int(initRet),
        userInfo: [NSLocalizedDescriptionKey: "inflateInit failed (\(initRet))"]
      )
    }
    initialized = true
  }

  deinit {
    if initialized {
      _ = z_inflateEnd(&stream)
    }
  }

  func decompress(_ input: Data) throws -> Data {
    var out = Data()
    try input.withUnsafeBytes { (rawIn: UnsafeRawBufferPointer) in
      let inPtr = rawIn.bindMemory(to: UInt8.self).baseAddress!
      stream.next_in = inPtr
      stream.avail_in = UInt32(input.count)

      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.avail_in > 0 {
        var ret: Int32 = Z_OK
        buffer.withUnsafeMutableBufferPointer { outBuf in
          stream.next_out = outBuf.baseAddress!
          stream.avail_out = UInt32(outBuf.count)
          ret = z_inflate(&stream, Z_SYNC_FLUSH)
          let produced = outBuf.count - Int(stream.avail_out)
          if produced > 0 {
            out.append(outBuf.baseAddress!, count: produced)
          }
        }
        if ret == Z_NEED_DICT {
          // Standard SPDY/3 flow — first inflate call after init reports
          // that we need the dictionary, we install it, then continue.
          let setRet = dictionary.withUnsafeBufferPointer { buf in
            z_inflateSetDictionary(&stream, buf.baseAddress!, UInt32(buf.count))
          }
          if setRet != Z_OK {
            throw NSError(
              domain: "Zlib", code: Int(setRet),
              userInfo: [NSLocalizedDescriptionKey: "inflateSetDictionary failed (\(setRet))"]
            )
          }
          continue
        }
        if ret == Z_BUF_ERROR {
          // No progress and no input left to consume — flush is complete.
          if stream.avail_in == 0 { break }
          // Otherwise we genuinely couldn't make progress — bail.
          throw NSError(
            domain: "Zlib", code: Int(ret),
            userInfo: [NSLocalizedDescriptionKey: "inflate buf error with input remaining"]
          )
        }
        if ret != Z_OK && ret != Z_STREAM_END {
          let msg = stream.msg.map { String(cString: $0) } ?? "inflate failed"
          throw NSError(
            domain: "Zlib", code: Int(ret),
            userInfo: [NSLocalizedDescriptionKey: "\(msg) (\(ret))"]
          )
        }
      }
    }
    return out
  }
}
