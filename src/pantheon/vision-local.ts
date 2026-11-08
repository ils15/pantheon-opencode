/**
 * Deterministic, dependency-free local image extraction (Fase 4).
 *
 * This module is the LAST rung of the vision fallback chain:
 * `native (provider-direct) → MCP tool → local (> none)`.
 *
 * It parses image bytes with the Node standard library only (`node:zlib` for
 * PNG scanline inflate, `node:child_process` for the opt-in tesseract probe) —
 * no network, no API key, no new dependency. The contract is deliberately
 * conservative:
 *
 *  - It reports only what the bytes actually contain: dimensions, format, file
 *    size, and (for non-interlaced 8-bit RGB/RGBA PNG) a quantized palette of
 *    dominant colors. Anything it cannot decode is reported as unavailable.
 *  - OCR runs ONLY when a `tesseract` binary is present on PATH; otherwise the
 *    block states OCR is unavailable. A missing binary is never an error.
 *  - It NEVER hallucinates content: no synthesized description is ever
 *    produced. Every export is total — malformed/truncated/unsupported input
 *    degrades to `null` or a metadata-only block, and never throws.
 *
 * Degradation matrix (documented, intentional):
 *  - PNG non-interlaced, bitDepth 8, colorType 2 (RGB) or 6 (RGBA): dims + colors.
 *  - PNG interlaced / other bit depths / paletted / grayscale: dims only (no colors).
 *  - JPEG: dims via SOF markers only (no colors — pixel decode is out of scope).
 *  - GIF / WebP: dims only via header fields (best effort).
 *  - Unknown signature: size only, format "unknown".
 *  - Remote http(s) URL: declared MIME from the path only (bytes are not fetched).
 */

import { spawnSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'

// ─── Types ─────────────────────────────────────────────────────────────────

export type LocalImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'unknown'

export type LocalDominantColor = { hex: string; ratio: number }

export type LocalImageInfo = {
  format: LocalImageFormat
  mime: string
  width: number | null
  height: number | null
  /** Raw byte length, or null when the bytes are not locally available. */
  bytes: number | null
  /** Quantized dominant colors, or null when not computed for this format. */
  colors: LocalDominantColor[] | null
  /** Best-effort OCR text, or null when no OCR runner produced text. */
  ocrText: string | null
}

/**
 * OCR runner. `undefined` uses the default tesseract runner (which no-ops when
 * the binary is absent); `null` disables OCR entirely.
 */
export type LocalOcrRunner = (bytes: Uint8Array, mime: string) => Promise<string | null>

export type LocalVisionOptions = {
  ocr?: LocalOcrRunner | null
  maxColors?: number
}

// ─── Constants ─────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const DEFAULT_MAX_COLORS = 5
/** Bound the number of sampled pixels so a huge image cannot stall the turn. */
const MAX_SAMPLED_PIXELS = 2_000_000
const TESSERACT_PROBE_TIMEOUT_MS = 3_000
const TESSERACT_OCR_TIMEOUT_MS = 20_000
const TESSERACT_MAX_OUTPUT_BYTES = 1_000_000

const FORMAT_LABELS: Record<LocalImageFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  unknown: 'formato desconhecido',
}

const MIME_BY_FORMAT: Record<LocalImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  unknown: 'application/octet-stream',
}

// ─── Byte helpers ──────────────────────────────────────────────────────────

function asBuffer(input: Uint8Array): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input)
}

function startsWithAscii(buf: Buffer, text: string): boolean {
  if (buf.length < text.length) return false
  for (let i = 0; i < text.length; i += 1) {
    if (buf[i] !== text.charCodeAt(i)) return false
  }
  return true
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0')
}

/** Identify a supported format from its magic signature. Never throws. */
export function detectImageFormat(input: Uint8Array): LocalImageFormat {
  const buf = asBuffer(input)
  if (
    buf.length >= PNG_SIGNATURE.length &&
    startsWithAscii(buf, PNG_SIGNATURE.toString('latin1'))
  ) {
    return 'png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (startsWithAscii(buf, 'GIF87a') || startsWithAscii(buf, 'GIF89a')) return 'gif'
  if (buf.length >= 12 && startsWithAscii(buf, 'RIFF') && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp'
  }
  return 'unknown'
}

// ─── PNG header + dominant colors ──────────────────────────────────────────

type PngHeader = {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
}

/** Parse the IHDR chunk. Returns null for a truncated or non-PNG buffer. */
function parsePngHeader(buf: Buffer): PngHeader | null {
  if (buf.length < 33) return null
  if (!startsWithAscii(buf, PNG_SIGNATURE.toString('latin1'))) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return {
    width,
    height,
    bitDepth: buf[24] ?? 0,
    colorType: buf[25] ?? 0,
    interlace: buf[28] ?? 0,
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Reverse one PNG scanline filter (types 0-4) in place. */
function unfilterRow(filter: number, row: Buffer, previous: Buffer, channels: number): void {
  const length = row.length
  switch (filter) {
    case 1:
      for (let i = channels; i < length; i += 1) {
        row[i] = ((row[i] ?? 0) + (row[i - channels] ?? 0)) & 0xff
      }
      return
    case 2:
      for (let i = 0; i < length; i += 1) {
        row[i] = ((row[i] ?? 0) + (previous[i] ?? 0)) & 0xff
      }
      return
    case 3:
      for (let i = 0; i < length; i += 1) {
        const left = i >= channels ? (row[i - channels] ?? 0) : 0
        row[i] = ((row[i] ?? 0) + ((left + (previous[i] ?? 0)) >> 1)) & 0xff
      }
      return
    case 4:
      for (let i = 0; i < length; i += 1) {
        const left = i >= channels ? (row[i - channels] ?? 0) : 0
        const up = previous[i] ?? 0
        const upLeft = i >= channels ? (previous[i - channels] ?? 0) : 0
        row[i] = ((row[i] ?? 0) + paeth(left, up, upLeft)) & 0xff
      }
      return
    default:
      // Filter 0 (None) and any unknown filter leave the row untouched.
      return
  }
}

function bucketToHex(key: number): string {
  const r = ((key >> 8) & 0xf) * 17
  const g = ((key >> 4) & 0xf) * 17
  const b = (key & 0xf) * 17
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

/**
 * Quantize a non-interlaced 8-bit RGB/RGBA PNG into its top-N dominant colors.
 * Returns null when the encoding is unsupported, the IDAT cannot be inflated,
 * or the scanlines are malformed — callers then simply omit colors.
 */
function extractPngColors(
  buf: Buffer,
  header: PngHeader,
  maxColors: number,
): LocalDominantColor[] | null {
  if (header.interlace !== 0 || header.bitDepth !== 8) return null
  const channels = header.colorType === 2 ? 3 : header.colorType === 6 ? 4 : 0
  if (channels === 0) return null
  const { width, height } = header

  const idatChunks: Buffer[] = []
  let offset = 8
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (length < 0 || dataEnd + 4 > buf.length) break
    if (type === 'IDAT') idatChunks.push(buf.subarray(dataStart, dataEnd))
    if (type === 'IEND') break
    offset = dataEnd + 4
  }
  if (idatChunks.length === 0) return null

  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idatChunks))
  } catch {
    return null
  }

  const stride = width * channels
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  const buckets = new Map<number, number>()
  const totalPixels = width * height
  const step = totalPixels > MAX_SAMPLED_PIXELS ? Math.ceil(totalPixels / MAX_SAMPLED_PIXELS) : 1
  let pos = 0
  let total = 0

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos] ?? 0
    pos += 1
    if (pos + stride > raw.length) return null
    raw.copy(current, 0, pos, pos + stride)
    pos += stride
    unfilterRow(filter, current, previous, channels)

    for (let x = 0; x < width; x += 1) {
      if ((y * width + x) % step !== 0) continue
      const base = x * channels
      const r = current[base] ?? 0
      const g = current[base + 1] ?? 0
      const b = current[base + 2] ?? 0
      if (channels === 4 && (current[base + 3] ?? 0) === 0) continue
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
      total += 1
    }
    current.copy(previous)
  }

  if (total === 0) return []
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, maxColors)
    .map(([key, count]) => ({ hex: bucketToHex(key), ratio: count / total }))
}

function safePngColors(
  buf: Buffer,
  header: PngHeader,
  maxColors: number,
): LocalDominantColor[] | null {
  try {
    return extractPngColors(buf, header, maxColors)
  } catch {
    return null
  }
}

// ─── JPEG / GIF / WebP dimensions ──────────────────────────────────────────

/** Read JPEG dimensions from the first start-of-frame marker. Never throws. */
function parseJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  const sofMarkers = new Set<number>()
  for (let marker = 0xc0; marker <= 0xcf; marker += 1) {
    if (marker === 0xc4 || marker === 0xc8 || marker === 0xcc) continue
    sofMarkers.add(marker)
  }
  let index = 2
  while (index + 9 < buf.length) {
    if (buf[index] !== 0xff) {
      index += 1
      continue
    }
    while (index < buf.length && buf[index] === 0xff) index += 1
    if (index >= buf.length) break
    const marker = buf[index] ?? 0
    index += 1
    if (marker === 0xd8 || marker === 0xd9) continue
    if (index + 2 > buf.length) break
    const segmentLength = buf.readUInt16BE(index)
    if (segmentLength < 2 || index + segmentLength > buf.length) break
    if (sofMarkers.has(marker) && segmentLength >= 7) {
      return { height: buf.readUInt16BE(index + 3), width: buf.readUInt16BE(index + 5) }
    }
    index += segmentLength
  }
  return null
}

function readDimensions(
  buf: Buffer,
  format: LocalImageFormat,
): { width: number; height: number } | null {
  if (format === 'png') {
    const header = parsePngHeader(buf)
    return header ? { width: header.width, height: header.height } : null
  }
  if (format === 'jpeg') return parseJpegDimensions(buf)
  if (format === 'gif' && buf.length >= 10) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  if (format === 'webp' && buf.length >= 30 && buf.toString('ascii', 12, 16) === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  return null
}

// ─── OCR (opt-in, tesseract only when present) ─────────────────────────────

let tesseractProbe: boolean | null = null

/**
 * True when a `tesseract` binary answers `--version` on PATH. The probe result
 * is cached for the process; a missing binary is a normal (false) outcome.
 */
export function tesseractAvailable(): boolean {
  if (tesseractProbe !== null) return tesseractProbe
  try {
    const result = spawnSync('tesseract', ['--version'], {
      timeout: TESSERACT_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
    })
    tesseractProbe = result.status === 0
  } catch {
    tesseractProbe = false
  }
  return tesseractProbe
}

/**
 * Best-effort OCR through the tesseract CLI (stdin → stdout). Returns null when
 * the binary is absent, the run fails, times out, or yields only whitespace.
 * Never throws.
 */
export async function runTesseractOcr(bytes: Uint8Array, _mime: string): Promise<string | null> {
  if (!tesseractAvailable()) return null
  try {
    const result = spawnSync('tesseract', ['stdin', 'stdout'], {
      input: Buffer.from(bytes),
      maxBuffer: TESSERACT_MAX_OUTPUT_BYTES,
      timeout: TESSERACT_OCR_TIMEOUT_MS,
      encoding: 'utf8',
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') return null
    const text = result.stdout.trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

async function resolveOcr(
  bytes: Buffer,
  mime: string,
  opts: LocalVisionOptions,
): Promise<string | null> {
  if (opts.ocr === null) return null
  const runner = opts.ocr ?? runTesseractOcr
  try {
    const text = await runner(bytes, mime)
    return text && text.trim().length > 0 ? text.trim() : null
  } catch {
    return null
  }
}

// ─── Extraction ────────────────────────────────────────────────────────────

function parseDataUri(source: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]*);base64,([\s\S]+)$/.exec(source)
  if (!match) return null
  try {
    return { mime: (match[1] ?? '').toLowerCase(), bytes: Buffer.from(match[2] ?? '', 'base64') }
  } catch {
    return null
  }
}

function formatFromMime(mime: string | null): LocalImageFormat {
  if (!mime) return 'unknown'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/webp') return 'webp'
  return 'unknown'
}

function mimeFromUrl(source: string): string | null {
  // Linear by construction: no regex backtracking over attacker-controlled
  // strings (CodeQL js/polynomial-redos) — split on the first ? or #, then
  // take the last dot of the remaining path.
  const fragmentIndex = Math.min(
    ...['?', '#'].map((ch) => source.indexOf(ch)).filter((index) => index >= 0),
    source.length,
  )
  const path = source.slice(0, fragmentIndex)
  const dotIndex = path.lastIndexOf('.')
  if (dotIndex < 0) return null
  const extension = path.slice(dotIndex + 1).toLowerCase()
  if (!/^[a-z0-9]+$/.test(extension)) return null
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'webp') return 'image/webp'
  return null
}

/**
 * Extract deterministic metadata (and best-effort colors/OCR) from one source.
 * Accepts a `data:` URI, a remote http(s) URL, or any other string treated as
 * a local path. Returns null only when the source is unusable; never throws.
 */
export async function extractImageInfo(
  source: string,
  opts: LocalVisionOptions = {},
): Promise<LocalImageInfo | null> {
  const maxColors = opts.maxColors ?? DEFAULT_MAX_COLORS
  try {
    const dataUri = parseDataUri(source)
    if (dataUri) {
      const bytes = dataUri.bytes
      const format = detectImageFormat(bytes)
      const mime = dataUri.mime || MIME_BY_FORMAT[format]
      const dimensions = readDimensions(bytes, format)
      const header = format === 'png' ? parsePngHeader(bytes) : null
      return {
        format,
        mime,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        bytes: bytes.length,
        colors: header ? safePngColors(bytes, header, maxColors) : null,
        ocrText: await resolveOcr(bytes, mime, opts),
      }
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
      const mime = mimeFromUrl(source)
      return {
        format: formatFromMime(mime),
        mime: mime ?? 'application/octet-stream',
        width: null,
        height: null,
        bytes: null,
        colors: null,
        ocrText: null,
      }
    }

    return null
  } catch {
    return null
  }
}

// ─── Formatting ────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** Render one extraction as a short, structured block for prompt injection. */
export function formatLocalImageBlock(info: LocalImageInfo, index?: number): string {
  const prefix = index !== undefined && index > 0 ? `Imagem local ${index}` : 'Imagem local'
  const dimensions =
    info.width !== null && info.height !== null
      ? `${info.width}x${info.height}`
      : 'dimensões desconhecidas'
  const size = info.bytes !== null ? formatBytes(info.bytes) : 'tamanho desconhecido'
  const lines = [`${prefix}: ${dimensions} ${FORMAT_LABELS[info.format]}, ${size}.`]
  if (info.colors && info.colors.length > 0) {
    const palette = info.colors
      .map((color) => `${color.hex} (${Math.round(color.ratio * 100)}%)`)
      .join(', ')
    lines.push(`Cores dominantes: ${palette}`)
  } else {
    lines.push('Cores dominantes: indisponível para este formato/codificação.')
  }
  if (info.ocrText) {
    lines.push(`Texto OCR: ${info.ocrText.replace(/\s+/g, ' ').trim()}`)
  } else {
    lines.push('Texto OCR: indisponível (tesseract não instalado).')
  }
  return lines.join('\n')
}

/**
 * Build the local extraction block for one or more image sources (data URIs or
 * remote URLs produced by `resolveImageSourcePayload`). Returns null when no
 * source yields any info, so callers can fall back to an explicit unavailable
 * message instead of injecting an empty block.
 */
export async function buildLocalVisionBlock(
  sources: readonly string[],
  opts: LocalVisionOptions = {},
): Promise<string | null> {
  if (sources.length === 0) return null
  const blocks: string[] = []
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i]
    if (source === undefined) continue
    const info = await extractImageInfo(source, opts)
    if (!info) continue
    blocks.push(formatLocalImageBlock(info, sources.length > 1 ? i + 1 : undefined))
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null
}
